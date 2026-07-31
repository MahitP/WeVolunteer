import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { EVENT_CATEGORIES, NOTIFICATION_PRIORITY, getInAppContent } from './services/notificationContent.js';

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
export function matchDispatchedEventNames(src) {
  const names = [];
  for (const m of src.matchAll(/dispatch\(\s*['"`]([A-Z0-9_]+)['"`]/g)) names.push(m[1]);
  return names;
}

/** The same, for the indirect `notifyConfirmedVolunteers(id, EVENT, …)` form. */
export function matchIndirectEventNames(src) {
  const names = [];
  for (const m of src.matchAll(/notifyConfirmedVolunteers\(\s*[^,]+,\s*['"`]([A-Z0-9_]+)['"`]/g)) names.push(m[1]);
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
  senderName: 'Jacquelyn Katzenback',
  title: 'Operational alert',
  body: 'Something happened that you should know about.',
  link: '/settings?section=privacy'
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
    { label: 'newline before the argument', src: "dispatch(\n  'PROBE_EVENT',\n  {}\n)" }
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
