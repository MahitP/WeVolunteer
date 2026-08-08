/**
 * The triage API: what it returns, what it refuses, and what it records.
 *
 * Role denial for all four routes is covered by `authz.matrix.test.js`, which
 * drives every route against every role from one table — the right place for it,
 * and duplicating it here would create a second list to keep in step. This file
 * covers what the matrix cannot: response shapes, ordering, bounds, the audit
 * write, and the route-ordering hazard that a status-only check cannot see.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

let srv, db, owner;

beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  ({ db } = await import('./db.js'));

  // No seeded super_admin: promote a throwaway account, as the matrix does.
  // Identity is re-read from the users row per request, so the UPDATE is enough.
  const signed = await srv.signupConfirmed({
    name: 'Triage Owner', username: 'triage_owner', email: 'triage@test.local',
    password: 'Password123', grade: 'Adult', role: 'student'
  });
  db.prepare("UPDATE users SET role = 'super_admin', verified = 1 WHERE email = 'triage@test.local'").run();
  /* Promoting by SQL skips `login()`, which is where the two-factor enrolment
     normally happens — and an unenrolled administrator is refused by
     `requireCap` before `error.read` is ever consulted. */
  const { enrolTwoFactor } = await import('./testServer.js');
  await enrolTwoFactor(db, 'triage@test.local');
  owner = signed.cookie;
}, 60000);

afterAll(async () => { await srv?.close(); });

beforeEach(() => {
  db.prepare('DELETE FROM error_events').run();
  db.prepare('DELETE FROM error_groups').run();
  db.prepare("DELETE FROM admin_audit_logs WHERE action = 'ERROR_GROUP_STATUS_CHANGED'").run();
});

const get = (p) => srv.call('GET', p, undefined, owner);
const patch = (p, body) => srv.call('PATCH', p, body, owner);

