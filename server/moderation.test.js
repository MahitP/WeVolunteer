/**
 * The report taxonomy, tested without a database.
 *
 * ── Why this file exists at all ──
 *
 * `server/evidenceHolds.js:59` already tells the reader, in a comment, that
 * `LIVE_REPORT_STATUSES` is "asserted equal in `server/moderation.test.js` so
 * the two cannot drift". That file did not exist. The constant is genuinely
 * declared twice — once in `moderation.js` (which owns the taxonomy) and once in
 * `evidenceHolds.js` (which owns what the taxonomy means for deletion) — and
 * nothing was keeping them in step, so a fifth status added to one and not the
 * other would have quietly produced a report the queue treats as live and the
 * delete holds treat as closed. The comment described a guard nobody had
 * written; this is the guard.
 *
 * Everything here is a pure-module test, deliberately. `moderation.js` imports
 * nothing — no db, no config — for the same reason `authz.js` does not, and that
 * is what lets the categories, the per-target filter and the priority derivation
 * be exercised without booting a listener or opening a database.
 */

import { describe, it, expect } from 'vitest';

import {
  CATEGORY_PRIORITY,
  CATEGORY_VALUES,
  CLOSED_REPORT_STATUSES,
  EVIDENCE_CONTEXT_AFTER,
  EVIDENCE_CONTEXT_BEFORE,
  LIVE_REPORT_STATUSES,
  MAX_DESCRIPTION_LENGTH,
  REPORT_CATEGORIES,
  REPORT_PRIORITIES,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  categoriesForTarget,
  derivePriority,
  isValidCategory,
  normalizeTargetType,
} from './moderation.js';
import {
  LIVE_REPORT_STATUSES as HOLD_LIVE_STATUSES,
  RETAINABLE_MESSAGE_PREDICATE,
} from './evidenceHolds.js';

describe('status taxonomy', () => {
  /**
   * The drift guard `evidenceHolds.js` claims in prose.
   *
   * Two modules, one fact. `moderation.js` decides what a status means to the
   * queue; `evidenceHolds.js` decides what it means to the delete holds and the
   * retention sweep. A status that is live in one and closed in the other is an
   * open investigation whose evidence is deletable — silent, and the exact
   * failure PR-1 existed to end.
   */
  it('agrees with evidenceHolds.js about which statuses are live', () => {
    expect([...LIVE_REPORT_STATUSES].sort()).toEqual([...HOLD_LIVE_STATUSES].sort());
  });

  it('partitions every status into exactly one of live or closed', () => {
    expect([...LIVE_REPORT_STATUSES, ...CLOSED_REPORT_STATUSES].sort())
      .toEqual([...REPORT_STATUSES].sort());
    for (const s of LIVE_REPORT_STATUSES) {
      expect(CLOSED_REPORT_STATUSES, `${s} is in both halves`).not.toContain(s);
    }
  });

  /**
   * `escalated` is a status and not a priority, and the consequence that makes
   * the distinction load-bearing is this one: a report that has left the queue
   * for a phone call to DCP&P is the last thing whose evidence should become
   * deletable.
   */
  it('treats escalated as live, not closed', () => {
    expect(LIVE_REPORT_STATUSES).toContain('escalated');
    expect(RETAINABLE_MESSAGE_PREDICATE).toContain("'escalated'");
  });
});

describe('categories', () => {
  it('has a unique stored value and a label for every category', () => {
    expect(new Set(CATEGORY_VALUES).size).toBe(CATEGORY_VALUES.length);
    for (const c of REPORT_CATEGORIES) {
      expect(c.value, 'stored values are snake_case and never displayed').toMatch(/^[a-z_]+$/);
      expect(c.label.length, `${c.value} has no label`).toBeGreaterThan(0);
    }
  });

  /**
   * A category with no priority silently derives `normal`, which on this
   * taxonomy is how "someone wants to meet me alone" would end up in the same
   * lane as spam. Deriving from a lookup that may miss is fine; not noticing the
   * miss is not.
   */
  it('assigns every category a priority from the closed set', () => {
    for (const value of CATEGORY_VALUES) {
      expect(REPORT_PRIORITIES, `${value} derives an unknown priority`)
        .toContain(CATEGORY_PRIORITY[value]);
    }
    for (const key of Object.keys(CATEGORY_PRIORITY)) {
      expect(CATEGORY_VALUES, `${key} has a priority but is not a category`).toContain(key);
    }
  });

  it('accepts every taxonomy value and refuses anything else', () => {
    for (const value of CATEGORY_VALUES) expect(isValidCategory(value)).toBe(true);
    for (const junk of ['', 'OTHER', 'made_up', null, undefined, 0, {}, []]) {
      expect(isValidCategory(junk), `${JSON.stringify(junk)} was accepted`).toBe(false);
    }
  });

  /**
   * The Youth Safety Guidelines say in terms: "If a conversation makes you
   * uneasy and you cannot say exactly why, that is reason enough to report it."
   * Making the vaguest option the first one in the list is the whole design, so
   * it is asserted rather than left to whoever next edits the array.
   */
  it('pins something_feels_wrong first and other last', () => {
    expect(REPORT_CATEGORIES[0].value).toBe('something_feels_wrong');
    expect(REPORT_CATEGORIES[REPORT_CATEGORIES.length - 1].value).toBe('other');
  });
});

