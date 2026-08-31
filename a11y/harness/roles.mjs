/**
 * Roles come from the server, never from a literal here.
 *
 * src/components/DemoBar.jsx records what happens when a client hardcodes the
 * seed instead: api.login answered "No account found with that email address"
 * and the failure surfaced as a toast, i.e. as a product bug. The endpoint also
 * filters tombstones and internal actors, so it is the only list that is right.
 */
/**
 * Memoised per worker process, keyed by `baseURL`.
 *
 * ── Why this needed fixing ──
 *
 * Every spec calls this in its own setup, and `walk.mjs` calls it again for
 * each pass. Measured over one full run with a counting middleware on `/api`:
 * 1,019 requests to `/api/auth/demo-accounts` out of the 10,000 the run is
 * allowed, all of them asking a question whose answer is fixed by the seed and
 * cannot change while the suite runs — the scratch database is created once by
 * `bin/reset-dev-db.mjs` before Playwright starts and nothing here writes an
 * account.
 *
 * Caching is therefore not a way of hiding a limit; it removes work that was
 * never doing anything. It also makes each spec's setup a little faster, which
 * matters on a suite already measured in minutes.
 *
 * ── Why per process and not global ──
 *
 * Playwright runs workers as separate processes, so this is naturally one entry
 * per worker. A worker only ever talks to one server, but the map is keyed by
 * `baseURL` anyway so that a future harness pointing at two origins cannot be
 * served the wrong list silently.
 *
 * The PROMISE is cached, not the resolved value: two specs starting together in
 * the same worker would otherwise both miss and both fetch. A rejected promise
 * is evicted so a transient failure does not poison the worker for the rest of
 * the run.
 */
const rolesByBaseUrl = new Map();

export function fetchRoles(request, baseURL) {
  const cached = rolesByBaseUrl.get(baseURL);
  if (cached) return cached;

  const pending = loadRoles(request, baseURL).catch((err) => {
    rolesByBaseUrl.delete(baseURL);
    throw err;
  });
  rolesByBaseUrl.set(baseURL, pending);
  return pending;
}

/** Exposed for `roles.test.js`, which asserts the caching rather than assuming it. */
export function resetRoleCache() {
  rolesByBaseUrl.clear();
}

async function loadRoles(request, baseURL) {
  const res = await request.get(`${baseURL}/api/auth/demo-accounts`);
  if (!res.ok()) {
    throw new Error(
      `GET /api/auth/demo-accounts returned ${res.status()}. `
      + 'Is DEMO_MODE=true on the API server and the scratch database seeded?'
    );
  }
  const list = await res.json();
  const accounts = Array.isArray(list) ? list : list?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error(
      'the demo-accounts endpoint returned no accounts — the seed did not run. '
      + `Payload was: ${JSON.stringify(list).slice(0, 200)}`
    );
  }
  /* One account per distinct role. Auditing five students adds no coverage; the
     shell, the rail and the reachable route set are what differ, and those
     follow role. */
  const byRole = new Map();
  for (const acc of accounts) if (!byRole.has(acc.role)) byRole.set(acc.role, acc);
  return [...byRole.values()].map(a => ({ key: a.role, email: a.email, role: a.role }));
}
