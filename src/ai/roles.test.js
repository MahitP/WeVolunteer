import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkRole, INTENT_CAPABILITY, abilitiesFor, actionReplyFor } from './roles.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const student = { id: 'u1', role: 'student' };
const organizer = { id: 'u2', role: 'organizer' };
const owner = { id: 'u3', role: 'super_admin' };

describe('every intent the router can produce is classified', () => {
  it('has no intent missing from the table', () => {
    /**
     * The failure this prevents is silent. An intent added to the router and
     * forgotten here would fall through to whatever the default is, and the
     * default that feels natural — allow — is the wrong one on a platform where
     * some intents read other people's records.
     *
     * Read from the router's source rather than from a hand-kept list, because
     * a hand-kept list is the thing that goes stale.
     */
    const src = readFileSync(path.join(HERE, 'router.js'), 'utf8');
    const intents = [...src.matchAll(/intent:\s*'([a-z_]+)'/g)].map(m => m[1]);
    expect(intents.length, 'no intents found — has the router changed shape?').toBeGreaterThan(5);

    const unclassified = [...new Set(intents)]
      .filter(name => !Object.prototype.hasOwnProperty.call(INTENT_CAPABILITY, name));

    expect(
      unclassified,
      'add these to INTENT_CAPABILITY in roles.js. An intent nobody classified is '
      + 'one nobody decided the audience for.',
    ).toEqual([]);
  });

  it('fails closed on an intent it does not recognise', () => {
    /* A typo in a matcher should be obvious and safe, not quietly open. Same
       reasoning authz.js gives for refusing an unrecognised capability. */
    const verdict = checkRole(owner, 'intent_that_does_not_exist');
    expect(verdict.allowed).toBe(false);
    expect(verdict.unknownIntent).toBe(true);
  });
});

describe('who may ask for what', () => {
  it('lets anyone signed in ask about their own record', () => {
    for (const intent of ['my_hours', 'my_certificates', 'my_next_shift', 'my_applications']) {
      expect(checkRole(student, intent).allowed, intent).toBe(true);
    }
  });

  it('keeps a student out of the organizer and platform tools', () => {
    for (const intent of ['my_events', 'organizer_summary', 'platform_stats', 'recent_audit']) {
      expect(checkRole(student, intent).allowed, intent).toBe(false);
    }
  });

  it('lets an organizer reach the organizer tools and no further', () => {
    expect(checkRole(organizer, 'my_events').allowed).toBe(true);
    /* Running events is not the same as running the platform. */
    expect(checkRole(organizer, 'platform_stats').allowed).toBe(false);
    expect(checkRole(organizer, 'recent_audit').allowed).toBe(false);
  });

  it('names the missing capability, so a refusal can be explained', () => {
    expect(checkRole(student, 'my_events').capability).toBe('event.create');
  });

  it('refuses everything role-gated when nobody is signed in', () => {
    expect(checkRole(null, 'my_events').allowed).toBe(false);
    /* Open intents stay open — `can` is what requires a user, and a signed-out
       reader has nothing of their own to look at anyway. */
    expect(checkRole(null, 'greeting').allowed).toBe(true);
  });
});

describe('what it offers instead', () => {
  it('lists only what the person can actually reach', () => {
    expect(abilitiesFor(student).join(' ')).not.toMatch(/events you run/i);
    expect(abilitiesFor(organizer).join(' ')).toMatch(/events you run/i);
    expect(abilitiesFor(owner).join(' ')).toMatch(/audit trail/i);
  });

  it('does not send a student to a page they cannot use', () => {
    /**
     * The original report: "I was on a student account and it said it'll make
     * an event for me". Telling them which page to create it on is the same
     * mistake in a quieter voice — it describes a door that will not open.
     */
    const reply = actionReplyFor(student, { kind: 'event' });
    expect(reply).toMatch(/organizers do/i);
    expect(reply).not.toMatch(/Create event page/i);
    /* And still points somewhere useful. */
    expect(reply).toMatch(/find one that already exists/i);
  });

  it('sends an organizer to the page', () => {
    expect(actionReplyFor(organizer, { kind: 'event' })).toMatch(/Create event page/i);
  });

  it('never claims Welly can act, whoever is asking', () => {
    for (const who of [student, organizer, owner, null]) {
      for (const kind of ['event', 'decision', 'other']) {
        expect(actionReplyFor(who, { kind })).toMatch(/can't create or change anything/i);
      }
    }
  });
});
