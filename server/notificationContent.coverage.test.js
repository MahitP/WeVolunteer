import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import {
  EVENT_CATEGORIES, NOTIFICATION_PRIORITY, getInAppContent, MANDATORY_NOTICE_EVENTS
} from './services/notificationContent.js';

/**
 * Regression cover for the P0 audit finding: a dispatched notification event
 * with no content mapping silently became "Notification / You have a new
 * notification."
 *
 * `APPLICATION_WAITLISTED` was dispatched from three places and appeared in
 * neither EVENT_CATEGORIES nor the getInAppContent switch, so it fell through to
 * `default:`. Every waitlisted volunteer got placeholder copy, filed under
 * SYSTEM (invisible under the Applications filter), with no link, at NORMAL
 * priority so the 30-day retention sweep deleted it.
 *
 * Nothing failed. No test asserted that dispatched events are mapped, so the
 * gap was invisible to a green suite — the notification was *delivered*, it just
 * said nothing. That is the failure mode this file exists to prevent: it derives
 * the list of dispatched events from the source itself, so a new
 * `dispatch('SOMETHING_NEW', …)` added without copy fails the build rather than
 * shipping a placeholder.
 */

const SERVER = path.join(process.cwd(), 'server');

/**
 * Pulls event names out of one file's source.
 *
 * Extracted from the walkers below so the pattern itself is testable — see "the
 * dispatch scanner itself" at the bottom of this file for why that matters.
 *
 * All three quote styles are accepted. The original pattern was single-quote only,
 * so `dispatch("NEW_EVENT", …)` was invisible to it, and with no quote-style lint
 * rule configured that spelling passes every check in the repository.
 */
/**
 * Comments removed before matching, because `\s*` does not match a comment.
 *
 * This repository's convention is to explain a non-obvious argument at the
 * argument, which puts a JSDoc block between `dispatch(` and the event name —
 * exactly where it blinds a whitespace-tolerant pattern. Commit b8434fd did
 * that to ACCOUNT_SUSPENDED and removed the platform's most consequential
 * mandatory notice from this file's coverage without failing anything.
 *
 * Stripping is cruder than parsing and knowingly so: it will also blank a
 * `//` sequence inside a string literal. That costs nothing here, because the
 * only thing read out of the result is a SCREAMING_SNAKE argument to a known
 * call, and a false negative would show up as a missing event in the
 * real-tree assertion at the bottom of this file.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

export function matchDispatchedEventNames(src) {
  const names = [];
  for (const m of stripComments(src).matchAll(/dispatch\(\s*['"`]([A-Z0-9_]+)['"`]/g)) names.push(m[1]);
  return names;
}

/** The same, for the indirect `notifyConfirmedVolunteers(id, EVENT, …)` form. */
export function matchIndirectEventNames(src) {
  const names = [];
  for (const m of stripComments(src).matchAll(/notifyConfirmedVolunteers\(\s*[^,]+,\s*['"`]([A-Z0-9_]+)['"`]/g)) names.push(m[1]);
  return names;
}

/** Every `dispatch('EVENT_NAME', …)` literal across the server. */
function dispatchedEvents() {
  const found = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
      const src = readFileSync(full, 'utf8');
      for (const name of matchDispatchedEventNames(src)) {
        if (!found.has(name)) found.set(name, new Set());
        found.get(name).add(path.relative(process.cwd(), full));
      }
    }
  };
  walk(SERVER);
  return found;
}

/**
 * Events dispatched with a runtime variable rather than a literal, so the scan
 * above cannot see them. `notifyConfirmedVolunteers(eventId, EVENT_NAME, …)`
 * forwards its second argument straight to dispatch().
 */
function indirectlyDispatchedEvents() {
  const found = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
      const src = readFileSync(full, 'utf8');
      for (const name of matchIndirectEventNames(src)) {
        if (!found.has(name)) found.set(name, new Set());
        found.get(name).add(path.relative(process.cwd(), full));
      }
    }
  };
  walk(SERVER);
  return found;
}

