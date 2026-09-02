/**
 * Better Stack, read for the Owner Center.
 *
 * ── What this is NOT ──
 *
 * It is not the telemetry wire. `server/telemetrySink.js` sends logs and
 * `server/observability/otel.js` sends traces and metrics, both with
 * `BETTERSTACK_SOURCE_TOKEN`, and neither of them reads anything back. This
 * module is the other direction: it asks the Uptime API what the monitors and
 * incidents look like, so the owner can answer "is anything down" without
 * opening a second dashboard.
 *
 * It is also not the MCP server. `docs/operations/betterstack.md` §7 is
 * explicit that the MCP is an operator tool and "the application does not use
 * it and must not"; nothing here goes near it.
 *
 * ── Why the ClickHouse SQL API is deliberately NOT used ──
 *
 * It would answer "are errors increasing" straight from the telemetry, and it
 * is free and proven to work on this account. It is still refused, twice over.
 *
 * First, `.env.example` states as a rule that "THE APPLICATION NEVER READS
 * THESE" of the three query credentials — they exist for
 * `bin/betterstack-live-check.mjs`. Quietly making the server a fourth reader
 * of a credential documented as operator-only is the kind of change that makes
 * a written boundary worthless.
 *
 * Second, the question has a better answer locally. Every error Better Stack
 * holds was put there by `server/errorReporter.js`, which also writes
 * `error_events` in this database — exactly, with no sampling, no three-day
 * retention limit and no vendor between the figure and the page. So the error
 * trend on the Owner Center is read from our own table (see
 * `ownerRoutes.js`), and Better Stack answers the question only it can:
 * whether the service is reachable from outside this machine.
 *
 * ── Free plan ──
 *
 * Better Stack's free tier includes 10 monitors and 1 status page. The two
 * endpoints below (`/api/v2/monitors`, `/api/v3/incidents`) are the standard
 * read endpoints of the Uptime API and nothing here asks for a paid capability:
 * no availability SLA summaries, no report exports, no on-call schedules. If
 * this account's plan refuses one of them the card says so and offers the
 * dashboard link instead — see `plan_restricted` in providerResult.js.
 *
 * Endpoints, auth scheme and response shapes read from Better Stack's own
 * documentation on 2026-09-02; recorded in `docs/operations/owner-center.md`
 * with the date so it can go stale visibly.
 */
import { fetchJson } from './httpJson.js';
import { fail, notConfigured, ok } from './providerResult.js';
import { telemetryStatus, telemetrySinkStats } from '../telemetrySink.js';

const UPTIME_API = 'https://uptime.betterstack.com/api';

/** The dashboard an owner is sent to for anything not reproduced here. */
export const BETTERSTACK_DASHBOARD_URL = 'https://uptime.betterstack.com/';
/** The variables that switch the Uptime reads on. Named here, never in `src/`. */
export const BETTERSTACK_CONFIGURE_WITH = 'BETTERSTACK_UPTIME_API_TOKEN';
export const BETTERSTACK_TELEMETRY_URL = 'https://telemetry.betterstack.com/';

/**
 * How much of a monitor name or an incident cause we are prepared to render.
 *
 * These strings are written by whoever configured Better Stack — which is the
 * owner — but they arrive over a network from a system this repository does not
 * control, and an unbounded string from anywhere is a layout bug waiting to be
 * a rendering one. React escapes on the way out; this bounds it on the way in.
 */
const MAX_TEXT = 160;

