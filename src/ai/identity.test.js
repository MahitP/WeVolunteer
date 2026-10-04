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

  /**
   * ── The one privacy claim must not be the one place Welly overstates ──
   *
   * This answer said "nothing you type here is sent anywhere". True of
   * inference, and false of the feature: `search_opportunities` takes the
   * residual words of the typed sentence — `searchTopic` in `router.js` strips
   * codes, tags, time phrases and asking-words and KEEPS the rest — and sends
   * them as `q` to `GET /api/events` (`tools.js`), where `shouldUseSemantic`
   * may hand them to Pinecone to be embedded server-side.
   *
   * The product had already decided not to say this. `WellyView.jsx` records
   * it beside the composer footer, about the very sentence: "Nothing leaves
   * your device … is not true of the whole feature … Saying the stronger thing
   * here would make the assistant's one privacy claim the one place it
   * overstates itself." The footer follows that; this answer did not.
   *
   * So: keep the on-device claim, which is true and is the point, and drop the
   * absolute one.
   */
  it('does not claim that nothing typed is ever sent anywhere', async () => {
    const rt = await loudRuntime('irrelevant');
    const res = await ask('who trained you?', { runtime: rt, user: STUDENT });

    expect(
      res.answer,
      'Welly claims nothing typed is sent anywhere, which a search question disproves',
    ).not.toMatch(/nothing you type[^.]*sent anywhere/i);
  });

  it('says where a lookup actually goes, rather than leaving it out', async () => {
    const rt = await loudRuntime('irrelevant');
    const res = await ask('who trained you?', { runtime: rt, user: STUDENT });

    /* The honest half the footer already tells people: a lookup is answered by
       WeVolunteer's server, exactly as the rest of the app is. */
    expect(res.answer).toMatch(/WeVolunteer'?s server|answered by WeVolunteer/i);
  });

  /**
   * With NO model loaded, which is a different string.
   *
   * `identityAnswer` falls back to `FIXED.identity_self` whenever the runtime
   * is not READY — Welly Chat, a model still downloading, a device that cannot
   * run one at all. The first version of the case above used a loaded runtime
   * only, so restoring the old claim in `FIXED.identity_self` left the suite
   * green: the mutation check caught that, and this is the half it was missing.
   */
  /**
   * ── Nor "not sent to any AI service" ──
   *
   * The narrowed answer still said "your words are not sent to any AI
   * service". Pinecone runs a hosted embedding model over the words a search
   * sends, so that was the same overstatement in other words (owner,
   * 2026-10-04). What is true: no AI service writes the replies, and a search
   * sends the words searched for. Both answers are checked, loaded and not.
   */
  it('says a search sends the words searched for, and nothing broader', async () => {
    const rt = await loudRuntime('irrelevant');
    const answers = [
      (await ask('who trained you?', { runtime: rt, user: STUDENT })).answer,
      (await ask('who trained you?', { user: STUDENT })).answer,
    ];
    for (const answer of answers) {
      expect(answer).toMatch(/a search sends the words you searched for/);
      expect(answer).not.toMatch(/not sent to any AI service/i);
    }
  });

  it('makes the same narrowed claim with no model loaded', async () => {
    const res = await ask('who trained you?', { user: STUDENT });

    expect(res.answer).toMatch(/on your own device/i);
    expect(
      res.answer,
      'the no-model fallback still claims nothing typed is sent anywhere',
    ).not.toMatch(/nothing you type[^.]*sent anywhere/i);
    expect(res.answer).toMatch(/WeVolunteer'?s server|answered by WeVolunteer/i);
  });

  /**
   * ── Naming the model that is running, not a model ──
   *
   * The sentence said "Qwen2.5 0.5B" whatever was loaded. Somebody who had
   * chosen the Advanced model — which is Qwen2.5 1.5B — and asked Welly what it
   * was running was told the name of the other one. That is the answer people
   * ask for precisely when they are checking whether the model they picked is
   * the model they got, so it is the worst one to have fixed.
   */
  it('names the model that is loaded, not always the smallest', async () => {
    const { modelForTier } = await import('./models.js');
    const advanced = modelForTier('advanced');

    const rt = new MockRuntime();
    await rt.load(advanced);
    const res = await ask('what model are you running', { runtime: rt, user: STUDENT });

    expect(res.answer).toMatch(/1\.5B/);
    expect(res.answer).not.toMatch(/0\.5B/);
  });

  it('names the Balanced model when that is the one loaded', async () => {
    const { modelForTier } = await import('./models.js');
    const rt = new MockRuntime();
    await rt.load(modelForTier('balanced'));
    const res = await ask('what model are you running', { runtime: rt, user: STUDENT });

    expect(res.answer).toMatch(/0\.5B/);
    expect(res.answer).not.toMatch(/1\.5B/);
  });

  it('names no model at all when none is loaded', async () => {
    const res = await ask('what model are you running', { user: STUDENT });

    expect(res.answer).toMatch(/WeVolunteer/);
    expect(res.answer).not.toMatch(/Qwen|SmolLM|\dB\b/);
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
