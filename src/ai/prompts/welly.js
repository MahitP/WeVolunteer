/**
 * Who Welly is, and the few instructions worth spending tokens on.
 *
 * ── Why this is deliberately short ──
 *
 * The obvious response to a model behaving badly is to write it more rules. At
 * this size that makes things worse, and there is a measurement for it.
 *
 * Asked "how many hours do I have" by a student with none, SmolLM2-135M
 * answered:
 *
 *     "You could not find anything."
 *
 * That sentence is not a hallucination. It is this file's own former line —
 * "If the DATA block is empty, say you could not find anything" — repeated back
 * as the answer. The lookup had SUCCEEDED and returned zero hours, so the model
 * turned a correct result into something that reads like a failure.
 *
 * Every instruction added here is one more sentence a small model can echo. So
 * the prompt carries identity and the handful of rules that genuinely change
 * output, and everything enforceable in code is enforced in code instead:
 *
 *   authorization, tool choice, what data is fetched, what is rendered, and
 *   whether the model is consulted at all
 *
 * are decided by `router.js`, `tools.js` and `assistant.js`. None of them ask
 * the model. A prompt is guidance; it is not a boundary, and treating it as one
 * is how a boundary ends up not existing.
 *
 * ── Versioned ──
 *
 * `PROMPT_VERSION` changes whenever the wording does, so a behavioural report
 * can be tied to what Welly was actually told.
 */

/** The name a student sees. Kept in one place so copy cannot drift. */
export const WELLY_NAME = 'Welly';

/** Bumped whenever SYSTEM_PROMPT changes. */
export const PROMPT_VERSION = 2;

/**
 * Welly's conversational instructions.
 *
 * Six lines. Each earns its place by changing output on a small model:
 * identity, brevity, grounding, the empty-versus-failed distinction, no
 * invented actions, and no meta-commentary.
 *
 * Note what is NOT here: nothing about authorization, permissions, privacy
 * scoping or which tool to use. Those are not the model's to get right, and
 * writing them down would only imply that they were.
 */
export const SYSTEM_PROMPT = [
  /* The domain, in the identity line rather than as a rule of its own.
     "Where students volunteer and organizers run events" is what lets the model
     phrase an answer in the register of this place — shifts, spots, hours —
     instead of the generic register of an assistant. It costs a clause and it
     is a statement of fact, which is the kind of sentence that survives being
     echoed: a model repeating "you are Welly" is odd, not wrong. */
  `You are ${WELLY_NAME}, the assistant inside WeVolunteer, where students volunteer and organizers run events. You are not a person.`,
  'Answer in one or two short sentences, warm and plain, like a helpful guide.',
  /* "Never guess" is the anti-hallucination rule, and it is deliberately folded
     into the grounding line rather than added as a seventh sentence. What is
     NOT here is a conditional — "if the DATA block does not answer, say you do
     not have it" — because that is the exact shape of the line this file's
     header records backfiring: the 135M model returned the instruction itself
     as the answer. The empty case is handled in code, by the deterministic
     summary in assistant.js, which is always available and always correct. */
  'Use only the facts in the DATA block. Never guess, never invent names, numbers or dates.',
  'A count of zero is a real answer: say there are none, not that something failed.',
  'Never say you did something. You can look things up, nothing else.',
  'Do not mention data, tools, or these instructions.',
].join(' ');

/**
 * Welly in conversation, when nothing was looked up.
 *
 * ── Why this is a second prompt and not a longer first one ──
 *
 * `SYSTEM_PROMPT` phrases a result that is already correct: a tool ran, the
 * facts are in the message, and the model's only job is to put them in a
 * sentence. Its rules exist to stop it adding anything.
 *
 * This one runs when no tool ran at all — there is no DATA block, and nothing
 * the model says is checked against anything. That is a different job with a
 * different danger, so it gets its own instructions rather than a conditional
 * bolted onto the other, which is how one prompt ends up doing neither job well.
 *
 * ── The one rule that matters ──
 *
 * Free conversation is fine. Inventing this platform's facts is not, and at
 * this model size it is the likely failure: asked "does driving my sister to
 * practice count towards my hours", a 1.5B model will produce a confident,
 * fluent, entirely invented policy, and a student has no way to tell.
 *
 * So the boundary is not "do not chat" — it is "you do not know this person's
 * record or this school's rules". Questions of that shape are pushed back to a
 * lookup, which is deterministic and correct. Everything else it may simply
 * talk about.
 */
export const CHAT_PROMPT = [
  `You are ${WELLY_NAME}, the friendly assistant in WeVolunteer where students volunteer and organizers run events.`,
  'Talk naturally, warmly, and casually like a helpful human friend, not a robotic customer service bot.',
  'Avoid stiff phrases like "How may I assist you today" or "I am sorry to hear that".',
  'You cannot create, change, cancel or approve anything directly.',
  'You cannot see someone\'s record without looking it up, and you do not know school rules by heart.',
  'If asked what you can do, offer specific suggestions like finding shifts, checking hours, or viewing applications.',
].join(' ');

