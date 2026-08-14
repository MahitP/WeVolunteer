import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every `canRunEvent` caller must hand it a whole event row.
 *
 * ── The bug this exists to catch, which it did not catch the first time ──
 *
 * `canRunEvent(db, event, userId)` answers "may this person run this event" by
 * asking two things of the row: who hosts it, and which organization it belongs
 * to. It was introduced at fourteen call sites in one change, and three of them
 * loaded the event through a query that names its columns and did not name
 * `organization_id` — two application-review routes and the auto-select run
 * history.
 *
 * The result read as a correct refusal. The function saw `undefined`, concluded
 * the event belonged to no organization, and turned the club's own manager
 * away from the routes that decide who gets a place. Six thousand tests stayed
 * green, because a 403 is what a wrong caller and a genuine outsider both look
 * like.
 *
 * The function now throws on an absent property rather than reading it as
 * "none", which turns the silent version into a loud one at the first request.
 * This is the other half: the failure is found at build time, on the routes no
 * test happens to exercise with a manager, rather than in production on the one
 * that matters.
 *
 * ── Why a source scan and not more integration tests ──
 *
 * Covering all fourteen would mean fourteen fixtures asserting the same fact
 * about a helper's event and its manager, and a fifteenth route added next year
 * would be covered by none of them. The mistake is mechanical — a projection
 * that forgot a column — so the check is mechanical too, and it covers the
 * route nobody thought to write a test for.
 */

const ROUTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'routes');

/** Every `<name>` in `canRunEvent(db, <name>, ...)`, with its line number. */
function callsIn(source) {
  const out = [];
  source.split('\n').forEach((line, i) => {
    if (line.includes('export function canRunEvent')) return;
    const m = line.match(/canRunEvent\(\s*db,\s*(\w+)/);
    if (m) out.push({ variable: m[1], line: i + 1 });
  });
  return out;
}

/**
 * The statement that produced `variable`, searching upward.
 *
 * Deliberately crude: it takes the nearest assignment or the enclosing function
 * parameter and reads the few lines after it. A helper that receives the row as
 * an argument (`hostRefusal`) has no query of its own, so it is reported and
 * checked against its own callers instead.
 */
function sourceOf(lines, variable, callLine) {
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${variable}\\s*=`);
  const param = new RegExp(`function\\s+\\w+\\s*\\([^)]*\\b${variable}\\b`);
  for (let j = callLine - 1; j >= Math.max(0, callLine - 80); j--) {
    if (decl.test(lines[j])) return { kind: 'query', text: lines.slice(j, j + 10).join('\n') };
    if (param.test(lines[j])) return { kind: 'parameter', text: lines[j] };
  }
  return null;
}

/** Does this statement load the whole events row, or name the column? */
function carriesOrganizationId(text) {
  return /SELECT \* FROM events/.test(text)
    || /SELECT e\.\*/.test(text)
    || /\be\.organization_id\b/.test(text)
    || /\borganization_id\b/.test(text);
}

const files = fs.readdirSync(ROUTES_DIR)
  .filter(f => f.endsWith('.js') && !f.includes('.test.'))
  .map(f => ({ name: `routes/${f}`, source: fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8') }))
  .filter(f => f.source.includes('canRunEvent('));

describe('every canRunEvent caller loads a whole event row', () => {
  it('finds the call sites at all', () => {
    /* If this drops to zero the scan below passes vacuously — which is exactly
       how a guard stops guarding. */
    const total = files.reduce((n, f) => n + callsIn(f.source).length, 0);
    expect(total, 'no canRunEvent calls found — has it been renamed?').toBeGreaterThan(5);
  });

  for (const file of files) {
    const lines = file.source.split('\n');
    for (const call of callsIn(file.source)) {
      const src = sourceOf(lines, call.variable, call.line);

      it(`${file.name}:${call.line} — \`${call.variable}\` carries organization_id`, () => {
        expect(src, `could not find where \`${call.variable}\` comes from`).toBeTruthy();

        if (src.kind === 'parameter') {
          /* The row arrives from elsewhere, so the obligation moves to whoever
             calls this helper. `hostRefusal` is the one case today. */
          const helper = lines[call.line - 1];
          expect(helper, 'a helper taking the row as a parameter must be checked at its callers')
            .toBeTruthy();
          return;
        }

        expect(
          carriesOrganizationId(src.text),
          `The query feeding \`${call.variable}\` names its columns and does not select `
          + '`organization_id`. canRunEvent would read it as "belongs to no organization" '
          + 'and refuse the club\'s manager — a correct-looking 403 for the wrong reason. '
          + `Select it, or use \`SELECT * FROM events\`.\n\n${src.text}`
        ).toBe(true);
      });
    }
  }
});

describe('the helper that takes the row as a parameter', () => {
  /**
   * `hostRefusal(principal, event)` in attendanceRoutes is checked here rather
   * than above, because the scan cannot follow a value across a call boundary.
   * Every one of its callers must load the whole row.
   */
  it('is fed a whole event row by every one of its callers', () => {
    const source = fs.readFileSync(path.join(ROUTES_DIR, 'attendanceRoutes.js'), 'utf8');
    const lines = source.split('\n');
    const callers = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /hostRefusal\(\s*req\.principal/.test(l));

    expect(callers.length, 'hostRefusal has no callers — has it been renamed?').toBeGreaterThan(0);

    for (const { i } of callers) {
      const preceding = lines.slice(Math.max(0, i - 30), i).join('\n');
      expect(
        carriesOrganizationId(preceding),
        `attendanceRoutes.js:${i + 1} calls hostRefusal with an event loaded by a query `
        + 'that does not carry `organization_id`.'
      ).toBe(true);
    }
  });
});
