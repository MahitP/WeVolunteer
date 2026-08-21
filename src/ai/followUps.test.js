import { describe, it, expect } from 'vitest';
import { ask, sanitizeHistory } from './assistant';
import { routeIntent } from './router';
import { checkRole } from './roles';

/**
 * Follow-ups: the turns that mean nothing on their own.
 *
 * ── What this is guarding ──
 *
 * "why?" used to route to `info_hours`, which is a fixed two-paragraph
 * explanation of verified and external hours. That is the right answer after an
 * answer about hours and the wrong one after every other answer — ask about
 * certificates, say "why?", and read about hours instead.
 *
 * Meanwhile `assistant.js` already listed `followup_why`, `reaction` and
 * `talk_check` as conversational intents and `getConversationalReply` already
 * handled all three from the previous turn. Nothing routed to them, and nothing
 * could have: they were missing from `INTENT_CAPABILITY`, so `checkRole` would
 * have returned `unknownIntent` and REFUSED the turn — a student typing "why?"
 * would have been told it was not something their account can ask for.
 */

const student = { id: 'stu-1', role: 'student', withheld: [] };

/** The two turns that came before, as the page would pass them. */
function after(assistantSaid, userAsked = 'a question') {
  return [
    { role: 'user', text: userAsked },
    { role: 'assistant', text: assistantSaid },
  ];
}

describe('the intents that answer from context are reachable at all', () => {
  for (const intent of ['followup_why', 'reaction']) {
    it(`${intent} is a known intent, so the turn is not refused`, () => {
      const decision = checkRole(student, intent);
      expect(decision.unknownIntent).toBeUndefined();
      expect(decision.allowed).toBe(true);
    });
  }

  /**
   * `talk_check` was added to the capability table alongside the other two, on
   * the assumption that it was the third of a set. It is not: the router has
   * never emitted it, and smalltalk is folded into `greeting` by SMALLTALK and
   * answered from there. The entry was removed rather than made reachable, and
   * this is the assertion that it stays gone — a capability entry for an intent
   * nothing produces says a path exists when it does not.
   */
  it('does not carry an entry for talk_check, which nothing produces', () => {
    expect(checkRole(student, 'talk_check').unknownIntent).toBe(true);
  });

  it('answers smalltalk anyway, through greeting', async () => {
    const res = await ask('can you talk?', { user: student, history: [] });
    expect(res.intent).toBe('greeting');
    expect(res.answer).toMatch(/chat|talk/i);
  });
});

describe('routing a short follow-up', () => {
  const followUps = ['why?', 'Why?', 'how come?', 'why not?', 'Why do I have zero?'];
  for (const text of followUps) {
    it(`"${text}" is a follow-up, not a question about hours`, () => {
      expect(routeIntent(text).intent).toBe('followup_why');
    });
  }

  it('a real question that happens to start with "why" is left alone', () => {
    /* Long enough to be its own question rather than a reference to the last
       one. The boundary is deliberate; see the rule in router.js. */
    expect(routeIntent('Why do volunteers need training before a shift?').intent)
      .not.toBe('followup_why');
  });

  it('a direct question about hours still gets the hours explanation', () => {
    expect(routeIntent('how do hours work?').intent).toBe('info_hours');
    expect(routeIntent('what are verified hours?').intent).toBe('info_hours');
  });

  it('an interjection is a reaction', () => {
    expect(routeIntent('oof').intent).toBe('reaction');
    expect(routeIntent('bummer').intent).toBe('reaction');
    expect(routeIntent('nice!').intent).toBe('reaction');
  });
});

