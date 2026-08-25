#!/usr/bin/env node
/**
 * Asks the Better Stack MCP server what it would actually give this account,
 * without calling a single one of its tools.
 *
 * ── Why this script exists ──
 *
 * `.mcp.json` restricts the Better Stack MCP server with `X-MCP-Tools-Only`, an
 * allowlist of tool names. Two things about that header could not be settled
 * from Better Stack's documentation, and both matter:
 *
 *   1. **Which names are real.** Their docs show the header with three tokens
 *      (`monitors`, `monitor`, `incidents`) and describe the tool CATEGORIES in
 *      prose. The remaining names in `.mcp.json` were inferred from that prose.
 *      An inferred name that is not a real one restricts nothing.
 *   2. **What an unrecognised name does.** Ignored (safe: you get fewer tools)
 *      or treated as a malformed header (unsafe: you may get all of them). Not
 *      documented, and the difference is the whole value of the header.
 *
 * Neither can be answered by reading. The tool list is not published; it is
 * returned by an authenticated `tools/list`. So this script authenticates once,
 * asks four times under different headers, and compares the answers.
 *
 * ── This script is read-only, structurally ──
 *
 * It issues `initialize` and `tools/list` and nothing else. `rpc()` refuses any
 * other method outright rather than as a matter of discipline — an MCP audit is
 * not a reason to run somebody's incident tooling — and the token used here is
 * an ADMIN token (see docs/operations/betterstack.md §7), which reaches every
 * destructive tool Better Stack exposes. Read-only is not a courtesy in that
 * situation; it is the only reason this script is safe to run.
 *
 * ── Usage ──
 *
 *   BETTERSTACK_API_TOKEN=… node bin/betterstack-mcp-audit.mjs
 *
 * The token is read from the environment ONLY. Not a flag: an argument is
 * visible in `ps` to every user on the box and lands in shell history. It is
 * never printed, never written to a file, and appears in no output below.
 *
 * Exit codes:  0  the audit ran (read its findings)
 *              1  it could not run — no token, or the server was unreachable
 */

const ENDPOINT = process.env.BETTERSTACK_MCP_URL || 'https://mcp.betterstack.com';

/** The header value under audit, kept in step with `.mcp.json` by the reader. */
const CONFIGURED_ALLOWLIST = process.env.BETTERSTACK_MCP_TOOLS_ONLY
  || 'documentation,monitors,monitor,incidents,query,sources,errors,dashboards';

/** The three names that come from Better Stack's own documented example. */
const DOCUMENTED_NAMES = ['monitors', 'monitor', 'incidents'];

/**
 * Names that suggest a tool CHANGES something.
 *
 * A HEURISTIC ON NAMES, and reported as one — it cannot know what a tool does.
 * It is here because the allowlist is written in what look like category terms,
 * and a category is not a permission: an entry like `monitor` may well bring
 * `monitor_create` and `monitor_delete` along with `monitor_get`. That is the
 * kind of thing an operator should see spelled out rather than infer from a
 * list of eleven names, and the fix is to narrow the entry, not to trust it.
 */
const MUTATING_HINT = /(create|delete|update|remove|acknowledge|resolve|pause|resume|start|stop|write|patch|set_|_set|send|trigger)/i;

/** The only two methods this script may ever send. */
const ALLOWED_METHODS = new Set(['initialize', 'tools/list']);

const token = (process.env.BETTERSTACK_API_TOKEN || process.env.BETTER_STACK_API_TOKEN || '').trim();

/* ────────────────────────────────────────────────────────────────────────────
 * Transport
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One JSON-RPC call over MCP's Streamable HTTP transport.
 *
 * The transport may answer with either a JSON body or an SSE stream, at the
 * server's discretion, so both are parsed. Returns `{ status, result, error }`
 * and never throws for a protocol-level refusal — a refusal is a FINDING here,
 * not an accident.
 */
async function rpc(method, params, { bearer, extraHeaders = {}, sessionId } = {}) {
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`refusing to send ${method}: this script is read-only`);
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-06-18',
    ...extraHeaders,
  };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    return { transportError: err?.message || String(err) };
  }

  const raw = await res.text().catch(() => '');
  const message = parseBody(res.headers.get('content-type') || '', raw);

  return {
    status: res.status,
    sessionId: res.headers.get('mcp-session-id') || sessionId || null,
    result: message?.result,
    error: message?.error,
    raw: raw.slice(0, 400),
  };
}

/** JSON, or the first JSON-RPC message out of an SSE stream. */
function parseBody(contentType, raw) {
  if (!raw) return null;
  if (contentType.includes('text/event-stream')) {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim());
        if (msg && (msg.result || msg.error)) return msg;
      } catch { /* a keep-alive or a partial frame */ }
    }
    return null;
  }
  try { return JSON.parse(raw); } catch { return null; }
}

/** Opens a session and returns its id, or null if the handshake was refused. */
async function handshake(bearer, extraHeaders) {
  const res = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'wevolunteer-mcp-audit', version: '1.0.0' },
  }, { bearer, extraHeaders });
  return res;
}

