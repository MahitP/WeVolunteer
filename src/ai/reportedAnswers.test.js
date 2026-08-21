import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiMock = vi.hoisted(() => ({
  fetchVolunteerStats: vi.fn(),
  fetchCertificates: vi.fn(),
  fetchOrganizations: vi.fn(),
  fetchApplications: vi.fn(),
  fetchEventsFiltered: vi.fn(),
  verifyCertificate: vi.fn(),
  withdrawApplication: vi.fn(),
}));
vi.mock('../utils/api', () => ({ api: apiMock }));

const { routeIntent } = await import('./router.js');
const { ask } = await import('./assistant.js');
const { MockRuntime } = await import('./runtime/MockRuntime.js');
import { withHours } from '../testFixtures/volunteerStats.js';

/**
 * Two answers from the reported transcript that were not the model's fault.
 *
 * Most of that report is fixed at one place — the model no longer writes the
 * sentence over a lookup, see the note at the end of `assistant.js`. These two
 * would have survived it, because the wrong answer was computed correctly from
 * the wrong question.
 */

const STUDENT = { id: 'u1', role: 'student', name: 'Maya Rivera', verified: true, withheld: [] };

const APPLICATIONS = [
  { id: 'a1', event: { title: 'Beach Cleanup' }, status: 'accepted' },
  { id: 'a2', event: { title: 'Food Bank' }, status: 'accepted' },
  { id: 'a3', event: { title: 'Library Help' }, status: 'rejected' },
  { id: 'a4', event: { title: 'Park Day' }, status: 'pending' },
];

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.fetchApplications.mockResolvedValue(APPLICATIONS);
  apiMock.fetchVolunteerStats.mockResolvedValue(withHours(0, 0));
});

describe('"Rejected Applications?" returned accepted ones', () => {
  /**
   * Not a hallucination. `my_applications` matched on the word "applications"
   * and produced no slots at all, so the tool returned every application and
   * the card listed accepted ones under a question about rejected ones. The
   * sentence — "You have applied to 4 opportunities" — was true and beside the
   * point.
   */
  it('asks the tool for the status the question named', async () => {
    expect(routeIntent('Rejected Applications?').slots).toEqual({ status: 'rejected' });

    const res = await ask('Rejected Applications?', { runtime: null, user: STUDENT });

    expect(res.card.data.total).toBe(1);
    expect(res.card.data.items.map(a => a.status)).toEqual(['rejected']);
    expect(res.answer).toBe('You have 1 rejected application.');
  });

  it('reads a negation as rejected, not as accepted', async () => {
    /* "not accepted" and "wasn't accepted" both contain "accepted". Testing
       accepted first answers the exact opposite of the question. */
    for (const text of [
      'which applications were not accepted',
      'show my declined applications',
      "applications I didn't get picked for",
      'show the applications I was declined for',
    ]) {
      expect(routeIntent(text).slots, text).toEqual({ status: 'rejected' });
    }
  });

  it('names the status when the filtered answer is empty', async () => {
    apiMock.fetchApplications.mockResolvedValue([APPLICATIONS[0]]);
    const res = await ask('show my rejected applications', { runtime: null, user: STUDENT });

    /* "You have not applied to anything yet" would be a different claim, and a
       false one — they have applied to something. */
    expect(res.answer).toBe('You have no rejected applications.');
    expect(res.card.data.total).toBe(0);
  });

  it('leaves an unfiltered question exactly as it was', async () => {
    const res = await ask('show my applications', { runtime: null, user: STUDENT });
    expect(res.answer).toBe('You have applied to 4 opportunities.');
    expect(res.card.data.total).toBe(4);
  });
});

describe('"sure" answered as a failed confirmation', () => {
  /**
   * Reported: Welly said "You have no verified hours. I can help find them for
   * you." The student replied "sure" and was told "There is no pending action
   * to confirm."
   *
   * Two faults in one exchange. The offer was the model paraphrasing a tool
   * result and is fixed at the source. This is the other half: "yes", "sure"
   * and "go ahead" are matched by `confirm_action`, which is right while a
   * draft is waiting and wrong the rest of the time — and they are also the
   * ordinary words for agreeing with something that was just said. The reply
   * was an error report about a mechanism the reader had no idea existed.
   */
  it('treats agreement with nothing pending as agreement', async () => {
    for (const word of ['sure', 'yes', 'go ahead', 'yeah']) {
      const res = await ask(word, { runtime: null, user: STUDENT });
      expect(res.intent, word).toBe('affirmation');
      expect(res.answer, word).not.toMatch(/pending action|confirm/i);
    }
  });

  it('still confirms when there is something to confirm', async () => {
    apiMock.withdrawApplication.mockResolvedValue({ ok: true });

    const draft = await ask('withdraw my application for app-999', { runtime: null, user: STUDENT });
    expect(draft.draft).toBe(true);

    const res = await ask('sure', { runtime: null, user: STUDENT });
    expect(res.intent).toBe('confirm_action');
    expect(apiMock.withdrawApplication).toHaveBeenCalledWith('app-999');
  });

  it('does not let a second "sure" run the same action twice', async () => {
    apiMock.withdrawApplication.mockResolvedValue({ ok: true });
    await ask('withdraw my application for app-999', { runtime: null, user: STUDENT });
    await ask('sure', { runtime: null, user: STUDENT });

    const again = await ask('sure', { runtime: null, user: STUDENT });
    expect(again.intent).toBe('affirmation');
    expect(apiMock.withdrawApplication).toHaveBeenCalledTimes(1);
  });

  it('lets the model answer the agreement when one is loaded', async () => {
    /* `affirmation` is in the conversational set, so a loaded model gets to
       reply naturally instead of the page reading out a canned line. */
    const rt = new MockRuntime({ responses: ['Great — want me to look for shifts near you?'] });
    await rt.load({ id: 'm', version: 1, bytes: 10 });

    const res = await ask('sure', { runtime: rt, user: STUDENT });
    expect(rt.calls).toHaveLength(1);
    expect(res.answer).toBe('Great — want me to look for shifts near you?');
  });
});
