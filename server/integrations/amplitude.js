/**
 * Amplitude, read for the Owner Center.
 *
 * ── The credential is NOT the one in the bundle ──
 *
 * `VITE_AMPLITUDE_API_KEY` is public by design: Vite inlines it into the
 * browser bundle and it is a write key for ingestion. Reading data back needs
 * the project's API key AND its **secret** key, sent as HTTP Basic. That pair
 * is a genuine secret — it can read every event in the project — so it lives in
 * `AMPLITUDE_API_KEY` / `AMPLITUDE_SECRET_KEY` with no `VITE_` prefix, is read
 * only here, and never appears in a response. `src/uploadsProxy.test.js`'s
 * sibling guard in `ownerRoutes.js` asserts the payload carries no credential.
 *
 * ── Free plan, and why nothing here can force an upgrade ──
 *
 * Amplitude's Starter plan is free for 10,000 monthly tracked users and 2
 * million events. Amplitude's own documentation does not state a plan floor for
 * the Dashboard REST API, and its community answers say the endpoints are
 * reachable "under any plan type" — but that is somebody else's sentence about
 * somebody else's account, and this repository does not build a feature on it.
 *
 * So the integration is built to be OPTIONAL in the strong sense: nothing in
 * WeVolunteer depends on it, no code path requires it to answer, and if this
 * account's plan refuses the endpoint the card says "not available on your
 * Amplitude plan" and offers the dashboard link. A 402 is read as a plan
 * restriction by `classifyStatus`; a 403 is read here as one too when
 * Amplitude's body is not available to distinguish it, because on this API a
 * 403 against a well-formed Basic credential is far more often an entitlement
 * than a scope. Either way the outcome is the same and it costs nothing.
 *
 * ── Query cost is a real budget, so the queries are the cheap ones ──
 *
 * Amplitude prices Dashboard API calls as `(days) x (conditions) x (query type
 * cost)` against an hourly allowance, with at most 5 concurrent requests. Every
 * request below is a single unsegmented, ungrouped series over a bounded
 * window, which is the cheapest shape the API has: no funnels (event count x 2),
 * no retention (x 8), no group-bys. Behind `providerCache` at five minutes, an
 * owner refreshing all afternoon costs twelve query sets an hour.
 *
 * Endpoints, parameters and response shapes read from Amplitude's Dashboard
 * REST API documentation on 2026-09-02.
 */
import { fetchJson } from './httpJson.js';
import { fail, notConfigured, ok } from './providerResult.js';
import { ANALYTICS_EVENTS } from '../analyticsEvents.js';

/**
 * Where the project lives. Amplitude runs two independent regions and a US
 * credential is simply unauthorized against the EU host, so this is a
 * configuration question rather than something to discover from a 401.
 */
function baseUrl(env) {
  const region = String(env.AMPLITUDE_REGION || 'us').trim().toLowerCase();
  return region === 'eu' ? 'https://analytics.eu.amplitude.com' : 'https://amplitude.com';
}

/** The dashboard, for everything this page deliberately does not reproduce. */
export function amplitudeDashboardUrl(env = process.env) {
  return String(env.AMPLITUDE_REGION || 'us').trim().toLowerCase() === 'eu'
    ? 'https://analytics.eu.amplitude.com/'
    : 'https://analytics.amplitude.com/';
}

/** The variables that switch the analytics reads on. Named here, never in `src/`. */
export const AMPLITUDE_CONFIGURE_WITH = 'AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY';