/** The tool names this server offers under the given headers. */
async function listTools(bearer, extraHeaders = {}) {
  const opened = await handshake(bearer, extraHeaders);
  if (opened.transportError) return { unreachable: opened.transportError };
  if (opened.error || opened.status >= 400) {
    return { refused: true, status: opened.status, message: opened.error?.message || opened.raw };
  }

  const res = await rpc('tools/list', {}, { bearer, extraHeaders, sessionId: opened.sessionId });
  if (res.transportError) return { unreachable: res.transportError };
  if (res.error || res.status >= 400) {
    return { refused: true, status: res.status, message: res.error?.message || res.raw };
  }
  const tools = Array.isArray(res.result?.tools) ? res.result.tools : [];
  return { names: tools.map((t) => String(t?.name ?? '')).filter(Boolean).sort() };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The audit
 * ──────────────────────────────────────────────────────────────────────────── */

const line = (s = '') => process.stdout.write(`${s}\n`);
const describe = (r) => (r.unreachable ? `unreachable (${r.unreachable})`
  : r.refused ? `refused (HTTP ${r.status})`
    : `${r.names.length} tool(s)`);

async function main() {
  line('Better Stack MCP — read-only tool-surface audit');
  line('='.repeat(60));
  line(`endpoint: ${ENDPOINT}`);
  line('methods:  initialize, tools/list  (no tool is ever called)');
  line();

  if (!token) {
    line('NO TOKEN. Set BETTERSTACK_API_TOKEN and run this again.');
    line();
    line('  The MCP tool list is not published; it is returned by an');
    line('  authenticated tools/list. Without a token nothing below can be');
    line('  answered, and docs/operations/betterstack.md must keep carrying');
    line('  these questions as UNKNOWN.');
    line();
    line('  This script only ever reads. Even so, the token you paste into a');
    line('  shell is the token that was on your clipboard and is now in your');
    line('  history — prefer a token you can revoke afterwards, and revoke it.');
    process.exitCode = 1;
    return;
  }

  /* 1 — the whole surface, unfiltered. This is what an unrestricted client
         would be handed, and the baseline every other probe is compared to. */
  const full = await listTools(token);
  line(`1. Unfiltered tools/list: ${describe(full)}`);
  if (full.unreachable) {
    line('   Cannot continue without a baseline.');
    process.exitCode = 1;
    return;
  }
  if (full.refused) {
    line(`   ${full.message}`);
    line('   Check the token, or whether this account may use the MCP server.');
    process.exitCode = 1;
    return;
  }
  for (const name of full.names) line(`     - ${name}`);
  line();

  /* 2 — the configured allowlist. Fewer tools means the header is doing
         something; the same number means it is doing nothing at all. */
  const filtered = await listTools(token, { 'X-MCP-Tools-Only': CONFIGURED_ALLOWLIST });
  line(`2. With the configured X-MCP-Tools-Only: ${describe(filtered)}`);
  if (filtered.names) {
    for (const name of filtered.names) line(`     - ${name}`);
    const honoured = filtered.names.length < full.names.length;
    line(`   → the header is ${honoured ? 'HONOURED' : 'NOT restricting anything'}`);

    /* Which of the configured names matched nothing. An inferred name that is
       not real is dead weight in the config and should be removed or fixed. */
    const configured = CONFIGURED_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);
    const surfaced = new Set(filtered.names);
    const inert = configured.filter((c) => ![...surfaced].some((n) => n === c || n.includes(c)));
    if (inert.length) {
      line(`   → ${inert.length} configured name(s) matched no tool: ${inert.join(', ')}`);
      line(`     (documented names are ${DOCUMENTED_NAMES.join(', ')}; the rest were inferred)`);
    }

    /* What the allowlist let through that looks like it can change something. */
    const mutating = filtered.names.filter((n) => MUTATING_HINT.test(n));
    if (mutating.length) {
      line(`   → ${mutating.length} allowed tool(s) look like they MUTATE: ${mutating.join(', ')}`);
      line('     (a guess from the name only). An allowlist entry naming a category');
      line('     carries every tool in it. Narrow the entry to the exact read tools.');
    } else {
      line('   → no allowed tool name suggests a mutation (a guess from names only)');
    }
  }
  line();

  /* 3 — THE question. An unrecognised name: ignored, or does it void the
         header and hand back everything? */
  const bogus = await listTools(token, { 'X-MCP-Tools-Only': 'wevolunteer-not-a-real-tool-name' });
  line(`3. With an allowlist of one NONSENSE name: ${describe(bogus)}`);
  if (bogus.names) {
    const failsOpen = bogus.names.length >= full.names.length;
    line(`   → ${failsOpen ? 'FAILS OPEN — a typo in the header disables it'
      : 'fails closed — an unmatched name grants nothing'}`);
    if (failsOpen) {
      line('   → the header is cosmetic: a typo in it disables it silently.');
      line('   → This project authenticates as a Better Stack ADMIN, so there is no');
      line('     role restriction underneath to fall back on. A cosmetic header plus');
      line('     an Admin token is NO boundary. Use a lower role for the MCP');
      line('     connection, or leave it unconnected.');
    }
  }
  line();

  /* 4 — authentication itself. A server that answers an invalid bearer with a
         tool list would be a far larger finding than anything above. */
  const anon = await listTools('wevolunteer-invalid-token-probe');
  line(`4. With a deliberately INVALID bearer token: ${describe(anon)}`);
  if (anon.names?.length) {
    line('   → SERIOUS: the server returned tools to an invalid token.');
  } else if (anon.refused) {
    line('   → refused, as it should be.');
  }
  line();

  line('='.repeat(60));
  line('Record the answers in docs/operations/betterstack.md and move each one');
  line('from "unknown" to "experimentally verified", with today\'s date — these');
  line('are observations of a live service, and a service can change.');
}

main().catch((err) => {
  /* Never interpolate the error's own properties: a fetch failure can carry
     the request, and the request carries the token. */
  line(`audit failed: ${err?.name || 'error'}`);
  process.exitCode = 1;
});
