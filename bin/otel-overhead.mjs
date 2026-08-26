#!/usr/bin/env node
/**
 * What OpenTelemetry costs this application, measured rather than assumed.
 *
 * ── Why this is a script in `bin/` and not a test ──
 *
 * A performance assertion in the suite is a flaky test on somebody else's
 * laptop. The number depends on the machine, the Node build and whatever else
 * is running, so the useful form is a measurement an operator or a reviewer can
 * repeat on the machine they care about — and re-run after a dependency bump,
 * which is when this kind of cost changes without anybody deciding to change it.
 *
 * ── What it measures ──
 *
 * Three configurations of the same Express app, driven with the same requests:
 *
 *   off        no SDK at all — the baseline the application ships as today
 *   on         the full pipeline, exporting to a local sink that answers 200
 *   sampled    the same, at the default 2% rather than 100%
 *
 * The third is the one that matters, because it is what production runs.
 *
 * Usage:  node bin/otel-overhead.mjs [requests]
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const REQUESTS = Number(process.argv[2]) || 2000;
const WARMUP = Math.min(300, Math.floor(REQUESTS / 4));

/** An OTLP endpoint that answers 200 immediately and remembers how much it got. */
async function startSink() {
  let bytes = 0;
  let requests = 0;
  const server = createServer((req, res) => {
    req.on('data', (c) => { bytes += c.length; });
    req.on('end', () => { requests++; res.writeHead(200); res.end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    stats: () => ({ bytes, requests }),
    close: () => new Promise((r) => server.close(r)),
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

async function measure(label, { enabled, sampleRatio, sinkPort }) {
  /* A fresh child would be cleaner still, but the SDK is process-global and
     starting it twice in one process is exactly what `ensurePatched` refuses.
     So each configuration is measured in its own process; this function is the
     body of one of them. */
  const { startOtel, shutdownOtel } = await import('../server/observability/otel.js');

  if (enabled) {
    startOtel({
      WEV_OTEL_TEST_SINK: '1',
      BETTERSTACK_SOURCE_TOKEN: 'overhead-probe-not-a-credential',
      BETTERSTACK_INGESTING_HOST: `http://127.0.0.1:${sinkPort}`,
      OTEL_TRACE_SAMPLE_RATE: String(sampleRatio),
      OTEL_TRACE_DAILY_SPAN_BUDGET: '100000000',
    });
  }

  const { default: express } = await import('express');
  const app = express();

  /**
   * Two handlers, because one number would be misleading.
   *
   * `/noop` isolates the instrumentation cost: it does nothing, so the whole
   * measured difference IS the telemetry. That is the honest way to get the
   * absolute per-request cost, and a dishonest way to get a percentage — a
   * fixed cost divided by a handler that does nothing is an arbitrarily large
   * ratio.
   *
   * `/realistic` spends about five milliseconds, which is the order a real
   * WeVolunteer route spends between the database, the authorisation check and
   * serialisation. The percentage against THAT is the one an operator should
   * read.
   */
  app.get('/noop/:id', (req, res) => res.json({ ok: true, id: req.params.id }));
  app.get('/realistic/:id', (req, res) => {
    const until = performance.now() + 5;
    let sink = 0;
    while (performance.now() < until) sink += Math.sqrt(sink + 1);
    res.json({ ok: true, id: req.params.id, sink });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function drive(path, count) {
    const base = `${origin}${path}/42`;
    const durations = new Array(count);
    const wallStart = performance.now();
    for (let i = 0; i < count; i++) {
      const t0 = performance.now();
      await fetch(base).then((r) => r.json());
      durations[i] = performance.now() - t0;
    }
    const wall = performance.now() - wallStart;
    durations.sort((a, b) => a - b);
    return {
      meanMs: Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(4)),
      p50Ms: Number(percentile(durations, 50).toFixed(4)),
      p95Ms: Number(percentile(durations, 95).toFixed(4)),
      p99Ms: Number(percentile(durations, 99).toFixed(4)),
      throughputPerSec: Number((count / (wall / 1000)).toFixed(1)),
    };
  }

  for (let i = 0; i < WARMUP; i++) await fetch(`${origin}/noop/42`).then((r) => r.json());

  const heapBefore = process.memoryUsage().heapUsed;
  const noop = await drive('/noop', REQUESTS);
  /* Fewer, because each one costs 5ms by construction. */
  const realistic = await drive('/realistic', Math.max(200, Math.floor(REQUESTS / 4)));
  const heapAfter = process.memoryUsage().heapUsed;

  const result = {
    label,
    requests: REQUESTS,
    noop,
    realistic,
    heapDeltaMb: Number(((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)),
  };

  if (enabled) {
    const t0 = performance.now();
    await shutdownOtel();
    result.shutdownMs = Number((performance.now() - t0).toFixed(1));
  }

  server.close();
  return result;
}

/* One process per configuration, driven by an argument. */
if (process.env.WEV_OVERHEAD_ROLE) {
  const role = process.env.WEV_OVERHEAD_ROLE;
  const result = await measure(role, {
    enabled: role !== 'off',
    sampleRatio: role === 'sampled' ? 0.02 : 1,
    sinkPort: Number(process.env.WEV_OVERHEAD_SINK_PORT),
  });
  process.stdout.write(`RESULT:${JSON.stringify(result)}\n`);
  process.exit(0);
}

const { spawn } = await import('node:child_process');
const sink = await startSink();

const results = [];
for (const role of ['off', 'on', 'sampled']) {
  /* `fileURLToPath`, not `url.pathname`: this repository lives under a path with
     spaces in it, and the raw pathname is percent-encoded. */
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), String(REQUESTS)], {
    env: {
      ...process.env,
      WEV_OVERHEAD_ROLE: role,
      WEV_OVERHEAD_SINK_PORT: String(sink.port),
      VITEST: '',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  const [code] = await once(child, 'exit');
  if (code !== 0) { console.error(`configuration "${role}" failed`); process.exit(1); }
  results.push(JSON.parse(out.match(/RESULT:(\{.*\})/)[1]));
}

const sinkStats = sink.stats();
await sink.close();

const [off, on, sampled] = results;
const pct = (a, b) => `${(((a - b) / b) * 100).toFixed(1)}%`;

console.log(`\nOpenTelemetry overhead — ${REQUESTS} requests per configuration\n`);

for (const workload of ['noop', 'realistic']) {
  console.log(`── ${workload} handler ──`);
  console.log('config      mean      p50       p95       p99       req/s');
  for (const r of results) {
    const w = r[workload];
    console.log(
      `${r.label.padEnd(11)} ${String(w.meanMs).padEnd(9)} ${String(w.p50Ms).padEnd(9)} `
      + `${String(w.p95Ms).padEnd(9)} ${String(w.p99Ms).padEnd(9)} ${w.throughputPerSec}`,
    );
  }
  console.log('');
}

const absolute = (sampled.noop.meanMs - off.noop.meanMs).toFixed(3);
console.log(`absolute cost per request (noop)      : +${absolute} ms`);
console.log(`relative cost, realistic 5ms handler  : ${pct(sampled.realistic.meanMs, off.realistic.meanMs)}   <- the number to read`);
console.log(`relative cost, noop handler           : ${pct(sampled.noop.meanMs, off.noop.meanMs)}   (a fixed cost over ~nothing)`);
console.log(`throughput, realistic handler         : ${pct(sampled.realistic.throughputPerSec, off.realistic.throughputPerSec)}`);
console.log(`heap delta                            : off=${off.heapDeltaMb}MB sampled=${sampled.heapDeltaMb}MB`);
console.log(`shutdown flush (healthy endpoint)     : on=${on.shutdownMs}ms sampled=${sampled.shutdownMs}ms`);
console.log(`bytes to the sink, all configs        : ${(sinkStats.bytes / 1024).toFixed(1)} KB in ${sinkStats.requests} requests`);

/**
 * A note on why "sampled" is not faster than "on".
 *
 * Tail sampling decides AFTER the spans exist, so a 2% rate does not avoid
 * recording them — it avoids sending them. The CPU cost is therefore roughly the
 * same at 2% and at 100%, and what the rate buys is the vendor bill and the free
 * plan, not local performance. That is the trade this integration deliberately
 * makes, and it is the right way round here: the $0 constraint is the hard one,
 * and the measured CPU cost is a fraction of a millisecond.
 */