function credentials(env) {
  const key = String(env.AMPLITUDE_API_KEY || '').trim();
  const secret = String(env.AMPLITUDE_SECRET_KEY || '').trim();
  if (!key || !secret) return null;
  return `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;
}

export function amplitudeConfigured(env = process.env) {
  return credentials(env) !== null;
}

/** Amplitude's date format is `YYYYMMDD`, in the project's own timezone. */
function stamp(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** `daysBack` whole days ending today, as the pair Amplitude wants. */
function dateWindow(daysBack, now = Date.now()) {
  const end = new Date(now);
  const start = new Date(now - (daysBack - 1) * 86_400_000);
  return { start: stamp(start), end: stamp(end) };
}

/**
 * How many days of history the cards draw. Thirty is a month of context in one
 * request, and it is also the multiplier in Amplitude's cost formula — asking
 * for a year would cost twelve times as much to answer a question nobody asked
 * of an operations page.
 */
export const WINDOW_DAYS = 30;

/**
 * A numeric series out of Amplitude's `{ data: { series, xValues } }` shape.
 *
 * Returns `null` rather than an empty array when the shape is wrong, so
 * "Amplitude answered something we do not understand" stays distinguishable
 * from "Amplitude answered zero", which is a real and unalarming result for a
 * project that has just been created.
 */
function series(body, index = 0) {
  const rows = body?.data?.series;
  const xValues = body?.data?.xValues;
  if (!Array.isArray(rows) || !Array.isArray(xValues)) return null;
  const row = Array.isArray(rows[index]) ? rows[index] : [];
  const points = xValues.map((label, i) => ({
    date: typeof label === 'string' ? label : String(label ?? ''),
    value: Number.isFinite(Number(row[i])) ? Number(row[i]) : 0,
  }));
  return points;
}

const sum = (points) => points.reduce((total, p) => total + p.value, 0);

/**
 * Percentage change between the most recent seven days and the seven before
 * them, or `null` when there is not enough history to say.
 *
 * `null` rather than 0: "no change" and "we cannot tell yet" are different
 * things to show a reader, and a new project shows the second for two weeks.
 * A previous period of zero also yields `null` — every increase from zero is
 * infinite, and "+∞%" is not a fact anybody can act on.
 */
function trend(points) {
  if (points.length < 14) return null;
  const recent = sum(points.slice(-7));
  const previous = sum(points.slice(-14, -7));
  if (previous === 0) return null;
  return Math.round(((recent - previous) / previous) * 100);
}

/** One Dashboard API GET, with the plan-restriction reading described above. */
async function query(path, params, env) {
  const auth = credentials(env);
  if (!auth) return notConfigured(AMPLITUDE_CONFIGURE_WITH);

  const url = new URL(path, baseUrl(env));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetchJson(url.toString(), { headers: { Authorization: auth } });
  if (!res.ok && res.state === 'forbidden') {
    return fail('plan_restricted', 'Amplitude refused this query for this project.');
  }
  return res;
}

/**
 * Active and new users, daily, for the window.
 *
 * Two requests because `m` takes one metric — Amplitude has no combined form —
 * and they are issued together so the card is one round trip's latency rather
 * than two.
 */
export async function fetchUsers(env = process.env, now = Date.now()) {
  const { start, end } = dateWindow(WINDOW_DAYS, now);
  const [activeRes, newRes] = await Promise.all([
    query('/api/2/users', { start, end, m: 'active', i: '1' }, env),
    query('/api/2/users', { start, end, m: 'new', i: '1' }, env),
  ]);

  /* Active is the headline; without it the card has no subject, so its failure
     is the section's failure. New users degrade to absent rather than taking
     the card down with them. */
  if (!activeRes.ok) return activeRes;

  const active = series(activeRes.body);
  if (!active) return fail('bad_response');
  const created = newRes.ok ? series(newRes.body) : null;

  return ok({
    windowDays: WINDOW_DAYS,
    active: {
      today: active.at(-1)?.value ?? 0,
      last7: sum(active.slice(-7)),
      last30: sum(active),
      trend: trend(active),
      points: active,
    },
    /* `null`, not zeroes. A card that cannot tell the reader it failed to read
       new users would instead tell them nobody signed up. */
    new: created ? {
      today: created.at(-1)?.value ?? 0,
      last7: sum(created.slice(-7)),
      last30: sum(created),
      trend: trend(created),
      points: created,
    } : null,
  });
}

/**
 * Totals for each event in `server/analyticsEvents.js`, over the window.
 *
 * One request per event, run together. `m=totals` rather than the default
 * `uniques`: this card answers "how much is this feature used", and on a
 * platform with a few hundred accounts the unique-user count of a feature is
 * close enough to the account count to say nothing.
 *
 * An event nobody has ever fired returns a series of zeroes, not an error, and
 * is shown as zero — which is the honest answer and the useful one.
 */
export async function fetchEventUsage(env = process.env, now = Date.now()) {
  if (!credentials(env)) return notConfigured(AMPLITUDE_CONFIGURE_WITH);
  const { start, end } = dateWindow(WINDOW_DAYS, now);

  const results = await Promise.all(ANALYTICS_EVENTS.map(async (event) => {
    const res = await query('/api/2/events/segmentation', {
      e: JSON.stringify({ event_type: event.name }),
      start,
      end,
      m: 'totals',
      i: '1',
    }, env);
    /**
     * A 400 means Amplitude has never recorded this event, and that is ZERO.
     *
     * Amplitude answers `{"error": {"http_code": 400, "type": "invalid",
     * "message": "Invalid chart definition", "metadata": {"details": "Invalid
     * <event name>"}}}` for an event type it has no record of — verified
     * against the live account on 2026-09-03.
     *
     * Reading that as a failure was wrong in the direction this card is most
     * careful about elsewhere: it rendered "Unavailable", which this page uses
     * to mean "we could not ask". The truth is that we asked and the answer is
     * none. It is also the NORMAL state of every newly added event until the
     * first person fires one, so three of the four rows read as broken on a
     * correctly working installation.
     *
     * The 400 is safely attributable to the event name rather than to a
     * malformed query, because every event here is asked for with the identical
     * parameter shape and the ones Amplitude knows about return 200. If the
     * query itself were wrong, none of them would work.
     *
     * `neverRecorded` is kept separate from a genuine in-window zero so the
     * page can say "not recorded yet" rather than leaving an owner wondering
     * whether the tracking is wired up at all.
     */
    if (!res.ok && res.status === 400) return { event, total: 0, trend: null, neverRecorded: true };
    if (!res.ok) return { event, failure: res };
    const points = series(res.body);
    return points ? { event, total: sum(points), trend: trend(points) } : { event, failure: fail('bad_response') };
  }));

  /* If EVERY event failed the same way, that is a fact about the credential or
     the plan rather than about the events, and the card should say so once
     instead of drawing four identical error rows. */
  const failures = results.filter(r => r.failure);
  if (failures.length === results.length && results.length > 0) return failures[0].failure;

  return ok({
    windowDays: WINDOW_DAYS,
    events: results.map(r => ({
      name: r.event.name,
      label: r.event.label,
      description: r.event.description,
      /* `null` total means "not read", which the UI renders as unavailable
         rather than as a zero-length bar. */
      total: r.failure ? null : r.total,
      trend: r.failure ? null : r.trend,
      /* True only when Amplitude has no record of the event at all — see the
         400 branch above. A row that is zero because nobody used the feature
         this month does NOT carry it. */
      neverRecorded: Boolean(r.neverRecorded),
    })),
  });
}
