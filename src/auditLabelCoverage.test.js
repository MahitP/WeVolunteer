import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { auditTone, hasAuditLabel, TONES } from './views/auditFormat.js';

/**
 * Every audit action the server can write must read as a sentence.
 *
 * ── Why a static guard rather than a list somebody maintains ──
 *
 * The Audit Explorer's filter derives its options from the trail itself — a
 * `SELECT DISTINCT action`, so a new action appears in the dropdown the first
 * time it is written, with no client change. That is the right design and it is
 * also the trap: the *label* map is hardcoded, so a new action shows up in the
 * filter and on the page in raw SCREAMING_SNAKE, looking like a bug to the only
 * person who ever reads the page.
 *
 * That is not hypothetical. This guard was written because three actions had
 * already drifted — `ADMIN_INVITED`, `ADMIN_INVITE_ACCEPTED`,
 * `ADMIN_INVITE_REVOKED` were being written by `invitationRoutes.js` and had no
 * labels, so the most consequential rows on the platform (somebody was handed
 * administrator authority) rendered as the ugliest.
 *
 * So the authoritative source is the server source, and the client is checked
 * against it. The alternative — importing the server's action constants into the
 * client bundle — would be stronger, but `recordAudit` takes literals at ~30 call
 * sites across 14 route modules and there is no single registry to import. A
 * scan of the call sites is what "derive from the authoritative source" can
 * actually mean here, and the failure it prevents is real.
 *
 * ── What it does NOT check ──
 *
 * That a label is *good*. `auditLabel` falls back to title-casing the action, so
 * an unlabelled `ADMIN_INVITED` would render as "Admin invited" rather than
 * garbage — readable, but it loses the distinction between inviting and
 * promoting, and it silently assigns the routine tone to a grave act. The named
 * grave assertions at the bottom are the part that catches the second half.
 */

const SERVER_DIR = path.resolve(__dirname, '../server');
const BIN_DIR = path.resolve(__dirname, '../bin');

/** Files that write the trail. Tests excluded — a test's fake action is not a product action. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...sourceFiles(full)); continue; }
    if (!/\.(js|mjs)$/.test(entry.name)) continue;
    if (entry.name.includes('.test.')) continue;
    out.push(full);
  }
  return out;
}

/**
 * Action literals passed to an audit writer.
 *
 * Matches `action: 'X'` rather than the whole `recordAudit(` call, because the
 * argument is built as an object literal at every call site and the object is
 * sometimes assembled a line or two above the call. Matching the property is
 * both simpler and harder to evade by accident.
 */
function declaredActions() {
  const found = new Map();   // action -> first file that writes it
  const files = [...sourceFiles(SERVER_DIR), ...sourceFiles(BIN_DIR)];

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/action:\s*['"`]([A-Z][A-Z0-9_]{2,})['"`]/g)) {
      if (!found.has(m[1])) found.set(m[1], path.relative(path.resolve(__dirname, '..'), file));
    }
    /* The CLI scripts route their actions through a frozen constant rather than a
       literal, precisely so the four commands cannot disagree about spelling.
       Resolve those names from the constant's definition. */
    for (const m of src.matchAll(/CLI_EVENTS\.([A-Z_]+)/g)) {
      if (!found.has(m[1])) found.set(m[1], path.relative(path.resolve(__dirname, '..'), file));
    }
  }
  return found;
}

describe('audit action label coverage', () => {
  const actions = declaredActions();

  it('finds the actions at all, so an empty scan cannot pass vacuously', () => {
    /* If a refactor moves audit writing somewhere this regex cannot see, the two
       tests below would pass by checking nothing. This is the tripwire. */
    expect(actions.size).toBeGreaterThan(20);
    expect([...actions.keys()]).toContain('ACCOUNT_SUSPENDED');
    expect([...actions.keys()]).toContain('ADMIN_INVITED');
  });

  it('gives every action a hand-written label', () => {
    /* Membership, not a comparison against the fallback's output. A good label
       frequently *is* the title-cased action — "Account deleted" for
       `ACCOUNT_DELETED` — so inferring absence from the rendered string reports
       five correct labels as missing. Asked the table directly instead. */
    const unlabelled = [...actions].filter(([action]) => !hasAuditLabel(action));

    expect(
      unlabelled.map(([a, f]) => `${a} (written in ${f})`),
      'These audit actions render in the Audit Explorer with no human-readable '
      + 'label. Add each to ACTIONS in src/views/auditFormat.js with a past-tense '
      + 'sentence and a tone.',
    ).toEqual([]);
  });

  /* There is deliberately no "every action has a valid tone" case here. It reads
     like the natural companion to the one above and it would assert nothing:
     `auditTone` answers `routine` for anything absent from the table, so the
     check passes for an action nobody has ever labelled. Vacuous guards are worse
     than missing ones — they earn the confidence without doing the work. The
     named cases below are the real assertion, on the rows where the tone decides
     whether an owner finds them. */

  /**
   * The two graves, asserted by name.
   *
   * Locking somebody out and reading their private messages are the two things
   * this platform does that a person cannot undo, and the tone is how an owner
   * finds them in a year of rows. A well-meant "let's calm the page down" pass
   * that demoted these would pass every other test in this file.
   */
  it.each([
    'ACCOUNT_SUSPENDED',
    'REPORT_EVIDENCE_VIEWED',
    'ADMIN_PROMOTED',
    'ADMIN_INVITED',
    'OWNER_GRANTED',
  ])('keeps %s grave', (action) => {
    expect(auditTone(action)).toBe(TONES.GRAVE);
  });
});