/** A payload rich enough that no case has to cope with undefined. */
const SAMPLE = {
  eventId: 'event-1',
  eventTitle: 'Food Pantry Boxing',
  slotName: 'Morning crew',
  location: 'SB Food Pantry Hall',
  countdownPhrase: 'tomorrow',
  applicantsText: '3 applicants are',
  nextStep: 'Review them.',
  hours: 3,
  waitlistRank: 2,
  volunteerName: 'Priya Patel',
  changes: ['location'],
  conversationId: 'conv-1',
  senderName: 'Jordan Whitfield',
  title: 'Operational alert',
  body: 'Something happened that you should know about.',
  link: '/settings?section=privacy',
  reason: 'Violation of Community Guidelines',
  token: 'mock-token-12345',
  /**
   * The appeal-decision payload. Added when the MANDATORY-notice block below
   * first ran and found `Here is why:\n\nundefined\n\nReviewed by undefined.`
   *
   * That is a fixture gap, not a product defect — `appealsRoutes.js` always
   * passes both, and supplies its own fallback for the reviewer name. But this
   * object's contract is "rich enough that no case has to cope with undefined",
   * and it was two fields short of that, which is why the appeal notices could
   * not be added to the coverage battery until now.
   */
  reasoning: 'The messages you sent after being asked to stop were the reason.',
  reviewerName: 'a WeVolunteer administrator'
};

const ALL_PRIORITIES = Object.values(NOTIFICATION_PRIORITY);
const VALID_CATEGORIES = ['APPLICATION', 'EVENT', 'VOLUNTEER', 'ACCOUNT', 'SYSTEM', 'MESSAGES'];

describe('every dispatched notification event is fully mapped', () => {
  const direct = dispatchedEvents();
  const indirect = indirectlyDispatchedEvents();
  const all = new Map([...direct, ...indirect]);

  it('finds the dispatch sites at all (guards the scan itself)', () => {
    // If the regex ever stops matching, every assertion below would vacuously
    // pass. Anchor on events known to be dispatched.
    expect(all.size).toBeGreaterThan(15);
    expect([...all.keys()]).toContain('APPLICATION_WAITLISTED');
    expect([...all.keys()]).toContain('APPLICATION_ACCEPTED');
    // Proves the indirect scan works: these are only ever passed as a variable.
    expect([...all.keys()]).toContain('EVENT_CANCELLED');
    expect([...all.keys()]).toContain('EVENT_UPDATED');
  });

  for (const [event, where] of [...all].sort()) {
    describe(event, () => {
      const from = [...where].join(', ');

      it('has a category in EVENT_CATEGORIES', () => {
        expect(EVENT_CATEGORIES[event], `dispatched from ${from}`).toBeDefined();
        expect(VALID_CATEGORIES).toContain(EVENT_CATEGORIES[event]);
      });

      it('does not fall through to the generic fallback', () => {
        const c = getInAppContent(event, SAMPLE);
        expect(c.title, `dispatched from ${from}`).not.toBe('Notification');
        expect(c.body).not.toBe('You have a new notification.');
      });

      it('has a non-empty title and body', () => {
        const c = getInAppContent(event, SAMPLE);
        expect(typeof c.title).toBe('string');
        expect(c.title.trim().length).toBeGreaterThan(0);
        expect(typeof c.body).toBe('string');
        expect(c.body.trim().length).toBeGreaterThan(0);
      });

      it('carries a category matching its EVENT_CATEGORIES entry', () => {
        const c = getInAppContent(event, SAMPLE);
        expect(VALID_CATEGORIES).toContain(c.kind);
      });

      it('declares a known priority', () => {
        const c = getInAppContent(event, SAMPLE);
        expect(ALL_PRIORITIES).toContain(c.priority);
      });

      it('has a link, since every notification here has somewhere to go', () => {
        const c = getInAppContent(event, SAMPLE);
        expect(c.link, `dispatched from ${from}`).toBeTruthy();
      });

      it('interpolates its payload rather than leaving "undefined" in the copy', () => {
        const c = getInAppContent(event, SAMPLE);
        expect(`${c.title} ${c.body}`).not.toMatch(/undefined|null|\[object Object\]/);
      });
    });
  }
});

