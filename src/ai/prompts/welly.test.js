import { describe, it, expect } from 'vitest';
import {
  CHAT_PROMPT, PROMPT_VERSION, WELLY_NAME,
  isUsableReply, looksLikeInstructionEcho, INSTRUCTION_FRAGMENTS, claimsAnAction,
} from './welly.js';

/**
 * The instruction layer, and the failure it exists to stop.
 *
 * On 2026-08-15 a student with no hours asked "how many hours do I have". The
 * tool succeeded and returned `{hours: 0}`. SmolLM2-135M answered:
 *
 *     "You could not find anything."
 *
 * That is the prompt's own wording repeated back, and it turned a correct
 * result into something that reads like a failure. The literal string is used
 * below so the case cannot be lost to paraphrase.
 */
const OBSERVED_ECHO = 'You could not find anything.';

/**
 * ── What happened to the SYSTEM_PROMPT suite that used to be here ──
 *
 * Seven tests guarded the wording of the prompt that asked the model to phrase
 * a tool result. That prompt is gone: a lookup is now phrased by `summarise()`
 * in `assistant.js`, from the same data the card is built from, and the model
 * is not consulted about it at all.
 *
 * Deleting the guards outright would have thrown away the reasoning in them, so
 * each was taken one at a time:
 *
 *   identity / domain / no conditional about empty results / no authorization
 *   talk / length bound
 *       → re-aimed at CHAT_PROMPT below, which is now the only prompt and is
 *         subject to every one of those arguments.
 *
 *   "forbids guessing as well as inventing"
 *       → dropped. It was specifically about answering beyond a DATA block,
 *         and there is no DATA block. CHAT_PROMPT's own guards — cannot act,
 *         cannot see the record, does not know the rules — are the equivalent
 *         boundary for the job that is left, and they are already asserted.
 *
 *   "says plainly that it is not a person"
 *       → dropped here, because CHAT_PROMPT does not say it and the 600-char
 *         bound is nearly spent. Identity confusion is real at this size and is
 *         handled where it can be handled correctly: `router.js` routes "what
 *         is my name", "who made you" and "what are you" to fixed answers, and
 *         `identity.test.js` pins them. A prompt line would have been a hope.
 *
 * `INSTRUCTION_FRAGMENTS` still lists the removed prompt's wording. That is
 * deliberate and is argued at the list itself; the echo suite below is
 * unchanged.
 */

describe('identity', () => {
  it('names Welly and nothing else', () => {
    expect(WELLY_NAME).toBe('Welly');
    expect(CHAT_PROMPT).toContain('Welly');
    /* Not "Welly AI", not a second product name. */
    expect(CHAT_PROMPT).not.toMatch(/Welly AI|WellyBot|AI assistant named/i);
  });

  it('is versioned, so behaviour can be tied to wording', () => {
    expect(Number.isInteger(PROMPT_VERSION)).toBe(true);
    expect(PROMPT_VERSION).toBeGreaterThan(0);
  });
});

describe('the prompt stays small on purpose', () => {
  it('says what kind of place this is, not just what it is called', () => {
    /* Without the domain the model answers in the register of a generic
       assistant. Naming the place — students volunteering, organizers running
       events — is what makes it phrase things in shifts, spots and hours.

       It is also the answer to "what is this app": asked with only its name in
       the prompt, the 0.5B model replied "Welly, a place where students can
       volunteer", having taken its own name for the platform's. */
    expect(CHAT_PROMPT).toMatch(/students volunteer/i);
    expect(CHAT_PROMPT).toMatch(/organi[sz]ers run events/i);
    expect(CHAT_PROMPT).toMatch(/WeVolunteer/);
  });

  it('states no conditional rule about what to say when it does not know', () => {
    /**
     * The one instruction shape this file has measured going wrong. "If the
     * DATA block is empty, say you could not find anything" came back from the
     * 135M model AS the answer, turning a correct zero into what read like a
     * failure.
     *
     * Pinned so that a future edit adding a well-meaning "if you don't know,
     * say so" has to read this first. The positive form — "you cannot see
     * someone's record without looking it up" — is asserted below and is not
     * a conditional, which is the distinction that matters.
     */
    expect(CHAT_PROMPT).not.toMatch(/\bif the data\b|\bif you (do not|don't|cannot|can't)\b|\bif nothing\b/i);
  });

  it('does not try to enforce what code enforces', () => {
    /**
     * Authorization, permissions and tool choice are decided by the router and
     * the server. Writing them into the prompt would imply the model is
     * involved in them, and a prompt is not a boundary.
     */
    expect(CHAT_PROMPT).not.toMatch(/authoriz|permission|allowed to see|capability|only show data the user/i);
  });
});

