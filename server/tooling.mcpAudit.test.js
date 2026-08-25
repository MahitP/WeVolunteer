import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';

const run = promisify(execFile);

/**
 * `bin/betterstack-mcp-audit.mjs` — the script that answers, from the live
 * service, two questions Better Stack's documentation does not.
 *
 * ── Why a script that only runs once needs tests ──
 *
 * It runs once, on an operator's machine, with a real API token, and its whole
 * purpose is to produce an answer that will be written into
 * `docs/operations/betterstack.md` as fact. A transport bug would not announce
 * itself — it would surface as "refused" or "0 tools", which reads exactly like a
 * real finding. So the parsing, the header handling and the comparisons are
 * exercised here against a stub that speaks the parts of MCP the script uses.
 *
 * The stub is not a general MCP implementation and does not need to be. It
 * answers `initialize` and `tools/list`, applies `X-MCP-Tools-Only` the way the
 * script assumes a well-behaved server would, and records every method it was
 * asked for — which is how the read-only claim is checked rather than asserted.
 */

const SCRIPT = path.resolve(__dirname, '..', 'bin', 'betterstack-mcp-audit.mjs');

/** One numbered probe's output, so an assertion about probe 2 cannot read probe 1. */
const probe = (out, n) => out.split(`\n${n}. `)[1]?.split(`\n${n + 1}. `)[0] ?? '';
const REAL_TOKEN = 'audit-stub-token-value';

const ALL_TOOLS = [
  'documentation_search', 'monitors_list', 'monitor_get', 'incidents_list',
  'query_logs', 'sources_list', 'errors_list', 'dashboards_list',
  'monitor_create', 'monitor_delete', 'incident_acknowledge',
];