const text = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT - 1)}…` : trimmed;
};

/** An ISO-8601 timestamp, or null. Never a partially-parsed date. */
const when = (value) => {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};

/**
 * The token, and the reason it is a token of its own.
 *
 * Better Stack issues SEPARATE credentials per surface, and this repository
 * already holds two of them (`BETTERSTACK_SOURCE_TOKEN` writes telemetry,
 * `BETTERSTACK_API_TOKEN` reads source configuration). The Uptime API takes a
 * third — a team-scoped Uptime token, or a global token — and reusing either of
 * the existing names here would produce a 401 that looks like a revoked
 * credential rather than a missing one.
 *
 * Read per call rather than resolved once, so an operator who sets it and
 * restarts gets it, and a test can set it without reaching into module state.
 */
function uptimeToken(env = process.env) {
  return String(env.BETTERSTACK_UPTIME_API_TOKEN || '').trim();
}

export function betterStackConfigured(env = process.env) {
  return uptimeToken(env).length > 0;
}

/**
 * Every monitor, reduced to what a status card needs.
 *
 * Better Stack's own documented status values are `paused`, `pending`,
 * `maintenance`, `up`, `validating` and `down`. They are passed through
 * unchanged rather than mapped to our own words, because an operator who then
 * opens Better Stack should see the same word; the UI does the mapping to a
 * colour, in one place.
 *
 * `url` is included. It is the address being monitored — this application's own
 * public URL — which is neither a secret nor a surprise to the person reading
 * their own monitors, and it is the only way to tell two similarly-named
 * monitors apart.
 */
export async function fetchMonitors(env = process.env) {
  const token = uptimeToken(env);
  if (!token) return notConfigured(BETTERSTACK_CONFIGURE_WITH);

  /* `per_page` is capped rather than paginated. Ten monitors is the free plan's
     entire allowance, fifty is the API's page maximum, and an operator with
     more than fifty is past what a summary card can usefully show — the
     dashboard link is the right answer at that point, not a paginator here. */
  const res = await fetchJson(`${UPTIME_API}/v2/monitors?per_page=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return res;

  const rows = Array.isArray(res.body?.data) ? res.body.data : null;
  if (!rows) return fail('bad_response');

  const monitors = rows.slice(0, 50).map((row) => {
    const a = row?.attributes || {};
    return {
      id: String(row?.id ?? ''),
      name: text(a.pronounceable_name) || text(a.url) || 'Unnamed monitor',
      url: text(a.url),
      status: text(a.status) || 'unknown',
      lastCheckedAt: when(a.last_checked_at),
      /* A paused monitor is not a healthy one and not a broken one — it is one
         nobody is watching, which is its own thing to notice on a status page. */
      paused: Boolean(a.paused_at),
    };
  });

  return ok({
    monitors,
    down: monitors.filter(m => m.status === 'down').length,
    up: monitors.filter(m => m.status === 'up').length,
    paused: monitors.filter(m => m.paused).length,
  });
}

/**
 * Unresolved incidents first, then the recent history.
 *
 * Two requests rather than one filtered client-side: "is anything on fire right
 * now" and "what has been on fire lately" are different questions and the first
 * must not be answerable only by luck of what fell inside one page of results.
 * `per_page` is the API's documented maximum of 50; ten is plenty for a card.
 */
export async function fetchIncidents(env = process.env) {
  const token = uptimeToken(env);
  if (!token) return notConfigured(BETTERSTACK_CONFIGURE_WITH);

  const headers = { Authorization: `Bearer ${token}` };
  const [activeRes, recentRes] = await Promise.all([
    fetchJson(`${UPTIME_API}/v3/incidents?resolved=false&per_page=10`, { headers }),
    fetchJson(`${UPTIME_API}/v3/incidents?per_page=10`, { headers }),
  ]);

  /* The active list is the one the card is FOR. If it failed, the section
     failed, even when the history happened to answer — showing seven days of
     resolved incidents while silently not knowing whether anything is open
     right now is worse than showing nothing. */
  if (!activeRes.ok) return activeRes;

  const active = incidentList(activeRes.body);
  if (active === null) return fail('bad_response');

  const recent = recentRes.ok ? (incidentList(recentRes.body) ?? []) : [];

  return ok({
    active,
    recent,
    /* Named so the UI never has to infer "we could not read the history" from
       an empty array, which is also what "nothing has gone wrong" looks like.

       `Boolean(...)`, not the raw value: a failed `fetchJson` result has no `ok`
       property at all, so this field would be `undefined` — which JSON.stringify
       DROPS, leaving the client to read a missing key. That still renders
       correctly today, by accident, which is exactly the kind of accident that
       stops being one when somebody writes `if ('recentAvailable' in data)`. */
    recentAvailable: Boolean(recentRes.ok),
  });
}

function incidentList(body) {
  const rows = Array.isArray(body?.data) ? body.data : null;
  if (!rows) return null;
  return rows.slice(0, 10).map((row) => {
    const a = row?.attributes || {};
    return {
      id: String(row?.id ?? ''),
      name: text(a.name) || 'Incident',
      cause: text(a.cause),
      startedAt: when(a.started_at),
      acknowledgedAt: when(a.acknowledged_at),
      resolvedAt: when(a.resolved_at),
    };
  });
}

/**
 * The telemetry pipeline, answered locally.
 *
 * No request leaves the process for this: whether logs are being SENT is a fact
 * about this process, and it is one the vendor cannot tell us — Better Stack
 * has no way to report "nothing arrived because the token was never set". The
 * counters are the sink's own, which is also the only place a dropped record is
 * visible at all (see `telemetrySink.js`: a full queue drops oldest-first and a
 * failed batch is discarded rather than retried).
 *
 * This is why the Better Stack card can be useful on a deployment with no
 * Uptime token at all — which is the pilot's current state.
 */
export function telemetryPipeline() {
  const status = telemetryStatus();
  const stats = telemetrySinkStats();
  return {
    enabled: status.enabled === true,
    reason: status.reason ?? null,
    queued: stats.queued,
    sent: stats.sent,
    dropped: stats.dropped,
    failed: stats.failed,
    pending: stats.pending,
  };
}
