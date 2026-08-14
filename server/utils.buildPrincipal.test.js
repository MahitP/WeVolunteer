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

  /**
   * The withheld-capability provider, injected for the same reason `fetchGrants`
   * is, and now needed by every case rather than one.
   *
   * The real provider reads `organization_members` — the Student Organizer
   * Agreement withholds against a rank, so the question is asked of every
   * account and not only of organizers. This file deliberately opens a bare
   * connection with no schema, so letting the real one run would fail on a
   * missing table while asserting something about laziness.
   *
   * Its behaviour is covered in `server/organizerAgreement.test.js` and
   * `server/routes.studentOrganizerAgreement.test.js`.
   */
  const noWithholdings = () => [];

  it('issues zero calls to the provider when grants is never read', async () => {
    const { buildPrincipal } = await freshUtils();
    const fetchGrants = vi.fn(() => ['report.evidence.read']);

    buildPrincipal(userRow, fetchGrants, noWithholdings);

    expect(fetchGrants).not.toHaveBeenCalled();
  });

  it('issues exactly one call no matter how many times grants is read', async () => {
    const { buildPrincipal } = await freshUtils();
    const fetchGrants = vi.fn(() => ['report.evidence.read']);
    const principal = buildPrincipal(userRow, fetchGrants, noWithholdings);

    void principal.grants;
    void principal.grants;
    void principal.grants;

    expect(fetchGrants).toHaveBeenCalledTimes(1);
  });

  it('resolves to whatever the provider returns, and passes it the user id', async () => {
    const { buildPrincipal } = await freshUtils();
    const fetchGrants = vi.fn((id) => (id === 'user-x' ? ['a.capability', 'b.capability'] : []));
    const principal = buildPrincipal(userRow, fetchGrants, noWithholdings);

    expect(principal.grants).toEqual(['a.capability', 'b.capability']);
    expect(fetchGrants).toHaveBeenCalledWith('user-x');
  });

  it('leaves every other principal field exactly as principalFor would produce', async () => {
    const { buildPrincipal } = await freshUtils();
    /**
     * The third argument is the withheld-capability provider, injected for the
     * same reason `fetchGrants` is.
     *
     * Without it the real one runs, and it queries `legal_acceptances` for an
     * organizer — a table this test's throwaway database has never had, because
     * the file deliberately opens a bare connection rather than migrating one.
     * The point here is the SHAPE of the principal; needing a full schema to
     * assert that a field is spelled correctly would be the tail wagging the dog.
     *
     * The real provider's behaviour is covered in
     * server/organizerAgreement.test.js.
     */
    const principal = buildPrincipal(
      { id: 'user-x', role: 'organizer' },
      () => ['whatever'],
      () => []
    );

    expect(principal).toMatchObject({
      userId: 'user-x',
      actualRole: 'organizer',
      effectiveRole: 'organizer',
      actorId: null,
      aal: 1,
      withheld: [],
      impersonating: false
    });
  });

  it('puts the withheld list on the principal eagerly, not behind a getter', async () => {
    /**
     * `grants` is lazy on purpose; `withheld` must not be. `can()` consults it on
     * every capability check, and a lazy getter that a future refactor forgets to
     * trigger would make the withheld list empty — i.e. it would fail OPEN, which
     * is the one direction an authorization mechanism must never fail.
     */
    const { buildPrincipal } = await freshUtils();
    const computeWithheld = vi.fn(() => ['event.create']);

    const principal = buildPrincipal(
      { id: 'user-x', role: 'organizer' },
      () => [],
      computeWithheld
    );

    // Called without anything having read the property.
    expect(computeWithheld).toHaveBeenCalledTimes(1);
    expect(principal.withheld).toEqual(['event.create']);
    expect(Object.getOwnPropertyDescriptor(principal, 'withheld').get).toBeUndefined();
  });
});
