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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.join(HERE, 'routes');

/**
 * Helpers that take the event row as an argument, each with a block below
 * checking every one of their callers. A helper NOT named here fails, rather
 * than passing on nothing.
 */
const CHECKED_HELPERS = new Set(['hostRefusal']);

/**
 * Every `<name>` in `canRunEvent(db, <name>, …)`, with its line number.
 *
 * Matched over the whole source rather than line by line. A line-wise regex
 * silently missed a call whose arguments wrapped across lines — and a missed
 * call emits no assertion at all, so the starved query behind it would pass.
 */
function callsIn(source) {
  const out = [];
  const re = /canRunEvent\(\s*db\s*,\s*(\w+)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.push({ variable: m[1], line: source.slice(0, m.index).split('\n').length });
  }
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

/** Comments are prose, not a SELECT list. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Does this statement load the whole events row, or SELECT the column?
 *
 * ── Three ways this used to answer yes when the query said no ──
 *
 * The loose form matched `organization_id` anywhere in the ten-line window, and
 * this codebase writes a paragraph above almost every one of these calls — a
 * comment that merely mentioned the column satisfied the guard.
 *
 * `ON org.id = e.organization_id` is a join condition, not a selected column,
 * and that idiom already appears in `eventRoutes.js`. So the search is bounded
 * to the text between `SELECT` and `FROM`, which is the only place a column can
 * actually be selected.
 */
function carriesOrganizationId(text) {
  const code = stripComments(text);
  if (/SELECT\s+\*\s+FROM\s+events/i.test(code)) return true;
  if (/SELECT\s+e\.\*/i.test(code)) return true;
  for (const m of code.matchAll(/\bSELECT\b([\s\S]*?)\bFROM\b/gi)) {
    if (/\borganization_id\b/.test(m[1])) return true;
  }
  return false;
}

/**
 * `server/routes/` AND `server/` itself.
 *
 * `canRunEvent` is exported, and the messaging module calls it — a scan of the
 * routes directory alone could not see that site, so a starved query there would
 * have been invisible to this file. The definition lives in `organizations.js`
 * and is skipped by name.
 */
const SOURCES = [
  ...fs.readdirSync(ROUTES_DIR)
    .filter(f => f.endsWith('.js') && !f.includes('.test.'))
    .map(f => ({ name: `routes/${f}`, full: path.join(ROUTES_DIR, f) })),
  ...fs.readdirSync(HERE)
    .filter(f => f.endsWith('.js') && !f.includes('.test.') && f !== 'organizations.js')
    .map(f => ({ name: f, full: path.join(HERE, f) })),
];

const files = SOURCES
  .map(f => ({ name: f.name, source: fs.readFileSync(f.full, 'utf8') }))
  .filter(f => f.source.includes('canRunEvent('));

describe('every canRunEvent caller loads a whole event row', () => {
  it('finds the call sites at all', () => {
    /* If this drops to zero the scan below passes vacuously — which is exactly
       how a guard stops guarding. */
    const total = files.reduce((n, f) => n + callsIn(f.source).length, 0);
    /* Pinned near the real count rather than loosely above zero: at `> 5`, a
       dozen call sites could disappear and this would still pass — the same
       vacuity the file exists to prevent. Raise it when sites are added; a drop
       means a call was missed, renamed or removed. */
    expect(total, 'canRunEvent call sites moved — recount and update this floor')
      .toBeGreaterThanOrEqual(19);
  });

  for (const file of files) {
    const lines = file.source.split('\n');
    for (const call of callsIn(file.source)) {
      const src = sourceOf(lines, call.variable, call.line);

      it(`${file.name}:${call.line} — \`${call.variable}\` carries organization_id`, () => {
        expect(src, `could not find where \`${call.variable}\` comes from`).toBeTruthy();

        if (src.kind === 'parameter') {
          /**
           * The row arrives from elsewhere, so the obligation moves to whoever
           * calls this helper — and it must be a helper this file actually
           * checks. This used to assert `lines[call.line - 1]` is truthy: that
           * is the line containing the call, always a non-empty string, always
           * true. A second helper in any file would have passed on nothing.
           */
          const name = src.text.match(/function\s+(\w+)/)?.[1];
          expect(
            Boolean(name && CHECKED_HELPERS.has(name)),
            `\`${name}\` takes the event row as a parameter, so this scan cannot see the `
            + 'query behind it. Add a describe block checking its callers, then add its '
            + 'name to CHECKED_HELPERS.'
          ).toBe(true);
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
