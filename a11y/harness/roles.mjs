/**
 * Roles come from the server, never from a literal here.
 *
 * src/components/DemoBar.jsx records what happens when a client hardcodes the
 * seed instead: api.login answered "No account found with that email address"
 * and the failure surfaced as a toast, i.e. as a product bug. The endpoint also
 * filters tombstones and internal actors, so it is the only list that is right.
 */
export async function fetchRoles(request, baseURL) {
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