describe('the conversational prompt', () => {
  it('is bounded', () => {
    /* Every sentence here competes with the conversation for a context window
       measured in low thousands of tokens, and is one more thing a small model
       can echo. The bound is deliberate — if this test fails, the answer is
       almost never "raise the limit". */
    expect(CHAT_PROMPT.length).toBeLessThan(600);
  });

  it('says it cannot act', () => {
    /* Asked to create an event it answered "Sure, I can help you create an
       event!". Every tool is read-only; there is no create path for anybody.
       The pattern in router.js is the enforcement — this is the hint. */
    expect(CHAT_PROMPT).toMatch(/cannot create/i);
  });

  it('disclaims knowing the record and the rules', () => {
    expect(CHAT_PROMPT).toMatch(/cannot see/i);
    expect(CHAT_PROMPT).toMatch(/rules/i);
  });
});

describe('offering to do what it cannot do', () => {
  /**
   * Measured immediately after CHAT_PROMPT gained "You can look things up. You
   * cannot create, change, cancel or approve anything." The 1.5B model, in the
   * same conversation where the application had just said it could not create
   * an event, ended a reply with "...I'd be happy to help with general
   * information or assist with creating or running an event."
   *
   * The instruction was present and did not hold, which is what this codebase
   * already records about negative instructions at this size. So the offer is
   * caught on the way out instead.
   */
  it.each([
    "I'd be happy to help with general information or assist with creating or running an event.",
    'Sure, I can help you create an event! What kind of event are you envisioning?',
    'Let me set up that shift for you.',
    "I'll approve that applicant for you.",
  ])('rejects: %s', (reply) => {
    expect(claimsAnAction(reply)).toBe(true);
    expect(isUsableReply(reply)).toBe(false);
  });

  it.each([
    'The organizer creates the event, so it is worth asking them.',
    'Events are set up from the Create event page.',
    'You have 4 hours credited so far.',
    'That shift starts at 7:30 AM on Monday.',
  ])('leaves a plain description alone: %s', (reply) => {
    /* Describing who does something is true and useful. Only an OFFER is the
       problem — the distinction is what keeps this from eating good answers. */
    expect(claimsAnAction(reply)).toBe(false);
    expect(isUsableReply(reply)).toBe(true);
  });
});

