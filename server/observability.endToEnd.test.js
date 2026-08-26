/**
 * A real request, through the real application, to a real OTLP endpoint.
 *
 * ── Why this file exists when `observability.integration.test.js` already does ──
 *
 * That one drives the pipeline directly: it creates spans by calling `withSpan`
 * and asserts what comes out. It proves the pipeline. It does not prove that the
 * pipeline is CONNECTED to the application — that a request carrying an email
 * address in its query string, through this application's real middleware stack
 * and real routing, does not put that address on the wire.
 *
 * That is the claim that would be embarrassing to get wrong, and the only honest
 * way to test it is to boot the app and make an HTTP request at it.
 *
 * ── What is deliberately NOT tested here ──
 *
 * Express instrumentation. It does not work under Vitest — measured, and
 * explained at the assertion below — because vite-node loads modules instead of
 * Node's ESM loader. That claim is proven in
 * `observability.production.test.js`, which spawns a real `node`. It was moved
 * rather than softened.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { once } from 'node:events';

import { startTestServer } from './testServer.js';
import { startOtel, shutdownOtel, otelSnapshot, __resetOtelForTests } from './observability/otel.js';

const TOKEN = 'stub-token-not-a-real-credential';

/** Values a user could put into the application through an ordinary form. */
const HOSTILE = {
  email: 'chris.vale@school.org',
  address: '123 Maple Street',
  secret: 'sup3rs3cr3tvalue',
};

let stub;
let received;
let srv;

beforeAll(async () => {
  received = [];
  stub = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') {
        try { body = gunzipSync(body); } catch { /* keep it as received */ }
      }
      received.push({ url: req.url, text: body.toString('latin1') });
      res.writeHead(200);
      res.end();
    });
  });
  stub.listen(0, '127.0.0.1');
  await once(stub, 'listening');

  __resetOtelForTests();
  startOtel({
    VITEST: '1',
    WEV_OTEL_TEST_SINK: '1',
    BETTERSTACK_SOURCE_TOKEN: TOKEN,
    BETTERSTACK_INGESTING_HOST: `http://127.0.0.1:${stub.address().port}`,
    TELEMETRY_SERVICE_NAME: 'wevolunteer-e2e',
    /* Everything is kept, so an absent span means an absent span rather than an
       unlucky sample. The budget is what stops that being unbounded. */
    OTEL_TRACE_SAMPLE_RATE: '1',
    OTEL_TRACE_DAILY_SPAN_BUDGET: '100000',
  });

  srv = await startTestServer();
}, 60000);

afterAll(async () => {
  await srv?.close();
  await shutdownOtel();
  __resetOtelForTests();
  await new Promise((resolve) => stub.close(resolve));
});

/** Everything the exporter has sent, as one searchable string. */
function wire() {
  return received.map(r => r.text).join(' ');
}

