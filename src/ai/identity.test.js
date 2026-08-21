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

const { routeIntent } = await import('./router.js');
const { ask } = await import('./assistant.js');
const { MockRuntime } = await import('./runtime/MockRuntime.js');
import { withHours } from '../testFixtures/volunteerStats.js';

/**
 * Who Welly is, where "here" is, and who the reader is.
 *
 * ── The three answers ──
 *
 * Reported on 2026-08-21, all three from the on-device model, all three because
 * no rule matched and the question reached free conversation:
 *
 *   "who trained you"        → "I was trained in WeVolunteer and are
 *                               volunteers."
 *   "what is this place"     → "Welly, a place where students can volunteer."
 *   "what's my name"         → "Your name is Welly."
 *
 * The first is not a sentence with a true reading. The second takes Welly's own
 * name for the platform's — the place is called WeVolunteer. The third is the
 * worst of the set: asked whether the assistant knows who they are, a student
 * is told, confidently, that they are the assistant.
 *
 * ── Why rules and not a prompt line ──
 *
 * A prompt cannot supply the third answer at all: the model is never given the
 * reader's name, so the only thing an instruction could buy is a refusal. And
 * this codebase has repeatedly measured negative instructions failing to hold
 * at 0.5B. Each of these questions has exactly one correct answer, which makes
 * it code's job. The tests below use the reported phrasings verbatim so the
 * cases cannot be lost to paraphrase.
 */

/* A ready model that would answer if it were ever asked. Every assertion that
   it was not asked depends on it being available. */
async function loudRuntime(reply = 'Your name is Welly.') {
  const rt = new MockRuntime({ responses: [reply] });
  await rt.load({ id: 'm', version: 1, bytes: 10 });
  return rt;
}

const STUDENT = { id: 'u1', role: 'student', name: 'Maya Rivera' };

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.fetchVolunteerStats.mockResolvedValue(withHours(0, 0));
  apiMock.fetchEventsFiltered.mockResolvedValue({ events: [], pagination: { total: 0 } });
});

describe('what Welly is', () => {
  const CASES = [
    'who trained you?',
    'who made you',
    'who built you?',
    'what are you',
    'what model are you running',
    'are you chatgpt',
    'are you a language model',
    "what's your context window",
  ];
  for (const text of CASES) {
    it(`routes "${text}" to a written answer`, () => {
      expect(routeIntent(text).intent).toBe('identity_self');
    });
  }

  it('answers without asking the model, and names what it actually runs', async () => {
    const rt = await loudRuntime('I was trained in WeVolunteer and are volunteers.');
    const res = await ask('who trained you?', { runtime: rt, user: STUDENT });

    expect(rt.calls).toHaveLength(0);
    expect(res.answer).toMatch(/WeVolunteer/);
    expect(res.answer).toMatch(/not a person/i);
    /* On-device is the privacy claim the whole feature rests on, so it is said
       here rather than left for Settings to say. */
    expect(res.answer).toMatch(/on your own device/i);
  });
});

describe('what this place is', () => {
  const CASES = [
    'what is this app called?',
    "what's this website",
    'what is this platform',
    'what is this place',
    'where am I',
    'what is WeVolunteer',
  ];
  for (const text of CASES) {
    it(`routes "${text}" to a written answer`, () => {
      expect(routeIntent(text).intent).toBe('identity_platform');
    });
  }

  it('never gives Welly’s name as the name of the app', async () => {
    const rt = await loudRuntime('Welly, a place where students can volunteer.');
    const res = await ask('what is this app called?', { runtime: rt, user: STUDENT });

    expect(rt.calls).toHaveLength(0);
    expect(res.answer).toMatch(/WeVolunteer/);
    /* The distinction the model lost: the place has one name, the assistant
       has another. */
    expect(res.answer).not.toMatch(/^Welly[,.]/);
    expect(res.answer).toMatch(/Welly is just me|assistant inside it/i);
  });
});

describe('who the reader is', () => {
  for (const text of ["what's my name?", 'what is my name', 'do you know my name', 'who am I']) {
    it(`routes "${text}" to the session`, () => {
      expect(routeIntent(text).intent).toBe('my_name');
    });
  }

  it('reads the name off the session rather than generating one', async () => {
    const rt = await loudRuntime('Your name is Welly.');
    const res = await ask("what's my name?", { runtime: rt, user: STUDENT });

    expect(rt.calls).toHaveLength(0);
    expect(res.answer).toBe('You are signed in as Maya Rivera.');
  });

  it('says the record has no name rather than inventing one', async () => {
    const res = await ask("what's my name?", { runtime: null, user: { id: 'u2', role: 'student' } });
    expect(res.answer).toMatch(/does not have a name on it yet/);
    expect(res.answer).toMatch(/Settings/);
  });

  it('is the signed-in person and nobody else', async () => {
    /* "who am I" is answered from the session object. It takes no argument, so
       there is no phrasing of it that reaches another person's record. */
    const res = await ask('who am I', { runtime: null, user: STUDENT });
    expect(res.answer).toBe('You are signed in as Maya Rivera.');

    expect(routeIntent("what is Jordan's name").intent).not.toBe('my_name');
  });
});

describe('the rules stay in their lane', () => {
  it('still lists what Welly can do when asked that', () => {
    /* `capabilities` lost "what are you" to identity. "What can you do" is the
       question it was always for, and it must not have moved. */
    expect(routeIntent('what can you do?').intent).toBe('capabilities');
    expect(routeIntent('what do you help with').intent).toBe('capabilities');
  });

  it('leaves questions about the records alone', () => {
    for (const [text, notIntent] of [
      ['how many hours do I have', 'identity_self'],
      ['what is my next shift', 'my_name'],
      ['show my profile', 'my_name'],
      ['what events are near me', 'identity_platform'],
    ]) {
      expect(routeIntent(text).intent, text).not.toBe(notIntent);
    }
  });
});