describe('answering a follow-up from what was said last', () => {
  it('explains hours when the previous answer was about hours', async () => {
    const res = await ask('Why do I have zero?', {
      user: student,
      history: after('You do not have any verified hours yet.', 'How many hours do I have?'),
    });
    expect(res.answer).toMatch(/organizer marks your attendance/i);
  });

  it('explains applications when the previous answer was about applications', async () => {
    const res = await ask('why?', {
      user: student,
      history: after('You have applied to 2 opportunities.', 'Show my applications'),
    });
    expect(res.answer).toMatch(/pending|organizer reviews/i);
    expect(res.answer).not.toMatch(/External Service Hours/i);
  });

  it('explains certificates when the previous answer was about certificates', async () => {
    const res = await ask('how come?', {
      user: student,
      history: after('You do not have any certificates yet.', 'Show my certificates'),
    });
    expect(res.answer).toMatch(/certificate/i);
    expect(res.answer).not.toMatch(/External Service Hours/i);
  });

  it('explains the draw when the follow-up is about selection', async () => {
    const res = await ask('why was I not selected?', {
      user: student,
      history: after('You have applied to 1 opportunity.'),
    });
    expect(res.answer).toMatch(/Auto Select|waitlist/i);
  });

  it('never answers a follow-up with the refusal for an unrecognised request', async () => {
    for (const text of ['why?', 'how come?', 'Why do I have zero?', 'oof']) {
      const res = await ask(text, {
        user: student,
        history: after('You do not have any verified hours yet.'),
      });
      expect(res.answer).not.toMatch(/I can't help with that one/i);
      expect(res.answer).not.toMatch(/not something your account can ask/i);
    }
  });

  it('reacts to disappointment with the next step rather than with hours policy', async () => {
    const res = await ask('oof', {
      user: student,
      history: after('You do not have any verified hours yet.'),
    });
    expect(res.answer).toMatch(/attend|organizer|find an upcoming event/i);
  });
});

describe('a follow-up with nothing to follow up on', () => {
  it('still answers rather than refusing', async () => {
    const res = await ask('why?', { user: student, history: [] });
    expect(typeof res.answer).toBe('string');
    expect(res.answer.length).toBeGreaterThan(10);
    expect(res.answer).not.toMatch(/not something your account can ask/i);
  });
});

/**
 * What the model is allowed to read back.
 *
 * ── The defect ──
 *
 * Some assistant turns are the interface speaking about a failure rather than
 * Welly answering: "I can't help with that one", "That is not something your
 * account can ask me for", "Something went wrong", "Stopped." They reach the
 * transcript through the same `role: 'assistant'` door as a real reply.
 *
 * A small model reads the history as a record of how the assistant talks, and
 * imitates it. Measured against Qwen2.5-0.5B on 2026-08-21: in a conversation
 * where an earlier turn had fallen back, a fresh question was answered with the
 * fallback reproduced word for word — a refusal the application had written,
 * handed back as though the model had decided it.
 */
describe('application notices do not become things the model imitates', () => {
  it('marks the fallback for an unrecognised request as a notice', async () => {
    const res = await ask('qwertyuiop asdfghjkl zxcvbnm', { user: student });
    expect(res.answer).toMatch(/I can't help with that one/i);
    expect(res.systemNotice).toBe(true);
  });

  it('marks a role refusal as a notice', async () => {
    const res = await ask('show the recent audit log', { user: student });
    expect(res.intent).toBe('not_permitted');
    expect(res.systemNotice).toBe(true);
  });

  it('does NOT mark a real answer as a notice', async () => {
    /* The deterministic answers carry facts the next turn depends on. */
    for (const q of ['hello', 'what can you do?', 'how do hours work?', 'thanks']) {
      const res = await ask(q, { user: student });
      expect(res.systemNotice, q).toBeFalsy();
    }
  });

  it('keeps notices out of the history handed to the model', () => {
    const history = [
      { role: 'user', text: 'how many hours do I have?' },
      { role: 'assistant', text: 'You do not have any verified hours yet.' },
      { role: 'user', text: 'something it did not understand' },
      { role: 'assistant', text: "I can't help with that one. I can look up opportunities…", systemNotice: true },
    ];
    const sent = sanitizeHistory(history);
    const assistantTurns = sent.filter(m => m.role === 'assistant').map(m => m.content);

    /* The refusal is gone… */
    expect(assistantTurns).not.toContain("I can't help with that one. I can look up opportunities…");
    /* …the real answer is not, because "why?" next turn depends on it… */
    expect(assistantTurns).toContain('You do not have any verified hours yet.');
    /* …and both of the reader's own messages survive, so it still reads as a
       conversation rather than a monologue. */
    expect(sent.filter(m => m.role === 'user')).toHaveLength(2);
  });

  it('keeps a cancelled turn out too', () => {
    const history = [
      { role: 'user', text: 'tell me something long' },
      { role: 'assistant', text: 'Stopped.', systemNotice: true },
    ];
    expect(sanitizeHistory(history).some(m => m.content === 'Stopped.')).toBe(false);
  });
});
