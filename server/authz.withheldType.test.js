/**
 * `withheld` must be an array, and a wrong type must refuse loudly.
 *
 * ── The silent grant this prevents ──
 *
 * The check in `can()` used to read:
 *
 *     if (Array.isArray(principal.withheld) && principal.withheld.includes(cap))
 *
 * which looks defensive and is the opposite. Any non-array made the condition
 * false, so the withholding step was skipped and the capability was **granted**
 * — for every capability the caller intended to withhold, with no error.
 *
 * The PostgreSQL port is what made that reachable. `withheldCapabilitiesFor`
 * reads the database and is therefore async; a caller that forgets to await it
 * passes a Promise, `Array.isArray(promise)` is false, and an organizer who has
 * not accepted the Organizer Agreement silently recovers every capability that
 * document withholds.
 *
 * Unlike the boolean predicates Guard 8 polices, this one cannot be caught by
 * looking for a missing `await` at the call site alone — the value travels
 * through `buildPrincipal` into `principalFor` before it is read. So it is
 * enforced at the point of use instead.
 */
import { describe, it, expect } from 'vitest';
import { can, principalFor } from './authz.js';

const organizer = { id: 'u1', role: 'organizer', account_status: 'active' };

/** A capability the Organizer Agreement actually withholds. */
const WITHHELD = 'event.create';

describe('principal.withheld must be an array', () => {
  it('withholds normally when it is one', () => {
    const p = principalFor(organizer, { withheld: [WITHHELD] });
    expect(can(p, WITHHELD), 'a withheld capability must be refused').toBe(false);
  });

  it('grants when the list is empty, so the test above is not passing for the wrong reason', () => {
    const p = principalFor(organizer, { withheld: [] });
    expect(can(p, WITHHELD)).toBe(true);
  });

  /**
   * The regression. A Promise is the shape an unawaited
   * `withheldCapabilitiesFor()` produces, and it must never read as "nothing
   * withheld".
   */
  it('THROWS on a Promise rather than silently granting', () => {
    const p = principalFor(organizer, { withheld: Promise.resolve([WITHHELD]) });
    expect(() => can(p, WITHHELD)).toThrow(/did not await withheldCapabilitiesFor/);
  });

  it('throws on any other non-array too, naming the type', () => {
    for (const bad of ['event.create', 42, { 0: WITHHELD }]) {
      const p = principalFor(organizer, { withheld: bad });
      expect(() => can(p, WITHHELD), `withheld=${JSON.stringify(bad)} was tolerated`)
        .toThrow(/must be an array/);
    }
  });

  /** Absent is legitimate and must stay so — `principalFor` defaults it. */
  it('accepts null and undefined without throwing', () => {
    expect(() => can(principalFor(organizer, {}), WITHHELD)).not.toThrow();
    expect(() => can(principalFor(organizer, { withheld: null }), WITHHELD)).not.toThrow();
  });
});
