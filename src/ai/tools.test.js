import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOLS, TOOL_NAMES, PRIVACY } from './tools.js';

const SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools.js'),
  'utf8',
);

/**
 * The invariants `tools.js` claims about itself.
 *
 * Its header says "Nothing here writes. Every tool is read-only, and that is
 * asserted by a test." That test did not exist — there was no `tools.test.js` at
 * all, and nothing anywhere referenced `readOnly`. The property was true, and
 * nothing was keeping it true.
 *
 * That gap matters more than an ordinary missing test. The whole safety argument
 * for handing a 1.5B model a set of tools rests on the tools being incapable of
 * changing anything: the model never chooses them, and even if the routing were
 * wrong, the worst case is the wrong fact rather than the wrong action. A future
 * tool that posts, deletes or approves would quietly retire that argument, and
 * the only thing standing in its way was a sentence in a comment.
 */
describe('the tool registry cannot act, only look', () => {
  it('declares every tool read-only', () => {
    const writable = TOOL_NAMES.filter(name => TOOLS[name].readOnly !== true);
    expect(
      writable,
      'A tool that is not read-only breaks the argument that makes this assistant '
      + 'safe at this model size: the application picks the tool, so a wrong pick '
      + 'returns the wrong FACT. A tool that writes turns a wrong pick into a wrong '
      + 'ACTION. If a writing tool is genuinely wanted, it needs a confirmation step '
      + 'the person actually sees — not a quiet flip of this flag.',
    ).toEqual([]);
  });

  it('never reaches the network except through the shared api client', () => {
    /**
     * Every tool goes through `api.js`, which carries the session cookie, the
     * rate limits and the authorization the rest of the app is subject to. A
     * bare `fetch` here would be a second door into the server that none of that
     * applies to — and it would be reviewed as "the assistant", not as an
     * endpoint.
     */
    expect(SRC, 'call the shared api client rather than fetch directly').not.toMatch(/\bfetch\s*\(/);
    expect(SRC).not.toMatch(/XMLHttpRequest|navigator\.sendBeacon/);
  });

  it('uses no mutating HTTP method', () => {
    /* Belt and braces with the flag above: the flag is a declaration, this is
       the behaviour. A tool cannot write without one of these appearing. */
    expect(SRC).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i);
  });

  it('classifies every tool exposure level', () => {
    const unclassified = TOOL_NAMES.filter(
      name => !Object.values(PRIVACY).includes(TOOLS[name].privacy),
    );
    expect(
      unclassified,
      'Every tool states whether what it returns is public or the signed-in '
      + "person's own private record. An unclassified tool is one nobody decided "
      + 'about, on a platform whose users are minors.',
    ).toEqual([]);
  });

  it('bounds how many rows any tool can hand the model', () => {
    /**
     * `MAX_ROWS` is what keeps an answer an answer rather than an export. A tool
     * that slices by something else, or not at all, would put an unbounded slice
     * of somebody's record into a prompt.
     */
    /* Row slices only. The inline `.slice(0, 3)` on an event's tags is a
       different bound — how much of one row to show, not how many rows — and
       folding the two together would make this assertion mean nothing. */
    const rowSlices = [...SRC.matchAll(/\b(?:list|rows|items)\.slice\(0,\s*([A-Za-z_0-9]+)\)/g)]
      .map(m => m[1]);
    expect(rowSlices.length, 'no tool appears to bound its rows at all').toBeGreaterThan(0);
    expect(
      [...new Set(rowSlices)],
      'row limits must come from the shared MAX_ROWS, not from a number typed inline',
    ).toEqual(['MAX_ROWS']);
  });

  it('hands the model no raw UTC timestamp', () => {
    /**
     * Measured, not theorised. `my_next_shift` passed the slot's
     * `startDatetime` through untouched — `2026-08-31T11:30:00.000Z` — and the
     * 1.5B model answered "starting at 11:30 AM" for a shift the rest of the
     * app shows as 7:30 AM. A model has no timezone; it read the digits.
     *
     * Four hours out, stated with no hedge, about the one fact a student would
     * act on. So every date is converted here, where Intl does it correctly,
     * and the model only ever repeats a string that is already right.
     *
     * Asserted against the source because the failure is a field assignment,
     * and by the time a value reaches a caller the mistake is invisible.
     */
    const rawDates = [...SRC.matchAll(/^\s*(?:startsAt|at|deadline|issuedAt|startDatetime|endDatetime):\s*(.+)$/gm)]
      .map(m => m[1].trim())
      .filter(expr => !/^local(Moment|Day)\(/.test(expr));

    expect(
      rawDates,
      'pass dates through localMoment() or localDay(). A raw ISO string is in UTC, '
      + 'and the model will repeat its digits as if they were the local clock.',
    ).toEqual([]);
  });

  it('has a description for every tool', () => {
    /* These are read by people deciding what the assistant may do. A tool with
       no description is one that cannot be reviewed. */
    const undescribed = TOOL_NAMES.filter(
      name => typeof TOOLS[name].description !== 'string' || !TOOLS[name].description.trim(),
    );
    expect(undescribed).toEqual([]);
  });
});
