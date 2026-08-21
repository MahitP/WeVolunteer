import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiMock = vi.hoisted(() => ({
  fetchVolunteerStats: vi.fn(),
  fetchCertificates: vi.fn(),
  fetchOrganizations: vi.fn(),
  fetchApplications: vi.fn(),
  fetchEventsFiltered: vi.fn(),
  verifyCertificate: vi.fn(),
}));
vi.mock('../utils/api', () => ({ api: apiMock }));

const { ask } = await import('./assistant.js');
const { MockRuntime } = await import('./runtime/MockRuntime.js');
const { asksForPersonalInfo, isUsableReply } = await import('./prompts/welly.js');

/**
 * Welly never asks a student to type personal information.
 *
 * ── The report ──
 *
 * "If ask for volunteering opportunities near you the chatbot/AI shouldn't ask
 * for ur location (obviously) it should use location if already given through
 * the app or tell the user to allow app to access location. Never ask the User
 * to type in personal information into that chat [Even If its on device] it
 * just makes us look sus."
 *
 * That last clause is the important one and it is right. On-device is invisible
 * from the reader's side: a chat window asking a fifteen-year-old for their
 * home address is the exact shape of the thing they are taught to be wary of,
 * and no privacy property of the runtime changes how it reads.
 *
 * ── Three layers, because one would not hold ──
 *
 *   1. The app already has coordinates when permission was granted, and they
 *      are already passed to the search. Nothing to fix.
 *   2. When it does not, the search used to run unlocated and say nothing —
 *      an ordinary list presented as though it had been sorted by distance.
 *      It now says so, and the view offers the browser's own permission
 *      button. `WellyView.location.test.jsx` covers that half.
 *   3. Free conversation can still reach for an address, because a general
 *      assistant reasonably would. `asksForPersonalInfo` rejects the reply and
 *      the written answer is shown instead — the same mechanism as
 *      `claimsAnAction`, for the same recorded reason: negative instructions
 *      do not hold at 0.5B.
 */

const HERE = { lat: 34.42, lng: -119.7 };
const STUDENT = { id: 'u1', role: 'student', name: 'Maya Rivera' };

async function readyRuntime(...responses) {
  const rt = new MockRuntime({ responses });
  await rt.load({ id: 'm', version: 1, bytes: 10 });
  return rt;
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.fetchEventsFiltered.mockResolvedValue({
    events: [{ id: 'e1', title: 'Beach Cleanup' }],
    pagination: { total: 1 },
  });
});

describe('a nearby search uses the location the app already has', () => {
  it('passes the coordinates through and says nothing about location', async () => {
    const res = await ask('find volunteering opportunities near me', {
      runtime: null, position: HERE, user: STUDENT,
    });

    const [args] = apiMock.fetchEventsFiltered.mock.calls[0];
    expect(args.lat).toBe(HERE.lat);
    expect(args.lng).toBe(HERE.lng);
    expect(res.needsLocation).toBeUndefined();
    expect(res.answer).toBe('I found 1 opportunity.');
  });
});

describe('a nearby search without one says so, and asks for nothing', () => {
  it('answers, marks the gap, and never requests an address', async () => {
    const res = await ask('find volunteering opportunities near me', {
      runtime: null, position: null, user: STUDENT,
    });

    /* Still a real answer — the results are correct, they are simply unsorted. */
    expect(res.card.data.total).toBe(1);
    expect(res.answer).toMatch(/^I found 1 opportunity\./);
    expect(res.answer).toMatch(/aren’t sorted by distance/);

    /* The flag the view turns into a permission button. */
    expect(res.needsLocation).toBe(true);

    /* And not one word of it asks the student for anything. */
    expect(asksForPersonalInfo(res.answer)).toBe(false);
    expect(res.answer).not.toMatch(/address|zip|postcode|what city|where do you live/i);
  });

  it('does not mark a search that was never about proximity', async () => {
    const res = await ask('find volunteering opportunities', {
      runtime: null, position: null, user: STUDENT,
    });
    expect(res.needsLocation).toBeUndefined();
    expect(res.answer).toBe('I found 1 opportunity.');
  });

  it('says the same thing whether or not a model is loaded', async () => {
    const rt = await readyRuntime('Sure — what is your address?');
    const res = await ask('find volunteering opportunities near me', {
      runtime: rt, position: null, user: STUDENT,
    });
    expect(rt.calls).toHaveLength(0);
    expect(res.needsLocation).toBe(true);
  });
});

describe('the model cannot ask for it either', () => {
  it('replaces a reply that asks for an address', async () => {
    const rt = await readyRuntime('I can help with that! What is your address?');
    const res = await ask('do you think volunteering is worth it', {
      runtime: rt, position: null, user: STUDENT,
    });

    expect(rt.calls).toHaveLength(1);
    expect(res.answer).not.toMatch(/your address/i);
    expect(res.phrasedByModel).toBe(false);
  });

  const ASKS = [
    'Sure! What is your address so I can find opportunities near you?',
    'Could you tell me your zip code?',
    'Where do you live?',
    'What city are you in?',
    'Please enter your address below.',
    'May I have your phone number?',
    'To help with that, share your email address with me.',
    'Can I get your full name?',
    'Type your location and I will search.',
  ];
  for (const reply of ASKS) {
    it(`rejects: ${reply}`, () => {
      expect(asksForPersonalInfo(reply)).toBe(true);
      expect(isUsableReply(reply)).toBe(false);
    });
  }

  const KEEPS = [
    /* The subject appearing is not the same as being asked for it. A rule that
       ate these would cost real answers to make a point. */
    'Your address is never shown to organizers.',
    'You can update your address in Settings under Profile.',
    'Opportunities are sorted by distance once you share your location.',
    'The organizer sets the location for each event.',
    'That shift is at 356 Ridge Rd.',
    'Events near you show a distance once location is on.',
    'I found 4 opportunities.',
  ];
  for (const reply of KEEPS) {
    it(`leaves alone: ${reply}`, () => {
      expect(asksForPersonalInfo(reply)).toBe(false);
      expect(isUsableReply(reply)).toBe(true);
    });
  }
});
