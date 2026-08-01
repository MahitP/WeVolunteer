/**
 * `buildPrincipal`'s whole reason for existing is to defer the `grantsFor`
 * query until something actually reads `principal.grants`, rather than
 * paying for it on every authenticated request regardless of whether any
 * route ever consults a capability.
 *
 * These tests assert the laziness directly, with an injected provider function
 * standing in for `grantsFor`, rather than trying to count real SQL statements
 * over an HTTP round trip — a fake counter is a more direct, more reliable
 * witness of "was this called" than instrumenting the database layer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let dir;

/**
 * `utils.js` imports `db.js` at module scope, which opens a SQLite connection
 * at `WEV_DB_PATH` (or the real `wevolunteer.db` if unset) as a side effect of
 * import alone. WEV_DB_PATH must point at a throwaway file, and the import
 * must happen dynamically after that env var is set, or this test would open
 * (and never touch, but still create) the real database file.
 *
 * `buildPrincipal`'s default `fetchGrants` calls the real `grantsFor(db, id)`,
 * but every test below passes its own injected provider, so the connection
 * this opens is never actually queried.
 */
async function freshUtils() {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-principal-'));
  process.env.WEV_DB_PATH = path.join(dir, 'test.db');
  process.env.JWT_SECRET = 'x'.repeat(48);
  delete process.env.NODE_ENV;

  vi.resetModules();
  return import('./utils.js');
}

beforeEach(() => { dir = null; });
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('buildPrincipal — lazy, memoizing grants', () => {
  const userRow = { id: 'user-x', role: 'student' };

  it('issues zero calls to the provider when grants is never read', async () => {
    const { buildPrincipal } = await freshUtils();
    const fetchGrants = vi.fn(() => ['service.verify.external']);

    buildPrincipal(userRow, fetchGrants);

    expect(fetchGrants).not.toHaveBeenCalled();
  });

  it('issues exactly one call no matter how many times grants is read', async () => {
    const { buildPrincipal } = await freshUtils();
    const fetchGrants = vi.fn(() => ['service.verify.external']);
    const principal = buildPrincipal(userRow, fetchGrants);

    void principal.grants;
    void principal.grants;
    void principal.grants;

    expect(fetchGrants).toHaveBeenCalledTimes(1);
  });

  it('resolves to whatever the provider returns, and passes it the user id', async () => {
    const { buildPrincipal } = await freshUtils();
    const fetchGrants = vi.fn((id) => (id === 'user-x' ? ['a.capability', 'b.capability'] : []));
    const principal = buildPrincipal(userRow, fetchGrants);

    expect(principal.grants).toEqual(['a.capability', 'b.capability']);
    expect(fetchGrants).toHaveBeenCalledWith('user-x');
  });

  it('leaves every other principal field exactly as principalFor would produce', async () => {
    const { buildPrincipal } = await freshUtils();
    const principal = buildPrincipal(
      { id: 'user-x', role: 'organizer' },
      () => ['whatever']
    );

    expect(principal).toMatchObject({
      userId: 'user-x',
      actualRole: 'organizer',
      effectiveRole: 'organizer',
      actorId: null,
      aal: 1,
      impersonating: false
    });
  });
});
