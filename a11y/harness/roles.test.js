import { describe, it, expect, beforeEach } from 'vitest';
import { fetchRoles, resetRoleCache } from './roles.mjs';

/**
 * The role list is fetched once per worker, and this is why that matters.
 *
 * ── The measurement ──
 *
 * Every spec calls `fetchRoles` in its own setup and `walk.mjs` calls it again
 * per pass. A counting middleware on `/api` during one full `npm run a11y`
 * recorded 1,019 requests to `/api/auth/demo-accounts` — a tenth of the 10,000
 * the run is allowed — all asking a question fixed by the seed before Playwright
 * started.
 *
 * That waste is not what broke the gate on its own (the application's own page
 * loads are the bulk of the traffic, and `A11Y_HARNESS` is what addresses the
 * ceiling), but a cache that silently stops caching would put a tenth of the
 * budget back and make the suite's headroom worse for no reason anybody would
 * notice. The point of pinning it here is that nothing about a cache working
 * shows up in a passing accessibility run.
 *
 * ── Why a fake `request` and not the real server ──
 *
 * The behaviour under test is "how many times does this call the endpoint",
 * which a counter answers exactly and a live server answers only by inference.
 * The shape returned matches `/api/auth/demo-accounts`, and `roles.mjs` is the
 * only consumer of that shape.
 */

/** A stand-in for Playwright's `request` fixture that counts its calls. */
function fakeRequest(payload, { ok = true, status = 200 } = {}) {
  const calls = [];
  return {
    calls,
    get: async (url) => {
      calls.push(url);
      return { ok: () => ok, status: () => status, json: async () => payload };
    },
  };
}

const SEEDED = [
  { role: 'student', email: 'leo.chen@example.com' },
  { role: 'student', email: 'priya.patel@example.com' },
  { role: 'organizer', email: 'jordan.whitfield@example.org' },
  { role: 'admin', email: 'admin@example.gov' },
];

beforeEach(() => resetRoleCache());

describe('fetchRoles', () => {
  it('asks the server once, however many times it is called', async () => {
    const request = fakeRequest(SEEDED);

    const first = await fetchRoles(request, 'http://127.0.0.1:5099');
    const second = await fetchRoles(request, 'http://127.0.0.1:5099');
    const third = await fetchRoles(request, 'http://127.0.0.1:5099');

    expect(request.calls.length, 'the role list was re-fetched').toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('does not fetch twice when two callers start together', async () => {
    /* Two specs beginning in the same worker. Caching the resolved value rather
       than the promise would let both miss and both fetch. */
    const request = fakeRequest(SEEDED);

    const [a, b] = await Promise.all([
      fetchRoles(request, 'http://127.0.0.1:5099'),
      fetchRoles(request, 'http://127.0.0.1:5099'),
    ]);

    expect(request.calls.length).toBe(1);
    expect(a).toBe(b);
  });

  it('keeps one entry per origin', async () => {
    const request = fakeRequest(SEEDED);

    await fetchRoles(request, 'http://127.0.0.1:5099');
    await fetchRoles(request, 'http://127.0.0.1:5100');

    expect(request.calls).toEqual([
      'http://127.0.0.1:5099/api/auth/demo-accounts',
      'http://127.0.0.1:5100/api/auth/demo-accounts',
    ]);
  });

  it('still collapses the list to one account per role', async () => {
    /* The caching must not change what is returned. Two students in, one out. */
    const roles = await fetchRoles(fakeRequest(SEEDED), 'http://127.0.0.1:5099');

    expect(roles.map(r => r.key)).toEqual(['student', 'organizer', 'admin']);
    expect(roles[0].email, 'the first account of each role is the one kept')
      .toBe('leo.chen@example.com');
  });

  it('does not cache a failure', async () => {
    /* A transient 429 or a server still starting must not poison the worker for
       the rest of the run — the next caller has to be able to succeed. */
    const failing = fakeRequest(null, { ok: false, status: 429 });
    await expect(fetchRoles(failing, 'http://127.0.0.1:5099')).rejects.toThrow(/429/);

    const working = fakeRequest(SEEDED);
    const roles = await fetchRoles(working, 'http://127.0.0.1:5099');

    expect(working.calls.length, 'the rejection was cached and never retried').toBe(1);
    expect(roles.map(r => r.key)).toContain('organizer');
  });

  it('does not cache an empty seed', async () => {
    /* Same reasoning: "the seed did not run" is a state that gets fixed, and a
       cached empty list would report it forever. */
    const empty = fakeRequest([]);
    await expect(fetchRoles(empty, 'http://127.0.0.1:5099')).rejects.toThrow(/seed did not run/);

    const working = fakeRequest(SEEDED);
    await expect(fetchRoles(working, 'http://127.0.0.1:5099')).resolves.toHaveLength(3);
  });
});
