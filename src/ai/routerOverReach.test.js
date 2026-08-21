import { describe, it, expect } from 'vitest';
import { routeIntent } from './router';

/**
 * Mentioning a thing is not asking for it.
 *
 * ── The defect ──
 *
 * Welly's subject matter is volunteering, so almost every sentence a student
 * types contains one of its nouns. Several tool rules fire on a domain noun
 * plus a very weak second signal, which is cheap and mostly right — and wrong
 * in one recognisable class:
 *
 *   "I am nervous about my first volunteering shift. Any advice?"
 *      → routed as an opportunity search
 *      → answered "I couldn't find any opportunities matching that."
 *
 * The student asked for reassurance and got an empty search result. Five more
 * of the same shape were found in a twenty-sentence sample, all of them
 * ordinary things to say to an assistant.
 *
 * ── The two halves of the fix ──
 *
 * `SEARCH_INTENT` no longer treats a bare "any" as evidence of a search; the
 * word has to reach the thing being asked for. And a guard before the tool
 * matchers recognises advice-seeking and first-person experience, which is
 * what those sentences have in common — not a keyword.
 *
 * ── What must NOT change ──
 *
 * The structured half of this file is the other side of the bargain. A guard
 * that suppressed real requests would be a worse bug than the one it fixes, so
 * every intent that has a probe in `intentCoverage.test.js` is re-checked here
 * against its natural phrasing.
 */

const conversational = text => expect(routeIntent(text).intent, text).toBe('unknown');

describe('talking about volunteering is not a search for it', () => {
  const CASES = [
    'I am nervous about my first volunteering shift. Any advice?',
    'I have a volunteer shift tomorrow. Any advice?',
    'Any tips for a first time volunteer?',
    'Do you have any advice about my first event?',
    'What should I wear to a volunteer shift?',
    'Is it normal to feel tired after a long shift?',
    'Should I sign up for more hours?',
    'Do you think volunteering looks good on a college application?',
  ];
  for (const text of CASES) it(`asks for advice: "${text}"`, () => conversational(text));
});

describe('telling Welly what happened is not a lookup', () => {
  const CASES = [
    'I volunteered at an event yesterday and it was exhausting.',
    'I missed my shift and I feel terrible about it.',
    'Our organization is planning something big and I am excited.',
    'I am thinking about volunteering more hours next semester.',
    'It was really tough at the event today.',
    'I loved the food drive last weekend.',
    'I am worried I will not know anyone at the event.',
    'I am so proud of the hours I did this term.',
  ];
  for (const text of CASES) it(`narrates: "${text}"`, () => conversational(text));
});

/**
 * The guard is applied AFTER refusals, informational answers, action requests
 * and eligibility, so a sentence can seek advice and still be one of those.
 */
describe('the guard does not swallow the categories decided before it', () => {
  it('still refuses a request for somebody else, however politely framed', () => {
    expect(routeIntent("I am worried about my friend — should I look at their hours?").intent)
      .toBe('refuse_other_user_data');
  });

  it('still answers an informational question that also asks what to do', () => {
    expect(routeIntent('How does Auto Select work, and should I bother applying?').intent)
      .toBe('info_selection');
  });

  it('still treats an eligibility question as one', () => {
    expect(routeIntent('Do you think driving my sister to practice counts towards my hours?').intent)
      .toBe('eligibility_question');
  });

  it('still honours a confirmation, which is never an incidental match', () => {
    expect(routeIntent('confirm').intent).toBe('confirm_action');
    expect(routeIntent('cancel').intent).toBe('cancel_action');
  });

  it('still honours an explicit navigation request', () => {
    expect(routeIntent('take me to my applications').intent).toBe('navigate');
  });
});

describe('every structured request still reaches its tool', () => {
  const CASES = [
    ['Show me volunteer opportunities', 'search_opportunities'],
    ['Find volunteering opportunities near me', 'search_opportunities'],
    ['Any opportunities this weekend?', 'search_opportunities'],
    ['any #environment or #gardening opportunities', 'search_opportunities'],
    ['are there any open shifts', 'search_opportunities'],
    ['How many hours do I have?', 'my_hours'],
    ['Show my applications', 'my_applications'],
    ['What is my next shift?', 'my_next_shift'],
    ['what am I waitlisted for?', 'my_waitlists'],
    ['Show my certificates', 'my_certificates'],
    ['What clubs am I in?', 'my_organizations'],
    ['Show my notifications', 'my_notifications'],
    ['Show my profile', 'my_profile'],
    ['Show my events', 'my_events'],
    ['Which of my events still need volunteers?', 'my_vacant_events'],
    ['Show my organizer statistics', 'organizer_summary'],
    ['Show safety reports summary', 'admin_reports_summary'],
    ['Show open appeals', 'admin_appeals_summary'],
    ['check certificate WEV-1234-5678', 'verify_certificate'],
  ];
  for (const [text, intent] of CASES) {
    it(`"${text}" → ${intent}`, () => {
      expect(routeIntent(text).intent).toBe(intent);
    });
  }

  it('keeps the slots a search depends on', () => {
    /* Suppression must not quietly cost the search its arguments. */
    expect(routeIntent('find volunteering opportunities near me').slots.wantsNearby).toBe(true);
    expect(routeIntent('any #environment or #gardening opportunities').slots.tags)
      .toEqual(['environment', 'gardening']);
  });
});