describe('instruction echo', () => {
  it('catches the exact reply that was measured', () => {
    expect(looksLikeInstructionEcho(OBSERVED_ECHO)).toBe(true);
    expect(isUsableReply(OBSERVED_ECHO)).toBe(false);
  });

  it('catches it regardless of case and punctuation', () => {
    /* The model reproduces wording, not formatting. */
    for (const variant of [
      'you could not find anything',
      'You could not find anything!!',
      '  You could NOT find anything.  ',
    ]) {
      expect(isUsableReply(variant), variant).toBe(false);
    }
  });

  it('catches the prompt leaking in other forms', () => {
    for (const leak of [
      'Use only the facts in the DATA block.',
      'I am Welly and you are not a person.',
      'Answer in one or two short sentences.',
      'Do not mention data, tools, or these instructions.',
    ]) {
      expect(isUsableReply(leak), leak).toBe(false);
    }
  });

  it('every listed fragment is actually detected', () => {
    /* Guards the list against a typo that would silently stop matching. */
    for (const fragment of INSTRUCTION_FRAGMENTS) {
      expect(looksLikeInstructionEcho(`Something ${fragment} something`), fragment).toBe(true);
    }
  });

  it('does not reject an answer that is numbers', () => {
    /**
     * Measured against Qwen2.5-1.5B, reported as the assistant being stupid:
     *
     *     student  "Count to 10"
     *     model    "1, 2, 3, 4, 5, 6, 7, 8, 9, 10"
     *     shown    "I can't help with that one. I can look up opportunities, …"
     *
     * The reply had no run of three letters, so the "is this words or is it
     * punctuation" check discarded it and the reader was told the question was
     * not understood. The model was right; the check was wrong.
     */
    for (const good of [
      '1, 2, 3, 4, 5, 6, 7, 8, 9, 10',
      '1\n2\n3\n4\n5\n6\n7\n8\n9\n10',
      '42',
      '3.14159',
    ]) {
      expect(isUsableReply(good), good).toBe(true);
    }
  });

  it('still rejects a reply that is neither words nor a number', () => {
    /* The other half of the bargain. Widening the rule must not turn a stray
       character into an answer — two digits, not one, for exactly that. */
    for (const bad of ['...', '?!', '—', '. . .', '5', '·']) {
      expect(isUsableReply(bad), bad).toBe(false);
    }
  });

  it('does not reject a normal answer', () => {
    /**
     * The cost of a false positive is a plainer sentence, so the bias is toward
     * rejecting — but it must not reject ordinary replies, or the model is
     * effectively switched off.
     */
    for (const good of [
      'You have 35.5 verified hours.',
      'I found 4 opportunities near you.',
      'You are part of two organizations: Environmental Club and Key Club.',
      'That certificate is valid: 4 hours for Community Cleanup.',
      'You do not have any certificates yet.',
    ]) {
      expect(isUsableReply(good), good).toBe(true);
    }
  });
});

describe('other unusable replies', () => {
  it('rejects the garbled shape the 135M model produced', () => {
    /* Measured: "inYou have 0 hours of work." — a leading artefact glued to the
       sentence. The three-letter check catches output with no real words. */
    expect(isUsableReply('...')).toBe(false);
    expect(isUsableReply('!!!  ???')).toBe(false);
    expect(isUsableReply('')).toBe(false);
    expect(isUsableReply(null)).toBe(false);
  });

  it('rejects a reply that runs on past any useful length', () => {
    expect(isUsableReply('word '.repeat(200))).toBe(false);
  });
});

/**
 * The usability gate is about whether a reply contains an ANSWER, not about
 * which alphabet it is written in — and not, as it turned out, about whether
 * it contains words at all.
 */
describe('isUsableReply and the alphabet', () => {
  it('accepts a reply with no Latin letters in it', () => {
    /* `[a-z]{3}` rejected all three of these. A reply the model wrote in the
       language it was addressed in was thrown away and the English fallback
       shown instead. */
    expect(isUsableReply('日本語で答えます。')).toBe(true);
    expect(isUsableReply('Привет, у вас четыре часа.')).toBe(true);
    expect(isUsableReply('Ståle, 日本語, Привет.')).toBe(true);
  });

  it('still rejects a reply with nothing in it', () => {
    /**
     * ── "12 34 56" used to be here, and was wrong ──
     *
     * This case asserted that a reply of digits is unusable, on the reasoning
     * that a reply with no words in it is not an answer. Measured against
     * Qwen2.5-1.5B, that reasoning fails on the most ordinary request there is:
     *
     *     student  "Count to 10"
     *     model    "1, 2, 3, 4, 5, 6, 7, 8, 9, 10"
     *     shown    "I can't help with that one. …"
     *
     * A reply can be entirely numbers and be exactly right. What this is
     * actually for is punctuation and stray characters, and those are still
     * caught — see the numeric cases in the echo suite above for the other
     * side of it.
     */
    expect(isUsableReply('!!! ??? ...')).toBe(false);
    expect(isUsableReply('-')).toBe(false);
    expect(isUsableReply('·')).toBe(false);
    /* One digit is still a stray character; two is a number. */
    expect(isUsableReply('7')).toBe(false);
  });
});