/**
 * The mandatory notices, covered WITHOUT going through the source scanner.
 *
 * ── Why this is separate from the block above ──
 *
 * Everything above derives its subject set from the source: it scans for
 * `dispatch('X', …)` and asserts that X is mapped. That is the right shape for
 * catching a newly added event, but it inherits every blind spot the scanner
 * has — and a scanner over source text will always have some.
 *
 * Two blind spots are already proven. A comment between `dispatch(` and the
 * event name hid ACCOUNT_SUSPENDED (see "the dispatch scanner itself" below,
 * now fixed). And `appealsRoutes.js` picks its event with a ternary:
 *
 *     decision === 'reversed' ? 'APPEAL_DECISION_REVERSED' : 'APPEAL_DECISION_STANDS'
 *
 * which is a runtime value, not a literal argument. No literal scanner can see
 * that, and no reasonable one should try. Both appeal-decision notices —
 * the message telling a suspended student whether they are getting their
 * account back — were therefore covered by nothing in this file.
 *
 * So this block inverts the derivation. It takes MANDATORY_NOTICE_EVENTS, the
 * registry of notices the product has committed to delivering whatever the
 * recipient's preferences say, and asserts the full content battery against
 * every member. It cannot be defeated by how a dispatch is spelled, because it
 * never reads the dispatch.
 *
 * These are the notices where placeholder copy is most damaging: each one is
 * sent to someone who is locked out, being warned, or waiting on an appeal, and
 * each is delivered over an explicit opt-out. "You have a new notification",
 * with no link, to a suspended student, is the worst version of the failure
 * this whole file exists to prevent.
 */
describe('every MANDATORY notice is fully mapped, however it is dispatched', () => {
  it('has members to check (guards against an empty registry)', () => {
    expect(MANDATORY_NOTICE_EVENTS.size).toBeGreaterThanOrEqual(7);
  });

  for (const event of [...MANDATORY_NOTICE_EVENTS].sort()) {
    describe(event, () => {
      const why = `${event} is a MANDATORY notice: it is delivered over the recipient's `
        + 'opt-out because they must receive it, which makes placeholder copy indefensible';

      it('has a category in EVENT_CATEGORIES', () => {
        expect(EVENT_CATEGORIES[event], why).toBeDefined();
        expect(VALID_CATEGORIES).toContain(EVENT_CATEGORIES[event]);
      });

      it('does not fall through to the generic fallback', () => {
        const c = getInAppContent(event, SAMPLE);
        expect(c.title, why).not.toBe('Notification');
        expect(c.body, why).not.toBe('You have a new notification.');
      });

      it('has a non-empty title and body, a known priority, and a link', () => {
        const c = getInAppContent(event, SAMPLE);
        expect(c.title.trim().length, why).toBeGreaterThan(0);
        expect(c.body.trim().length, why).toBeGreaterThan(0);
        expect(ALL_PRIORITIES, why).toContain(c.priority);
        expect(c.link, why).toBeTruthy();
      });

      it('interpolates its payload rather than leaving "undefined" in the copy', () => {
        const c = getInAppContent(event, SAMPLE);
        expect(`${c.title} ${c.body}`, why).not.toMatch(/undefined|null|\[object Object\]/);
      });

      /**
       * A mandatory notice must outlive the 30-day retention sweep, which
       * deletes NORMAL-priority notifications. A suspension notice that expires
       * while the suspension is still in force leaves the person with no record
       * of what they were told or how to appeal it.
       */
      it('is above NORMAL priority, so the retention sweep cannot delete it', () => {
        const c = getInAppContent(event, SAMPLE);
        expect(c.priority, why).not.toBe(NOTIFICATION_PRIORITY.NORMAL);
      });
    });
  }
});

describe('notification copy quality invariants', () => {
  it('waitlisting explains what the waitlist means', () => {
    const c = getInAppContent('APPLICATION_WAITLISTED', SAMPLE);
    expect(c.kind).toBe('APPLICATION');
    expect(c.title).toMatch(/waitlist/i);
    expect(c.body).toMatch(/withdraw|spot/i);
    // Must outlive the 30-day sweep, like acceptance does.
    expect(c.priority).toBe(NOTIFICATION_PRIORITY.IMPORTANT);
    expect(c.link).toBe('event:event-1');
  });

  it('uses the waitlist rank when Auto Select provides one', () => {
    const withRank = getInAppContent('APPLICATION_WAITLISTED', SAMPLE);
    const without = getInAppContent('APPLICATION_WAITLISTED', { ...SAMPLE, waitlistRank: undefined });
    expect(withRank.body).toMatch(/number 2/);
    expect(without.body).not.toMatch(/number/);
    expect(without.body).not.toMatch(/undefined/);
  });

  it('keeps cancellation at CRITICAL so retention can never sweep it', () => {
    expect(getInAppContent('EVENT_CANCELLED', SAMPLE).priority)
      .toBe(NOTIFICATION_PRIORITY.CRITICAL);
  });

  it('tells the organizer who was promoted', () => {
    const c = getInAppContent('WAITLIST_PROMOTION_MADE', SAMPLE);
    expect(c.kind).toBe('APPLICATION');
    expect(c.body).toMatch(/Priya Patel/);
  });
});