describe('target types', () => {
  it('maps the organizer alias onto user and refuses unknown types', () => {
    expect(normalizeTargetType('organizer')).toBe('user');
    for (const t of REPORT_TARGET_TYPES) expect(normalizeTargetType(t)).toBe(t);
    for (const junk of ['', 'group', null, undefined, 7, {}]) {
      expect(normalizeTargetType(junk), `${JSON.stringify(junk)} was accepted`).toBeNull();
    }
  });

  /**
   * The per-target filter is UI-only and the server must not enforce it. This
   * asserts the shape of the offer, not a server rule: a mismatch is a mis-tap,
   * and 400-ing a distressed student over a category/target combination is worse
   * in every way than filing a slightly mis-categorised report.
   */
  it('offers every category for a message or a conversation', () => {
    for (const t of ['message', 'conversation']) {
      expect(categoriesForTarget(t).map(c => c.value)).toEqual(CATEGORY_VALUES);
    }
  });

  it('narrows the offer for a certificate to the two that can apply', () => {
    expect(categoriesForTarget('certificate').map(c => c.value))
      .toEqual(['fake_hours_or_certificate', 'other']);
  });

  it('never offers an empty list for any target type, including junk', () => {
    for (const t of [...REPORT_TARGET_TYPES, 'organizer', 'nonsense', null, undefined]) {
      expect(categoriesForTarget(t).length, `${String(t)} offers nothing`).toBeGreaterThan(0);
    }
  });

  it('always leaves a route to `other`, so nothing is unreportable', () => {
    for (const t of [...REPORT_TARGET_TYPES, 'organizer']) {
      expect(categoriesForTarget(t).map(c => c.value), `${t} cannot reach 'other'`)
        .toContain('other');
    }
  });

  it('only ever offers values the server will accept', () => {
    for (const t of [...REPORT_TARGET_TYPES, 'organizer', 'nonsense']) {
      for (const c of categoriesForTarget(t)) {
        expect(isValidCategory(c.value), `${t} offers ${c.value}, which the server refuses`)
          .toBe(true);
      }
    }
  });
});

describe('priority derivation', () => {
  it('derives from the category, never from the client', () => {
    expect(derivePriority({ category: 'threatened_me', reporterRole: 'student', targetRole: 'student' }))
      .toBe('urgent');
    expect(derivePriority({ category: 'spam_or_advertising', reporterRole: 'student', targetRole: 'student' }))
      .toBe('normal');
  });

  /**
   * The actor asymmetry, and why it is worth a lookup.
   *
   * A student who knows exactly which box to tick and a student who freezes at
   * the dropdown and picks the mildest-sounding thing are not in different
   * amounts of danger. Reports between peers are deliberately not floored:
   * student-on-student unpleasantness is real and is handled, but it is not the
   * asymmetry this platform exists to watch.
   */
  it('floors a student reporting an adult at urgent, whatever the category says', () => {
    for (const adult of ['organizer', 'admin', 'super_admin']) {
      expect(derivePriority({ category: 'spam_or_advertising', reporterRole: 'student', targetRole: adult }))
        .toBe('urgent');
    }
    expect(derivePriority({ category: 'spam_or_advertising', reporterRole: 'student', targetRole: 'student' }))
      .toBe('normal');
    expect(derivePriority({ category: 'spam_or_advertising', reporterRole: 'organizer', targetRole: 'organizer' }))
      .toBe('normal');
  });

  it('never lowers a priority the category already earned', () => {
    for (const category of CATEGORY_VALUES) {
      const base = CATEGORY_PRIORITY[category];
      for (const reporterRole of ['student', 'organizer', 'admin']) {
        for (const targetRole of ['student', 'organizer', 'admin', 'super_admin', null]) {
          const got = derivePriority({ category, reporterRole, targetRole });
          if (base === 'urgent') {
            expect(got, `${category} was lowered for ${reporterRole}->${targetRole}`).toBe('urgent');
          }
          expect(REPORT_PRIORITIES).toContain(got);
        }
      }
    }
  });

  it('falls back to normal rather than throwing on an unknown category', () => {
    expect(derivePriority({ category: 'not_a_category', reporterRole: 'student', targetRole: 'student' }))
      .toBe('normal');
  });
});

describe('bounds', () => {
  /**
   * Raised from the old 1000. A student describing a grooming conversation needs
   * room, and running out of characters mid-sentence is a bad thing to happen to
   * somebody who has worked up to typing it.
   */
  it('allows a description long enough to describe something that took a while', () => {
    expect(MAX_DESCRIPTION_LENGTH).toBe(2000);
  });

  /**
   * "Sure, whatever you want" means nothing on its own and everything after the
   * message before it. A single-line snapshot is the shape of evidence that gets
   * a report dismissed, which is why a message report captures both sides of it.
   */
  it('captures context either side of a reported message', () => {
    expect(EVIDENCE_CONTEXT_BEFORE).toBeGreaterThanOrEqual(10);
    expect(EVIDENCE_CONTEXT_AFTER).toBeGreaterThanOrEqual(10);
  });
});