describe('bin/betterstack-mcp-audit.mjs', () => {
  let server = null;
  let seen = [];

  /**
   * @param {object} opts
   * @param {'ignore'|'void'} opts.unknownName  what the stub does with an
   *   allowlist entry matching no tool — the behaviour the real audit is for.
   * @param {boolean} [opts.sse]  answer as an event stream rather than JSON.
   */
  const startStub = async ({ unknownName = 'ignore', sse = false } = {}) => {
    seen = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const msg = (() => { try { return JSON.parse(body); } catch { return {}; } })();
        seen.push({
          method: msg.method,
          auth: req.headers.authorization || null,
          only: req.headers['x-mcp-tools-only'] || null,
        });

        const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (bearer !== REAL_TOKEN) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'unauthorized' } }));
          return;
        }

        let result;
        if (msg.method === 'initialize') {
          result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } };
        } else if (msg.method === 'tools/list') {
          const only = req.headers['x-mcp-tools-only'];
          let names = ALL_TOOLS;
          if (only) {
            const wanted = String(only).split(',').map((s) => s.trim()).filter(Boolean);
            const matched = ALL_TOOLS.filter((t) => wanted.some((w) => t.startsWith(w)));
            /* The two candidate behaviours for a name that matches nothing. */
            names = (matched.length === 0 && unknownName === 'void') ? ALL_TOOLS : matched;
          }
          result = { tools: names.map((name) => ({ name, description: `${name} (stub)`, inputSchema: { type: 'object' } })) };
        } else {
          res.writeHead(400).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }));
          return;
        }

        const envelope = { jsonrpc: '2.0', id: msg.id, result };
        if (sse) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'stub-session' });
          res.end(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'stub-session' });
          res.end(JSON.stringify(envelope));
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  };

  const audit = (url, env = {}) => run(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      BETTERSTACK_MCP_URL: url,
      BETTERSTACK_API_TOKEN: REAL_TOKEN,
      ...env,
    },
    timeout: 30000,
  }).then((r) => r.stdout).catch((e) => e.stdout ?? '');

  afterEach(async () => {
    if (server) { server.close(); await once(server, 'close').catch(() => {}); server = null; }
  });

  it('refuses to run without a token, and says why', async () => {
    const out = await run(process.execPath, [SCRIPT], {
      env: { ...process.env, BETTERSTACK_API_TOKEN: '', BETTER_STACK_API_TOKEN: '' },
    }).then((r) => r.stdout).catch((e) => e.stdout ?? '');

    expect(out).toContain('NO TOKEN');
    expect(out).toContain('UNKNOWN');
  });

  it('enumerates the unfiltered tool surface', async () => {
    const url = await startStub();
    const out = await audit(url);

    expect(out).toContain(`1. Unfiltered tools/list: ${ALL_TOOLS.length} tool(s)`);
    for (const name of ALL_TOOLS) expect(out).toContain(name);
  });

  it('reports the configured allowlist as honoured when it restricts', async () => {
    const url = await startStub();
    const out = await audit(url);

    expect(out).toContain('the header is HONOURED');
    /* Something was kept out — `incident_acknowledge` matches no entry. */
    const section = probe(out, 2);
    expect(section).toContain('incidents_list');
    expect(section.split('→')[0]).not.toContain('incident_acknowledge');
  });

  /**
   * The finding this test was written BECAUSE of. The stub matches allowlist
   * entries as prefixes, which is the plausible reading of a header documented
   * in category terms — and under it the entry `monitor` admits `monitor_create`
   * and `monitor_delete` alongside `monitor_get`. An allowlist that reads as
   * eight read-only categories is then not read-only at all. The script must say
   * so rather than leave it in a list of names to be noticed.
   */
  it('warns when the allowlist admits tools whose names suggest mutation', async () => {
    const url = await startStub();
    const out = await audit(url);

    expect(out).toContain('look like they MUTATE');
    expect(out).toContain('monitor_create');
    expect(out).toContain('monitor_delete');
    expect(out).toContain('Narrow the entry to the exact read tools');
  });

  it('says so plainly when nothing allowed looks like a mutation', async () => {
    const url = await startStub();
    const out = await audit(url, { BETTERSTACK_MCP_TOOLS_ONLY: 'monitors_list,incidents_list,query_logs' });

    expect(out).toContain('no allowed tool name suggests a mutation');
  });

  it('names configured entries that matched no real tool', async () => {
    const url = await startStub();
    const out = await audit(url, { BETTERSTACK_MCP_TOOLS_ONLY: 'monitors,incidents,not-a-tool,also-fake' });

    expect(out).toContain('matched no tool');
    expect(out).toContain('not-a-tool');
    expect(out).toContain('also-fake');
  });

  /* The finding the script exists for, in both directions. */
  it('detects a server that fails CLOSED on an unknown name', async () => {
    const url = await startStub({ unknownName: 'ignore' });
    const out = await audit(url);

    expect(out).toContain('fails closed');
    expect(out).not.toContain('FAILS OPEN');
  });

  it('detects a server that FAILS OPEN on an unknown name', async () => {
    const url = await startStub({ unknownName: 'void' });
    const out = await audit(url);

    expect(out).toContain('FAILS OPEN');
    expect(out).toContain('the header is cosmetic');
    /* And it says what that means for THIS project's chosen role, rather than
       leaving the reader to work out that an Admin token has nothing under it. */
    expect(out).toContain('NO boundary');
  });

  it('checks that an invalid bearer token is refused', async () => {
    const url = await startStub();
    const out = await audit(url);

    expect(out).toContain('4. With a deliberately INVALID bearer token: refused');
    expect(out).not.toContain('SERIOUS');
  });

  it('parses an event-stream response as well as a JSON one', async () => {
    const url = await startStub({ sse: true });
    const out = await audit(url);

    expect(out).toContain(`1. Unfiltered tools/list: ${ALL_TOOLS.length} tool(s)`);
    expect(out).toContain('the header is HONOURED');
  });

  it('reports an unreachable server instead of pretending', async () => {
    /* Port 1 on loopback: refused immediately. */
    const out = await audit('http://127.0.0.1:1');
    expect(out).toContain('unreachable');
    expect(out).toContain('Cannot continue without a baseline');
  });

  /**
   * The read-only claim, checked at the wire rather than taken on trust: the
   * stub records every method it was asked for, and there must be nothing in
   * that list but the handshake and the listing.
   */
  it('sends nothing but initialize and tools/list', async () => {
    const url = await startStub();
    await audit(url);

    expect(seen.length).toBeGreaterThan(0);
    const methods = [...new Set(seen.map((s) => s.method))].sort();
    expect(methods).toEqual(['initialize', 'tools/list']);
    expect(methods).not.toContain('tools/call');
  });

  /** The token is the one thing that must never appear in a pasted report. */
  it('never prints the token', async () => {
    const url = await startStub();
    const out = await audit(url);

    expect(out).not.toContain(REAL_TOKEN);
    /* Nor any fragment of it: a truncated echo is still an echo. */
    expect(out).not.toContain(REAL_TOKEN.slice(0, 12));
    expect(out).not.toContain('Authorization');
  });
});