/** A group written directly, so age, status and source are exactly as needed. */
function group(fingerprint, over = {}) {
  const o = {
    source: 'server', kind: 'TypeError', message: 'm', route: null,
    status: 'open', occurrences: 3, lastSeen: '2026-08-03T12:00:00.000Z', ...over
  };
  db.prepare(`
    INSERT INTO error_groups
      (fingerprint, source, kind, message, route, status, occurrences, users_seen, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(fingerprint, o.source, o.kind, o.message, o.route, o.status, o.occurrences, o.lastSeen, o.lastSeen);
  return fingerprint;
}

const auditRows = () =>
  db.prepare("SELECT * FROM admin_audit_logs WHERE action = 'ERROR_GROUP_STATUS_CHANGED'").all();

/* ── /summary vs /:fingerprint ─────────────────────────────────────────── */

describe('GET /api/errors/summary is not swallowed by /:fingerprint', () => {
  /**
   * Asserted on SHAPE, not status.
   *
   * `summary` is a legal value for `:fingerprint`. Registered the wrong way
   * round this route never runs — the parameterised handler looks up a group
   * called "summary", finds none, and answers 404. A status-only check would
   * also pass against a `:fingerprint` handler that happened to invent a 200,
   * so the assertion has to be that the body is a SUMMARY.
   */
  it('returns the summary body, not a group and not a 404', async () => {
    group('fp-a', { source: 'client' });
    group('fp-b', { source: 'server' });

    const res = await get('/api/errors/summary');

    expect(res.status, '/summary was captured by /:fingerprint').toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['byDay', 'bySource', 'byStatus']);
    expect(res.body, 'this is a single-group body, not a summary').not.toHaveProperty('group');
    expect(res.body, 'this is a single-group body, not a summary').not.toHaveProperty('events');
    expect(res.body.bySource.map(r => r.source).sort()).toEqual(['client', 'server']);
  });

  it('counts occurrences by day from events, not from group last_seen_at', async () => {
    const fp = group('fp-day');
    for (const at of ['2026-08-01T01:00:00.000Z', '2026-08-01T09:00:00.000Z', '2026-08-02T01:00:00.000Z']) {
      db.prepare('INSERT INTO error_events (id, fingerprint, occurred_at) VALUES (?, ?, ?)')
        .run(`ev-${at}`, fp, at);
    }
    const res = await get('/api/errors/summary');
    expect(res.body.byDay).toEqual([
      { day: '2026-08-01', count: 2 },
      { day: '2026-08-02', count: 1 },
    ]);
  });

  it('is registered before the parameterised route in the source', async () => {
    const { canonicalSource } = await import('./migrations/index.js');
    const code = canonicalSource(readFileSync(path.join(here, 'routes', 'errorRoutes.js'), 'utf8'));
    const summaryAt = code.indexOf("'/api/errors/summary'");
    const paramAt = code.indexOf("'/api/errors/:fingerprint'");
    expect(summaryAt).toBeGreaterThan(0);
    expect(paramAt).toBeGreaterThan(0);
    expect(summaryAt, '/summary must be registered BEFORE /:fingerprint').toBeLessThan(paramAt);
  });
});

/* ── Listing, ordering and bounds ──────────────────────────────────────── */

describe('GET /api/errors', () => {
  it('returns the agreed response shape with defaults applied', async () => {
    group('fp-1');
    const res = await get('/api/errors');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['groups', 'limit', 'offset', 'total']);
    expect(res.body).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect(res.body.groups.length).toBe(1);
  });

  it('orders by last_seen_at DESC', async () => {
    group('fp-old', { lastSeen: '2026-08-01T00:00:00.000Z' });
    group('fp-new', { lastSeen: '2026-08-03T00:00:00.000Z' });
    group('fp-mid', { lastSeen: '2026-08-02T00:00:00.000Z' });

    const res = await get('/api/errors');
    expect(res.body.groups.map(g => g.fingerprint)).toEqual(['fp-new', 'fp-mid', 'fp-old']);
  });

  it('paginates without losing the total', async () => {
    for (let i = 0; i < 5; i++) {
      group(`fp-p${i}`, { lastSeen: `2026-08-0${i + 1}T00:00:00.000Z` });
    }
    const page = await get('/api/errors?limit=2&offset=1');
    expect(page.body.total).toBe(5);
    expect(page.body.limit).toBe(2);
    expect(page.body.offset).toBe(1);
    expect(page.body.groups.length).toBe(2);
    // offset 1 of a DESC list skips the newest.
    expect(page.body.groups[0].fingerprint).toBe('fp-p3');
  });

  it('clamps limit to the maximum', async () => {
    const res = await get('/api/errors?limit=99999');
    expect(res.body.limit, 'an unclamped limit is a self-inflicted denial of service').toBe(200);
  });

  it('neutralises hostile limit values rather than failing', async () => {
    for (const [raw, expected] of [
      ['-5', 1], ['0', 1], ['abc', 50], ['NaN', 50], ['Infinity', 50],
      ['1e9', 200], ['2.9', 2], ['', 50],
    ]) {
      const res = await get(`/api/errors?limit=${raw}`);
      expect(res.status, `limit=${raw} failed the request`).toBe(200);
      expect(res.body.limit, `limit=${raw} produced ${res.body.limit}`).toBe(expected);
    }
  });

  it('neutralises hostile offset values rather than failing', async () => {
    for (const [raw, expected] of [
      ['-1', 0], ['-99999', 0], ['abc', 0], ['Infinity', 0], ['3.7', 3], ['', 0],
    ]) {
      const res = await get(`/api/errors?offset=${raw}`);
      expect(res.status, `offset=${raw} failed the request`).toBe(200);
      expect(res.body.offset, `offset=${raw} produced ${res.body.offset}`).toBe(expected);
    }
  });

  /**
   * The case the list above could not see, and the reason `limit` and `offset`
   * are now clamped the same way.
   *
   * `limit` had a maximum from the start and `offset` had none. Every hostile
   * value anybody thought to try was small or non-finite, so the gap held: a
   * FINITE offset past `Number.MAX_SAFE_INTEGER` floors to itself, `node:sqlite`
   * refuses to bind it, and the handler's catch answered **500**. The one
   * unbounded parameter was reachable as an error, on the screen whose whole
   * job is to show errors.
   *
   * Asserted on the status FIRST: a 500 here previously came back with a
   * plausible body, so an offset-only assertion would have read as a pass.
   */
  it.each(['1e20', '99999999999999999999', '1e308', '123456789012345678901234567890'])(
    'clamps a finite offset past the safe-integer range instead of answering 500 (%s)',
    async (raw) => {
      const res = await get(`/api/errors?offset=${raw}`);
      expect(res.status, `offset=${raw} reached SQLite unclamped`).toBe(200);
      expect(res.body.offset).toBe(1_000_000);
      expect(res.body.groups).toEqual([]);
    }
  );

  /**
   * Express hands back an ARRAY for a repeated parameter, and the two shapes
   * behave differently under `Number()` — which is exactly why the array guard
   * exists rather than relying on the `Number.isFinite` check below it.
   *
   * Measured: `?limit=5&limit=9` gives `['5','9']` and `Number(['5','9'])` is
   * NaN, so the finite check alone would already fall back. But `?limit[]=5`
   * gives the SINGLE-element `['5']`, and `Number(['5'])` is **5** — a real
   * number that sails past every later check. Without the guard that value is
   * silently honoured, and the only thing still bounding it is the maximum.
   *
   * Both forms are tested because only the second one distinguishes the guard
   * from the finite check; the first passes either way and would have left the
   * guard unproven.
   */
  it('treats a repeated parameter as absent instead of coercing an array', async () => {
    const res = await get('/api/errors?limit=5&limit=9');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
  });

  it('refuses a single-element array from bracket syntax, which Number() would accept', async () => {
    const res = await get('/api/errors?limit[]=5&offset[]=3');
    expect(res.status).toBe(200);
    expect(res.body.limit, 'a bracket-syntax array was coerced instead of refused').toBe(50);
    expect(res.body.offset, 'a bracket-syntax array was coerced instead of refused').toBe(0);
  });

  it('filters by status and source, and ignores an unknown filter value', async () => {
    group('fp-open-server');
    group('fp-res-client', { status: 'resolved', source: 'client' });

    expect((await get('/api/errors?status=resolved')).body.groups.map(g => g.fingerprint))
      .toEqual(['fp-res-client']);
    expect((await get('/api/errors?source=client')).body.groups.map(g => g.fingerprint))
      .toEqual(['fp-res-client']);
    // Unknown value = no filter, not a 400: a filter is a view.
    expect((await get('/api/errors?status=wontfix')).body.total).toBe(2);
  });
});

/* ── One group ─────────────────────────────────────────────────────────── */

describe('GET /api/errors/:fingerprint', () => {
  it('returns the group with its events, newest first', async () => {
    const fp = group('fp-detail');
    db.prepare('INSERT INTO error_events (id, fingerprint, occurred_at) VALUES (?, ?, ?)')
      .run('ev-1', fp, '2026-08-01T00:00:00.000Z');
    db.prepare('INSERT INTO error_events (id, fingerprint, occurred_at) VALUES (?, ?, ?)')
      .run('ev-2', fp, '2026-08-02T00:00:00.000Z');

    const res = await get(`/api/errors/${fp}`);
    expect(res.status).toBe(200);
    expect(res.body.group.fingerprint).toBe(fp);
    expect(res.body.events.map(e => e.id)).toEqual(['ev-2', 'ev-1']);
  });

  it('404s an unknown fingerprint', async () => {
    const res = await get('/api/errors/does-not-exist');
    expect(res.status).toBe(404);
  });
});

/* ── State changes and the audit trail ─────────────────────────────────── */

describe('PATCH /api/errors/:fingerprint', () => {
  it('resolves a group, recording who and when', async () => {
    const fp = group('fp-patch');
    const res = await patch(`/api/errors/${fp}`, { status: 'resolved' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fingerprint: fp, status: 'resolved', previousStatus: 'open' });

    const row = db.prepare('SELECT * FROM error_groups WHERE fingerprint = ?').get(fp);
    expect(row.status).toBe('resolved');
    expect(row.resolved_at).toBeTruthy();
    expect(row.resolved_by).toBeTruthy();
  });

  it('clears resolved_at and resolved_by when reopening', async () => {
    const fp = group('fp-reopen', { status: 'resolved' });
    await patch(`/api/errors/${fp}`, { status: 'open' });
    const row = db.prepare('SELECT * FROM error_groups WHERE fingerprint = ?').get(fp);
    expect(row).toMatchObject({ status: 'open', resolved_at: null, resolved_by: null });
  });

  it('writes exactly ONE audit row, through recordAudit', async () => {
    const fp = group('fp-audit');
    await patch(`/api/errors/${fp}`, { status: 'ignored' });

    const rows = auditRows();
    expect(rows.length, 'a state change must leave exactly one audit row').toBe(1);
    expect(rows[0].admin_id, 'the actor is missing from the audit row').toBeTruthy();
    // recordAudit generates `audit-<uuid>`; a Date.now() id is the collision
    // that failed two account deletions before Task 1.
    expect(rows[0].id).toMatch(/^audit-[0-9a-f-]{36}$/);
    expect(rows[0].target_user_id, 'an error group is not a user').toBeNull();
    expect(rows[0].details).toContain(fp);
    expect(rows[0].details).toContain('open -> ignored');
  });

  it('refuses a status outside the closed set, and changes nothing', async () => {
    const fp = group('fp-badstatus');
    for (const bad of ['wontfix', '', null, 42, ['resolved'], { status: 'resolved' }, 'RESOLVED']) {
      const res = await patch(`/api/errors/${fp}`, { status: bad });
      expect(res.status, `status ${JSON.stringify(bad)} was accepted`).toBe(400);
    }
    expect(db.prepare('SELECT status FROM error_groups WHERE fingerprint = ?').get(fp).status).toBe('open');
    expect(auditRows().length, 'a refused change still wrote an audit row').toBe(0);
  });

  it('404s an unknown fingerprint without auditing anything', async () => {
    const res = await patch('/api/errors/nope', { status: 'resolved' });
    expect(res.status).toBe(404);
    expect(auditRows().length).toBe(0);
  });

  /**
   * End to end against Task 3's real behaviour rather than a hand-set row:
   * a group somebody marked resolved must come back when the bug does. A
   * silently-still-broken thing marked resolved is worse than no dashboard.
   */
  it('reopens automatically when the problem recurs', async () => {
    const { recordError } = await import('./errorReporter.js');
    recordError(db, { source: 'server', kind: 'TypeError', message: 'recurring failure' });

    const fp = db.prepare("SELECT fingerprint FROM error_groups WHERE message LIKE '%recurring%'").get().fingerprint;
    await patch(`/api/errors/${fp}`, { status: 'resolved' });
    expect(db.prepare('SELECT status FROM error_groups WHERE fingerprint = ?').get(fp).status).toBe('resolved');

    recordError(db, { source: 'server', kind: 'TypeError', message: 'recurring failure' });

    const after = db.prepare('SELECT * FROM error_groups WHERE fingerprint = ?').get(fp);
    expect(after.status, 'a resolved group stayed closed while still failing').toBe('open');
    expect(after.resolved_at).toBeNull();
    expect(after.occurrences).toBe(2);
  });
});

/* ── Structural ────────────────────────────────────────────────────────── */

describe('triage API: structural guarantees', () => {
  it('gates every route with requireCap and adds no alternate path', async () => {
    const { canonicalSource } = await import('./migrations/index.js');
    const code = canonicalSource(readFileSync(path.join(here, 'routes', 'errorRoutes.js'), 'utf8'));

    expect((code.match(/requireCap\('error\.read'\)/g) || []).length, 'a read route lost its gate').toBe(3);
    expect((code.match(/requireCap\('error\.write'\)/g) || []).length, 'PATCH lost its gate').toBe(1);

    // `super_admin` holds '*', so an `else if (can(...))` chain is not mutually
    // exclusive — the shape that produced a real data leak on the v1.2a branch.
    expect(code, 'an identity cascade appeared in a super-only route file').not.toContain('else if (can(');
  });

  it('needs no ROUTE_REGISTRY entry, because every route carries a capabilityGate', () => {
    const registry = readFileSync(path.join(here, 'authz.completeness.test.js'), 'utf8');
    for (const route of [
      "'GET /api/errors'", "'GET /api/errors/summary'",
      "'GET /api/errors/:fingerprint'", "'PATCH /api/errors/:fingerprint'"
    ]) {
      expect(registry, `${route} should not need a registry entry`).not.toContain(route);
    }
  });

  /**
   * §7.4 as amended: the array-driven test in authz.test.js already asserts that
   * a granted SUPER_ONLY capability is still denied, and it iterates the
   * exported list — so it covers these two automatically. Verified here rather
   * than duplicated, because a named-capability copy would stop covering the
   * next capability somebody adds.
   */
  it('relies on the existing array-driven SUPER_ONLY no-escalation test', async () => {
    const { SUPER_ONLY, can, principalFor } = await import('./authz.js');
    expect(SUPER_ONLY).toContain('error.read');
    expect(SUPER_ONLY).toContain('error.write');

    const granted = principalFor(
      { id: 'u1', role: 'admin' },
      { grants: ['error.read', 'error.write'] }
    );
    expect(can(granted, 'error.read'), 'a per-user grant reached a super-only capability').toBe(false);
    expect(can(granted, 'error.write')).toBe(false);
  });
});
