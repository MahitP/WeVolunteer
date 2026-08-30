import { describe, it, expect } from 'vitest';
import { compare } from './baseline.mjs';

/**
 * The ratchet, and the two ways a baseline stops being one.
 *
 * A baseline is a place defects go to be forgotten unless two rules hold: a NEW
 * rule firing is a regression, and an EXISTING rule firing MORE OFTEN is also a
 * regression. The second is the one that gets left out, and without it somebody
 * adds nine more unlabelled buttons to a page that already had one and the run
 * stays green — worse than having no baseline at all, because it reads as proof.
 *
 * Every entry must also name the audit finding that explains it. An accepted
 * violation with no explanation is how a baseline becomes a list nobody can act
 * on, and then a list nobody reads.
 *
 * This is the most subtle logic in the harness and the least visible: the
 * baseline is `{}` today, so a broken `compare` would pass every run silently.
 * That is exactly why it is tested against fixtures rather than against reality.
 */
describe('the accessibility baseline ratchet', () => {
  const baseline = { '/::student': { 'color-contrast': { count: 2, finding: 'A-01' } } };

  it('accepts the same violations at the same count', () => {
    expect(compare(baseline, { '/::student': { 'color-contrast': 2 } }).regressions).toEqual([]);
  });

  it('reports a new rule as a regression', () => {
    const r = compare(baseline, { '/::student': { 'color-contrast': 2, 'button-name': 1 } });
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0]).toMatchObject({ key: '/::student', rule: 'button-name', was: 0, now: 1 });
  });

  it('reports MORE of an existing rule as a regression', () => {
    /* The half that is easy to omit. Without it the ratchet only notices new
       KINDS of defect and never a worsening of a known one. */
    const r = compare(baseline, { '/::student': { 'color-contrast': 3 } });
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0]).toMatchObject({ rule: 'color-contrast', was: 2, now: 3 });
  });

  it('reports fewer as fixed, and never as a failure', () => {
    const r = compare(baseline, { '/::student': { 'color-contrast': 1 } });
    expect(r.regressions).toEqual([]);
    expect(r.fixed).toHaveLength(1);
  });

  it('treats a route absent from the baseline as all-new', () => {
    const r = compare(baseline, { '/settings::student': { label: 1 } });
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0]).toMatchObject({ key: '/settings::student', was: 0, now: 1 });
  });

  it('counts a rule that disappeared from a route as fixed', () => {
    const r = compare(baseline, {});
    expect(r.regressions).toEqual([]);
    expect(r.fixed).toHaveLength(1);
    expect(r.fixed[0]).toMatchObject({ rule: 'color-contrast', was: 2, now: 0 });
  });

  it('refuses a baseline entry with no audit finding id', () => {
    expect(() => compare({ '/::student': { label: { count: 1 } } }, {}))
      .toThrow(/finding/i);
  });

  it('refuses an empty finding id, not just a missing one', () => {
    /* `finding: ''` satisfies a truthiness check and explains nothing. */
    expect(() => compare({ '/::student': { label: { count: 1, finding: '' } } }, {}))
      .toThrow(/finding/i);
  });

  it('accepts an empty baseline, which is the state a clean tree is in', () => {
    expect(() => compare({}, {})).not.toThrow();
    expect(compare({}, {}).regressions).toEqual([]);
  });
});