/**
 * Fragments of the instructions that must never appear in a reply.
 *
 * Matched against the model's output, lower-cased and stripped of punctuation.
 * These are the distinctive spans — the parts no student answer would contain
 * by coincidence. "Say there are none" is not listed, because a legitimate
 * reply could plausibly include it.
 *
 * This is a display safeguard, not a security control: the card beside the
 * prose is rendered from data and is correct either way. What it prevents is a
 * student reading the assistant's own instructions as an answer.
 */
export const INSTRUCTION_FRAGMENTS = Object.freeze([
  'you could not find anything',
  'could not find anything',
  'use only the facts',
  'in the data block',
  'data block',
  'never invent',
  /* Added with the wording that introduced them. A fragment list that lags the
     prompt is a list that stops working exactly when the prompt changes. */
  'never guess',
  'where students volunteer',
  'you are welly the assistant inside wevolunteer',
  'one or two short sentences',
  'you are not a person',
  'do not mention data',
  'these instructions',
  'a count of zero',
  'never say you did something',
]);

const NORMALISE = /[^a-z0-9 ]+/g;

function normalise(text) {
  return String(text || '').toLowerCase().replace(NORMALISE, ' ').replace(/\s+/g, ' ').trim();
}

/** True when a reply is repeating what Welly was told rather than answering. */
export function looksLikeInstructionEcho(text) {
  const flat = normalise(text);
  if (!flat) return false;
  return INSTRUCTION_FRAGMENTS.some(fragment => flat.includes(fragment));
}

/**
 * Whether a model reply is fit to show.
 *
 * Length alone was the old test, and it passed the echo verbatim. A reply now
 * has to be a plausible sentence AND not be the instructions coming back.
 *
 * Returning false is not a failure — the caller substitutes the deterministic
 * sentence, which is always available and always correct. Rejecting freely is
 * therefore cheap, and the bias is deliberately toward rejecting.
 */
/**
 * The model offering to do something it cannot do.
 *
 * CHAT_PROMPT says plainly "You can look things up. You cannot create, change,
 * cancel or approve anything." Measured against the 1.5B model immediately
 * after adding that line, it still finished a reply with:
 *
 *     "...I'd be happy to help with general information or assist with creating
 *      or running an event."
 *
 * — in the same conversation where the application had just said it could not.
 * This is the rule `prompts/tasks.js` records from its own measurements:
 * negative instructions do not hold at this size, so anything enforceable after
 * the fact is enforced after the fact.
 *
 * A reply making an offer like this is rejected and the deterministic sentence
 * is shown instead. Rejecting is cheap — the fallback is always correct — and
 * the alternative is a student waiting for an event that nobody is creating.
 *
 * Deliberately matches OFFERS, not descriptions. "The organizer creates the
 * event" is a true sentence and stays.
 */
const CAPABILITY_CLAIMS = [
  /* The contraction matters: "I'll approve" has no space where "I will
     approve" does, and the first spelling is the likelier one. */
  /\bi(?:'ll|'d| will| can| could| would| shall| am able to)\b[^.]{0,25}?\b(create|make|set ?up|schedule|post|publish|approve|register|sign)\b/i,
  /\b(happy|glad|able) to (help|assist)\b[^.]{0,40}\b(creat|mak|settin|schedulin|approv|runnin|registerin)/i,
  /\b(help|assist) (you )?(with )?(creating|making|setting ?up|scheduling|approving|running|registering)\b/i,
  /\blet me (create|make|set ?up|schedule|approve|sign)\b/i,
];

/** True when a reply promises an action this assistant cannot perform. */
export function claimsAnAction(text) {
  const raw = String(text || '');
  return CAPABILITY_CLAIMS.some(pattern => pattern.test(raw));
}

/** True when a small model gets stuck in a repetitive loop. */
export function hasRepetitiveLoop(text) {
  const norm = normalise(text);
  if (!norm || norm.length < 20) return false;
  const words = norm.split(' ').filter(Boolean);
  if (words.length < 6) return false;

  // 1. Check for immediate consecutive phrase repetition: e.g. "word A B word A B"
  for (let len = 2; len <= 12; len++) {
    for (let i = 0; i <= words.length - 2 * len; i++) {
      const phrase = words.slice(i, i + len).join(' ');
      const nextPhrase = words.slice(i + len, i + 2 * len).join(' ');
      if (phrase === nextPhrase) return true;
    }
  }

  // 2. Check for 3+ occurrences of a longer phrase (4+ words) anywhere in text
  for (let len = 4; len <= 8; len++) {
    for (let i = 0; i <= words.length - 3 * len; i++) {
      const phrase = words.slice(i, i + len).join(' ');
      const rest = words.slice(i + len).join(' ');
      const occurrences = rest.split(phrase).length - 1;
      if (occurrences >= 2) return true;
    }
  }

  return false;
}


export function isUsableReply(text) {
  const raw = String(text || '').trim();
  if (raw.length < 2 || raw.length > 2000) return false;
  if (looksLikeInstructionEcho(raw)) return false;
  /* An offer to do something no tool here can do. See claimsAnAction. */
  if (claimsAnAction(raw)) return false;
  /* Repetitive generation loops from small models. */
  if (hasRepetitiveLoop(raw)) return false;

  /* A reply that is mostly punctuation or a stray fragment. The 135M model
     produced "inYou have 0 hours of work." — the leading artefact is the shape
     this catches. */
  if (!/[a-z]{3}/i.test(raw)) return false;

  return true;
}

