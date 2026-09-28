import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PAGE_META, tabForPath, pageMetaFor } from './App.jsx';
import { adminIsPaused } from './utils/adminPaused';

/**
 * The topbar does not contradict the page underneath it.
 *
 * ── The bug ──
 *
 * The Admin Responsibilities Policy gate renders inside `/admin/moderation`:
 * an administrator who has not accepted it sees the acceptance screen there
 * instead of the reports queue, the approvals list and the platform totals,
 * and that screen says in as many words that administration is paused.
 *
 * The topbar above it went on reading "Every administrative area you can open",
 * because `PAGE_META` is a static table keyed on persona and tab and knows
 * nothing about a withholding. So the screen made two claims about itself, and
 * the confidently-worded one was the false one — the reader is told they can
 * open every administrative area by the same screen refusing to open any.
 *
 * ── Why the rule lives in `pageMetaFor` ──
 *
 * `pageMetaFor` is what BOTH the topbar and `documentTitle` call. An override
 * written at either render site would have fixed that one and left the other
 * still contradicting the page — the browser tab and the heading disagreeing
 * is the same bug wearing a different hat.
 */

/** `personaFor` strips `withheld` before resolving, so this is still `staff`. */
const admin = (over = {}) => ({ id: 'u-adm', role: 'admin', ...over });

/** The capability the policy withholds, and the one the Admin route is gated on. */
const paused = (over = {}) => admin({ withheld: ['report.resolve'], ...over });

const metaFor = (user) => pageMetaFor(user, tabForPath('/admin/moderation'));

describe('the Admin subtitle tells the truth about the gate', () => {
  it('resolves /admin/moderation to the tab the rule is written against', () => {
    /* If this ever stops being `moderation`, every assertion below would pass
       against the fallback meta while testing nothing. */
    expect(tabForPath('/admin/moderation')).toBe('moderation');
  });

  it('says administration is paused when the policy is outstanding', () => {
    expect(metaFor(paused()).sub).toMatch(/paused/i);
    expect(metaFor(paused()).sub).toMatch(/Admin Responsibilities Policy/);
  });

  it('does not promise administrative areas the gate will not open', () => {
    /* The bug as the reader met it, pinned to the real string rather than a
       paraphrase of it, so rewording the static entry cannot quietly revive it. */
    expect(metaFor(paused()).sub).not.toBe(PAGE_META.staff.moderation.sub);
  });

  it('leaves the title alone — the page is still Admin', () => {
    /* Only the claim that was wrong changes. The title is read by the static
       coverage guards and by the browser tab, and "Admin" is still correct. */
    expect(metaFor(paused()).title).toBe(PAGE_META.staff.moderation.title);
  });

  it('restores the normal subtitle once the policy is accepted', () => {
    /* An accepted admin carries no withholding, and must read exactly as an
       admin did before the gate existed. */
    expect(metaFor(admin())).toEqual(PAGE_META.staff.moderation);
  });

  it('is confined to the Admin tab', () => {
    /* The withholding covers fourteen capabilities across several pages; only
       the one whose BODY is replaced by the gate may caption itself paused. */
    for (const tab of ['dashboard', 'events', 'profile']) {
      expect(pageMetaFor(paused(), tab)).toEqual(pageMetaFor(admin(), tab));
    }
  });

  it('is confined to this one withholding', () => {
    /* An organizer with an outstanding agreement also carries withholdings.
       They never reach this tab, and must not have its caption rewritten. */
    expect(metaFor(admin({ withheld: ['event.create'] })))
      .toEqual(PAGE_META.staff.moderation);
  });
});

/**
 * The topbar and the page body must not be able to drift apart again.
 *
 * Both answers come from `adminIsPaused`. A test of behaviour cannot catch a
 * future edit that re-inlines the check in one of them — the two would agree on
 * the day it was written and diverge on the day somebody changed a capability —
 * so this reads the source and asserts the single source is still single.
 */
describe('one answer, not two matching expressions', () => {
  const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

  it.each([
    ['src/App.jsx', 'the topbar caption'],
    ['src/views/ModerationCenter.jsx', 'the gate-or-tiles choice'],
  ])('%s asks adminIsPaused rather than re-deriving it', (file) => {
    const src = read(file);
    expect(src).toMatch(/adminIsPaused\(/);

    /* The inlined form this file exists to prevent. Comments legitimately name
       the capability — several here do — so this looks for the EXPRESSION. */
    const inlined = /withheld[^\n]*\.includes\(\s*'report\.resolve'/;
    expect(
      inlined.test(src),
      `${file} re-derives "is administration paused" inline instead of calling `
      + 'adminIsPaused. Two copies of that check is exactly the bug this file '
      + 'was written for: the topbar said "Every administrative area you can '
      + 'open" over a page saying administration was paused.',
    ).toBe(false);
  });

  it('agrees with the shell for every case above', () => {
    /* The predicate and the meta rule tested independently, so a green suite
       cannot mean only that both were changed to the same wrong thing. */
    expect(adminIsPaused({ withheld: ['report.resolve'] })).toBe(true);
    expect(adminIsPaused({ withheld: ['event.create'] })).toBe(false);
    expect(adminIsPaused({})).toBe(false);
    expect(adminIsPaused(null)).toBe(false);
  });
});
