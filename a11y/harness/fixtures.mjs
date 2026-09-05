import { signInAs } from './signIn.mjs';

/**
 * Route parameters that cannot be typed into `routes.mjs`, resolved from the
 * running application instead.
 *
 * ── Why this file exists at all ──
 *
 * `routes.mjs` fills `:id`, `:handle`, `:eventId` and `:slug` from literals,
 * and for those that is right: the demo seed writes `user-diana`,
 * `event-softball`, `dsorensen` and `terms-of-service` verbatim, so a value
 * written down once stays true and the guard in `routes.test.js` can check it
 * without a database.
 *
 * `:code` is not like that. `generateCode` in `server/certificates.js` builds a
 * certificate code out of `crypto.randomBytes`, so it is different in every
 * scratch database — two consecutive reseeds produced `WEV-3CVD-ZJS6` and
 * `WEV-5U93-8FP9`. The typed fixture was `WEV-8DLE-CNMH`, which had therefore
 * never resolved and never could. React Router serves the shell for any path,
 * so `/verify/WEV-8DLE-CNMH` answered HTTP 200, landed on exactly that path and
 * rendered "Invalid Certificate" — which the sweep measured and filed under
 * `/verify/:code`. That is the failure `walk.mjs` describes in its own words:
 * worse than skipping a route, because it produces numbers that look like
 * coverage.
 *
 * ── Why here and not in routes.mjs ──
 *
 * `routes.mjs` is imported by `routes.test.js`, a vitest guard that must not
 * open a database connection or need a server. Asking the application is
 * therefore a Playwright-side job: this module runs with `browser`, `request`
 * and `baseURL` in hand, and `walk.mjs` merges what it returns over the typed
 * table just before navigating.
 *
 * ── What a failure here does, and does not, do ──
 *
 * It does not throw the sweep away. If no seeded student holds a certificate
 * the typed placeholder stands, the route renders its not-found panel, and
 * `walk.mjs` reports the route as UNMEASURED — the honest outcome, and one that
 * leaves the other forty-odd routes measured. Only a broken endpoint or a
 * broken sign-in propagates, because at that point nothing in the run is
 * trustworthy anyway.
 */

/**
 * Memoised per worker process, keyed by `baseURL`, for the reasons `roles.mjs`
 * sets out at length: every spec calls `forEachRoute`, `forEachRoute` calls
 * this, and the answer is fixed by a seed that nothing in the run rewrites.
 * Resolving a code costs two sign-ins; doing it once per worker rather than
 * once per sweep is the difference between a few seconds and a minute of the
 * run spent re-answering the same question.
 *
 * The PROMISE is cached, not the value, so two callers starting together share
 * one resolution. A rejection is evicted so a transient failure does not poison
 * the worker.
 */
const fixturesByBaseUrl = new Map();

export function resolveFixtures({ browser, request, baseURL }) {
  const cached = fixturesByBaseUrl.get(baseURL);
  if (cached) return cached;

  const pending = loadFixtures({ browser, request, baseURL }).catch((err) => {
    fixturesByBaseUrl.delete(baseURL);
    throw err;
  });
  fixturesByBaseUrl.set(baseURL, pending);
  return pending;
}

/** Exposed so a test can prove the caching rather than assume it. */
export function resetFixtureCache() {
  fixturesByBaseUrl.clear();
}

async function loadFixtures({ browser, request, baseURL }) {
  const code = await certificateCode({ browser, request, baseURL });
  /* An absent value is OMITTED rather than set to null, so the merge in
     `routes.mjs` falls back to the typed placeholder instead of producing
     `/verify/null`. */
  return code ? { code } : {};
}

/**
 * A certificate code that exists right now, or null.
 *
 * ── Why every student, and not `fetchRoles` ──
 *
 * `fetchRoles` keeps one account per distinct ROLE, which is exactly right for
 * a sweep measuring shells and reachable route sets — auditing three students
 * adds no coverage there. It is wrong here, because a certificate belongs to an
 * ACCOUNT and not to a role: the seed gives one to `user-student-2`
 * (`db.js` — the only attendance row with `present = 1`), so the deduplicated
 * list hands back `user-student-1`, who has none. Which account holds it is a
 * seed detail this file should not have to know, so it asks each student in
 * turn and stops at the first that answers.
 *
 * `/api/certificates` is also the ONLY place a code can be learned from.
 * `/api/users/:id/certificates` deliberately omits it — the code is a bearer
 * credential, and handing out somebody else's would turn "see that Sam
 * volunteered" into "produce Sam's certificate on demand".
 */
async function certificateCode({ browser, request, baseURL }) {
  const res = await request.get(`${baseURL}/api/auth/demo-accounts`);
  if (!res.ok()) {
    throw new Error(
      `GET /api/auth/demo-accounts returned ${res.status()} while resolving the `
      + 'certificate fixture. Is DEMO_MODE=true on the API server and the scratch '
      + 'database seeded?'
    );
  }
  const payload = await res.json();
  const accounts = (Array.isArray(payload) ? payload : payload?.accounts ?? [])
    /* `role` here is the picker's LABEL ("Student", "Pending organizer"), which
       is what the endpoint emits — see demoRoleLabel in authRoutes.js. */
    .filter(a => /student/i.test(a.role || ''));

  const tried = [];
  for (const account of accounts) {
    const statePath = await signInAs(
      browser,
      { key: `fixture-${account.id}`, email: account.email, role: account.role },
      baseURL
    );
    const context = await browser.newContext({ baseURL, storageState: statePath });
    try {
      const list = await context.request.get('/api/certificates');
      if (!list.ok()) {
        tried.push(`${account.id}: HTTP ${list.status()}`);
        continue;
      }
      const body = await list.json();
      const rows = Array.isArray(body) ? body : (body?.certificates ?? []);
      const found = rows.find(r => r?.code)?.code;
      tried.push(`${account.id}: ${rows.length} certificate(s)`);
      if (found) {
        /* Printed, not silent, and this is the point of the whole file: a run's
           log should say which code `/verify/:code` was measured against. The
           defect being fixed here was invisible precisely because nothing in the
           output distinguished "measured the verification page" from "measured a
           not-found panel under its name". One line per worker. */
        console.log(
          `[a11y fixtures] /verify/:code resolved to ${found} (${account.id}) — `
          + 'the sweep measures a real certificate, not a not-found panel.'
        );
        return found;
      }
    } finally {
      await context.close();
    }
  }

  /* Loud, but not fatal. The route it serves will be reported as unmeasured by
     `walk.mjs`, which is a failing assertion with a route name attached; this
     line is what tells whoever reads the log WHY, without ending the run for
     the forty-odd routes that have nothing to do with certificates. */
  console.warn(
    '[a11y fixtures] no seeded student holds a certificate, so /verify/:code has '
    + `no real code to be measured against. Tried — ${tried.join('; ') || 'no student accounts'}. `
    + 'A certificate needs an attended, past event in the demo seed.'
  );
  return null;
}
