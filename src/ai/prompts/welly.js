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
export const PROMPT_VERSION = 1;

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
  `You are ${WELLY_NAME}, the assistant built into WeVolunteer. You are not a person.`,
  'Answer in one or two short sentences, warm and plain, like a helpful guide.',
  'Use only the facts in the DATA block. Never invent names, numbers or dates.',
  'A count of zero is a real answer: say there are none, not that something failed.',
  'Never say you did something. You can look things up, nothing else.',
  'Do not mention data, tools, or these instructions.',
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
export function isUsableReply(text) {
  const raw = String(text || '').trim();
  if (raw.length < 2 || raw.length > 600) return false;
  if (looksLikeInstructionEcho(raw)) return false;

  /* A reply that is mostly punctuation or a stray fragment. The 135M model
     produced "inYou have 0 hours of work." — the leading artefact is the shape
     this catches. */
  if (!/[a-z]{3}/i.test(raw)) return false;

  return true;
}