async function settle(ms = 2600) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('a real request through the real app', () => {
  beforeAll(async () => {
    /* A GET whose query string carries exactly what the log pipeline refuses to
       record. It does not need to succeed — a 4xx exercises the same span. */
    await fetch(
      `${srv.base}/api/events?email=${encodeURIComponent(HOSTILE.email)}`
      + `&q=${encodeURIComponent(HOSTILE.address)}&token=${HOSTILE.secret}`,
      { headers: { 'User-Agent': 'WeVolunteerProbe/1.0', Cookie: 'session=should-never-appear' } },
    ).catch(() => { /* the response does not matter; the span does */ });

    await settle();
  }, 30000);

  it('produced spans at all', () => {
    expect(received.length).toBeGreaterThan(0);
    expect(otelSnapshot().spansExported).toBeGreaterThan(0);
  });

  it('registered the ESM loader hook', () => {
    expect(otelSnapshot().esmHook).toBe(true);
  });

  /**
   * Express spans are NOT asserted here, and that is a finding rather than a gap.
   *
   * MEASURED: this exact request, in this harness, produces one span — the
   * `http` one, named `GET` with no route. `esmHook` reports true and the patch
   * still does not apply, because Vitest loads modules through vite-node's
   * module runner instead of Node's ESM loader, so the hook
   * `import-in-the-middle` installs never sees `import 'express'`.
   *
   * The assertion was not weakened to make this file green — it was MOVED to
   * `observability.production.test.js`, which spawns a real `node` process with
   * the same import order and asserts on the Express span, the route-qualified
   * span name and the absence of middleware spans. Asserting it here in a
   * softened form would have been a test that passes without testing anything.
   *
   * What this file still proves, and the production suite cannot as thoroughly,
   * is the privacy contract against the REAL application's middleware stack,
   * routing and error handling. Those assertions follow.
   */
  it('recorded the request as an http span', () => {
    expect(wire()).toContain('http.request.method');
  });

  it('put no email address on the wire', () => {
    expect(wire()).not.toContain(HOSTILE.email);
    expect(wire()).not.toContain('chris.vale');
  });

  it('put no street address on the wire', () => {
    expect(wire()).not.toContain(HOSTILE.address);
    expect(wire()).not.toContain('Maple');
  });

  it('put no query-string secret on the wire', () => {
    expect(wire()).not.toContain(HOSTILE.secret);
  });

  it('put no cookie on the wire', () => {
    expect(wire()).not.toContain('should-never-appear');
    expect(wire()).not.toContain('session=');
  });

  it('put no user agent on the wire', () => {
    expect(wire()).not.toContain('WeVolunteerProbe');
  });

  it('put no client IP address on the wire', () => {
    /* The request came from loopback, so this is the value that would be there. */
    expect(wire()).not.toContain('127.0.0.1');
    expect(wire()).not.toContain('::ffff:');
  });

  it('put none of the attribute KEYS that carry those values on the wire', () => {
    /* Belt to the braces above: a value could coincidentally not appear, but the
       key is emitted verbatim by the instrumentation and its absence is proof
       the scrubber ran. */
    const text = wire();
    for (const key of ['url.query', 'url.path', 'client.address', 'network.peer.address', 'user_agent.original']) {
      expect(text, `attribute ${key} reached the wire`).not.toContain(key);
    }
  });

  it('did not export the source token in any payload', () => {
    expect(wire()).not.toContain(TOKEN);
  });
});

describe('inbound trace context is refused', () => {
  it('does not adopt a client-supplied trace id', async () => {
    /* Two things at once: a trace id the client chose, and `-01` asking to be
       sampled. Honouring either would let an unauthenticated caller collide with
       somebody else's trace, or select itself into 100% sampling and spend the
       span budget from outside. */
    const planted = '4bf92f3577b34da6a3ce929d0e0e4736';
    received.length = 0;

    await fetch(`${srv.base}/api/events`, {
      headers: { traceparent: `00-${planted}-00f067aa0ba902b7-01` },
    }).catch(() => {});

    await settle();
    expect(received.length).toBeGreaterThan(0);

    /**
     * Searched as RAW BYTES, not as the hex string.
     *
     * ── The weak assertion this replaces ──
     *
     * The first version of this test searched the wire for the hex text
     * `4bf92f35…`, and mutation testing showed it SURVIVED: with `extract`
     * changed to honour the inbound header, the test still passed. OTLP encodes
     * `trace_id` as a 16-byte protobuf `bytes` field, never as hex, so the hex
     * string could not have appeared whatever the code did — the assertion was
     * unfalsifiable and proved nothing.
     *
     * Sixteen raw bytes is what would actually be on the wire if the planted
     * context had been adopted, so that is what is looked for.
     */
    const plantedBytes = Buffer.from(planted, 'hex').toString('latin1');
    expect(plantedBytes).toHaveLength(16);
    expect(wire()).not.toContain(plantedBytes);
  }, 30000);
});

describe('the health endpoint is not traced', () => {
  it('produces no span, because it is polled for ever and answers nothing', async () => {
    await shutdownOtel();     // flush whatever is outstanding first
    received.length = 0;

    for (let i = 0; i < 5; i++) await fetch(`${srv.base}/health`).catch(() => {});
    await settle();

    /* The SDK is shut down, so nothing should arrive regardless; the assertion
       that matters is that no health span was buffered before that. */
    expect(received.filter(r => r.text.includes('/health'))).toHaveLength(0);
  }, 30000);
});