/**
 * The scanner above is the guard. This block guards the guard.
 *
 * ── The finding ──
 *
 * `dispatchedEvents()` matched `/dispatch\(\s*'([A-Z0-9_]+)'/g` — single quotes
 * only. Proven by mutation: appending
 *
 *     notificationService.dispatch("TOTALLY_UNMAPPED_EVENT", {}, 'u1')
 *
 * to notificationService.js left this whole file green (166 passed), while the same
 * line with single quotes correctly failed. `.oxlintrc.json` enables only
 * `react/rules-of-hooks` and `react/only-export-components`, so there is no
 * quote-style rule to make single quotes the only possibility — double quotes pass
 * lint and pass this guard.
 *
 * ── Why it matters ──
 *
 * This file's own header promises that a new unmapped dispatch "fails the build
 * rather than shipping a placeholder". That promise is the reason nobody re-checks
 * notification copy by hand. An unmapped event falls through `getInAppContent`'s
 * `default:` and the student receives literally "Notification / You have a new
 * notification." with no link, the wrong category, and NORMAL priority so the
 * 30-day sweep deletes it — audit finding F-3, which shipped exactly once already.
 * A guard that silently covers two thirds of the ways to write the call is worse
 * than no guard, because it is trusted.
 */
describe('the dispatch scanner itself', () => {
  const QUOTE_STYLES = [
    { label: 'single quotes', src: "dispatch('PROBE_EVENT', {}, 'u')" },
    { label: 'double quotes', src: 'dispatch("PROBE_EVENT", {}, "u")' },
    { label: 'backticks', src: 'dispatch(`PROBE_EVENT`, {}, "u")' },
    { label: 'whitespace before the quote', src: "dispatch(  'PROBE_EVENT' , {})" },
    { label: 'newline before the argument', src: "dispatch(\n  'PROBE_EVENT',\n  {}\n)" },
    /**
     * ── The second finding, and the reason this list grew ──
     *
     * `\s*` matches whitespace. It does not match a comment. So a JSDoc block
     * placed between `dispatch(` and its event name makes the call invisible
     * here — and this repository's convention is to explain a non-obvious
     * argument at the argument, which puts the comment in exactly that spot.
     *
     * That is not hypothetical. Commit b8434fd added a comment explaining why
     * `suspendedUntil` rides along in the payload, and in doing so removed
     * ACCOUNT_SUSPENDED — the most consequential mandatory notice on the
     * platform — from this file's coverage. Nothing failed. The suite stayed
     * green because the guard had simply stopped looking.
     *
     * The lesson is not "do not comment arguments". It is that a source scanner
     * has to tolerate the house style, or the house style will silently defeat
     * it.
     */
    { label: 'a block comment before the argument', src: "dispatch(\n  /** why */\n  'PROBE_EVENT', {}\n)" },
    { label: 'a line comment before the argument', src: "dispatch(\n  // why\n  'PROBE_EVENT', {}\n)" }
  ];

  for (const { label, src } of QUOTE_STYLES) {
    it(`finds a dispatch written with ${label}`, () => {
      expect(
        matchDispatchedEventNames(src),
        `the scanner cannot see a dispatch written with ${label}, so an unmapped `
        + 'event written that way would ship placeholder copy undetected'
      ).toContain('PROBE_EVENT');
    });
  }

  it('finds an indirect dispatch through notifyConfirmedVolunteers in any quote style', () => {
    expect(matchIndirectEventNames("notifyConfirmedVolunteers(id, 'PROBE_EVENT', {})")).toContain('PROBE_EVENT');
    expect(matchIndirectEventNames('notifyConfirmedVolunteers(id, "PROBE_EVENT", {})')).toContain('PROBE_EVENT');
  });

  it('does not match a lowercase or mixed-case argument', () => {
    // Event names are SCREAMING_SNAKE by convention; matching anything else would
    // make the scanner report noise and train people to ignore it.
    expect(matchDispatchedEventNames("dispatch('notAnEvent', {})")).toEqual([]);
  });

  it('actually scans the real server tree and finds the known events', () => {
    // Guards against the scanner silently returning nothing — e.g. after a
    // directory move — which would make every mapping assertion vacuous.
    const names = [...dispatchedEvents().keys()];
    expect(names).toContain('APPLICATION_ACCEPTED');
    expect(names).toContain('APPLICATION_WAITLISTED');
    expect(names.length).toBeGreaterThan(10);
  });
});
