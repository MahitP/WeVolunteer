/**
 * Dates for fixtures, computed rather than written down.
 *
 * ── The failure this exists for ──
 *
 * `parseEffectiveAt` floors a legal revision's effective date at
 * yesterday-in-UTC. A literal date in a test is therefore valid for exactly two
 * days and refused for ever afterwards, and the refusal arrives long after
 * anybody remembers writing it.
 *
 * It has happened twice. `legalEditor.adversarial.test.js` and
 * `routes.legalEditor.test.js` carried `effectiveAt: '2026-09-01'` thirty times
 * between them and all thirty began failing on 2026-09-03 — and the count was
 * not the expensive part. `validatePublication` checks the date BEFORE the body
 * sanitizer and before the step-up grant, so the date refusal preempted
 * everything those cases were about: thirteen link-injection tests reported
 * `expected 'effectiveAt' to be 'body'`, two grant tests reported
 * `expected 400 to be 409`, and a unique-constraint test reported a constraint
 * not firing against a row whose publish had been refused. Twenty-eight
 * failures, four of which mentioned a date.
 *
 * `legalUpgradeBoot.test.js` held the same bug with a longer fuse — `2027-01-01`
 * and `2027-02-01`, which pass today and become past dates in four months. It
 * was found by the guard in `legalStore.test.js`, not by anybody reading the
 * file.
 *
 * ── Why a module and not a line in each file ──
 *
 * Copies of a one-liner are how the next caller writes a literal instead.
 * `server/testing/` is where this project already keeps test infrastructure that
 * more than one suite needs (`fixtureDebt.js`), and the guard in
 * `legalStore.test.js` fails the build on any test that goes back to a literal.
 *
 * ── Who actually imports this, and who does not ──
 *
 * `legalUpgradeBoot.test.js` does. The two editor suites do NOT: they were fixed
 * in parallel on `main` (`d6d7259`) with equivalent local helpers, and that
 * version was taken at the merge rather than replaced — the guard asserts the
 * PROPERTY, not the mechanism, and both spellings satisfy it. Rewriting two
 * green files to route through this module would be churn for symmetry's sake.
 * A new caller should import this rather than write a third helper.
 *
 * Imports nothing, so any suite can take it without paying for a database or a
 * server.
 */

/** One day, in milliseconds. */
const DAY = 86400000;

/**
 * A `YYYY-MM-DD` date `n` days from now, in UTC.
 *
 * UTC on purpose: `parseEffectiveAt` compares against `dayOf(new Date())`, which
 * is also UTC, so a local-time date would disagree with the validator by a day
 * for anybody west of Greenwich for part of every day — which is the same class
 * of intermittent failure this module exists to end.
 *
 * `daysAhead(0)` is today, the earliest date a publish accepts without relying
 * on the validator's one day of slack — and it is the whole interface. A `today()`
 * wrapper was here and had no callers: `main`'s version of the editor suites
 * defines its own, so the only importer writes `daysAhead(120)` and `daysAhead(150)`.
 * One export nobody has to choose between. Ascending values preserve the ordering
 * that rule 3 — effective dates only move forward — makes load-bearing when
 * several revisions of one document are published in sequence.
 */
export const daysAhead = (n = 0) =>
  new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
