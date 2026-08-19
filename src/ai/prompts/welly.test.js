import { describe, it, expect } from 'vitest';
import {
  SYSTEM_PROMPT, CHAT_PROMPT, PROMPT_VERSION, WELLY_NAME,
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

describe('identity', () => {
  it('names Welly and nothing else', () => {
    expect(WELLY_NAME).toBe('Welly');
    expect(SYSTEM_PROMPT).toContain('Welly');
    /* Not "Welly AI", not a second product name. */
    expect(SYSTEM_PROMPT).not.toMatch(/Welly AI|WellyBot|AI assistant named/i);
  });

  it('says plainly that it is not a person', () => {
    expect(SYSTEM_PROMPT).toMatch(/not a person/i);
  });

  it('is versioned, so behaviour can be tied to wording', () => {
    expect(Number.isInteger(PROMPT_VERSION)).toBe(true);
    expect(PROMPT_VERSION).toBeGreaterThan(0);
  });
});

describe('the prompt stays small on purpose', () => {
  it('is short enough not to crowd out the data', () => {
    /**
     * Every sentence here is one a small model can echo, and it competes with
     * tool results for a context window measured in low thousands of tokens.
     * The bound is deliberate — if this test fails, the answer is almost never
     * "raise the limit".
     */
    expect(SYSTEM_PROMPT.length).toBeLessThan(500);
  });

  it('says what kind of place this is, not just what it is called', () => {
    /* Without the domain the model answers in the register of a generic
       assistant. Naming the place — students volunteering, organizers running
       events — is what makes it phrase things in shifts, spots and hours. */
    expect(SYSTEM_PROMPT).toMatch(/students volunteer/i);
    expect(SYSTEM_PROMPT).toMatch(/organi[sz]ers run events/i);
  });

  it('forbids guessing as well as inventing', () => {
    /**
     * "Never invent names, numbers or dates" covers fabricated specifics. It
     * does not obviously cover the likelier failure at this size: answering a
     * question the DATA block does not cover with something plausible. That is
     * what "never guess" is for, and it is folded into the grounding sentence
     * rather than added as a new one, because the length bound above is real.
     */
    expect(SYSTEM_PROMPT).toMatch(/never guess/i);
  });

  it('states no conditional rule about empty results', () => {
    /**
     * The one instruction shape this file has measured going wrong. "If the
     * DATA block is empty, say you could not find anything" came back from the
     * 135M model AS the answer, turning a correct zero into what read like a
     * failure. The empty case is handled by the deterministic summary in
     * assistant.js instead — code, not a sentence the model can repeat.
     *
     * Pinned so that a future edit adding a well-meaning "if you don't know,
     * say so" has to read this first.
     */
    expect(SYSTEM_PROMPT).not.toMatch(/\bif the data\b|\bif you (do not|don't|cannot|can't)\b|\bif nothing\b/i);
  });

  it('does not try to enforce what code enforces', () => {
    /**
     * Authorization, permissions and tool choice are decided by the router and
     * the server. Writing them into the prompt would imply the model is
     * involved in them, and a prompt is not a boundary.
     */
    expect(SYSTEM_PROMPT).not.toMatch(/authoriz|permission|allowed to see|capability|only show data the user/i);
  });
});

describe('the conversational prompt', () => {
  it('is bounded like the other one', () => {
    /* Same reasoning as SYSTEM_PROMPT: every sentence competes with the
       conversation for a small context window, and is one more thing a small
       model can echo. */
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
