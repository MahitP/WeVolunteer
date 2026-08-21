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
  /**
   * Brevity, and why it is a prompt line rather than a bigger token budget.
   *
   * Generation stops at 512 tokens. Asked for "several long paragraphs", the
   * 0.5B model writes past that and is cut mid-sentence — measured on
   * 2026-08-21, ending "...established in Chicago, Illinois, and". Raising the
   * cap is the obvious answer and the wrong one: on-device generation is slow
   * enough that doubling the budget doubles the wait for the long answers
   * nobody asked for, on the devices least able to afford it.
   *
   * Asking for a short answer addresses the cause instead. A reply that fits is
   * a reply that finishes, and a student asking an assistant a question wants
   * two or three sentences far more often than they want an essay. Where the
   * model overruns anyway, `finish_reason` says so and the interface says so —
   * see `truncated` in assistant.js. Nothing rewrites the text.
   *
   * Three words, because CHAT_PROMPT is held under 600 characters by
   * `welly.test.js` and the budget is nearly spent. "Two or three sentences"
   * would have been clearer and did not fit; the bound is there because every
   * sentence here competes with the conversation for a small context window,
   * which is a better reason than my wanting a longer instruction.
   */
  'Keep answers short.',
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

  /**
   * 2. A phrase repeated often enough to BE the reply, rather than merely to
   *    recur in it.
   *
   * ── Why this is proportional and used not to be ──
   *
   * The rule was "any 4-to-8-word phrase occurring three or more times", with
   * no reference to how long the reply is. That is a sound description of a
   * degenerate loop in a short answer and a description of ordinary prose in a
   * long one: an essay about the history of public libraries says "the history
   * of public libraries" several times because that is its subject.
   *
   * Measured against Qwen2.5-0.5B on 2026-08-21, asked for the history of
   * public libraries: 2823 characters of coherent, correctly punctuated prose,
   * rejected here, and the reader shown "I can't help with that one" instead.
   * The longer and more on-topic the answer, the likelier the rejection — which
   * is precisely backwards.
   *
   * Measuring the SHARE of the reply the repetition accounts for separates the
   * two. "You have hours." five times over is essentially all of its reply;
   * "the history of public libraries" four times in four hundred words is four
   * per cent of it. A quarter is comfortably above any real subject noun and
   * far below anything that reads as stuck.
   *
   * Rule 1 above is untouched and is the stronger signal anyway: a phrase
   * repeated IMMEDIATELY is a loop at any length.
   */
  const REPEAT_SHARE = 0.25;

  for (let len = 4; len <= 8; len++) {
    for (let i = 0; i <= words.length - 3 * len; i++) {
      const phrase = words.slice(i, i + len).join(' ');
      const rest = words.slice(i + len).join(' ');
      const occurrences = rest.split(phrase).length - 1;
      if (occurrences < 2) continue;
      /* +1 for the occurrence at `i` itself, which `rest` excludes. */
      const share = ((occurrences + 1) * len) / words.length;
      if (share >= REPEAT_SHARE) return true;
    }
  }

  return false;
}


/**
 * The ceiling on a reply that will be SHOWN, derived from the one on a reply
 * that can be GENERATED.
 *
 * ── Why it is 4000 and not 2000 ──
 *
 * Generation is bounded at the sampler: `MAX_REPLY_TOKENS` in assistant.js and
 * `DEFAULT_MAX_TOKENS` in WllamaRuntime.js are both 512, and llama.cpp stops
 * there whatever the model intends. English runs about 4 characters to the
 * token, so a generation that uses its whole budget lands somewhere around
 * 2000–3000 characters.
 *
 * The ceiling here was 2000 — below what the token budget permits — so a reply
 * that used its full allowance was guaranteed to be rejected. Measured against
 * Qwen2.5-0.5B on 2026-08-21, asked for "several long paragraphs about the
 * history of public libraries": the model returned 2203 characters of coherent,
 * correctly punctuated prose ending in a complete sentence, the reader watched
 * it stream in, and then it was replaced by
 *
 *     "I can't help with that one. I can look up opportunities, your volunteer
 *      hours, your certificates, …"
 *
 * — the answer for a question Welly did not understand, to a question it had
 * just answered well. The ceiling was 600 before the assistant grew its current
 * tools, which made the same thing happen far more often.
 *
 * 4000 is above anything 512 tokens can produce at any plausible ratio, so this
 * is once again what it was meant to be: a backstop against output that is
 * anomalous rather than merely long. The real bound on length is `max_tokens`,
 * enforced at the sampler where it cannot discard work already done.
 */
const MAX_REPLY_CHARS = 4000;

export function isUsableReply(text) {
  const raw = String(text || '').trim();
  if (raw.length < 2 || raw.length > MAX_REPLY_CHARS) return false;
  if (looksLikeInstructionEcho(raw)) return false;
  /* An offer to do something no tool here can do. See claimsAnAction. */
  if (claimsAnAction(raw)) return false;
  /* Repetitive generation loops from small models. */
  if (hasRepetitiveLoop(raw)) return false;

  /**
   * A reply that is mostly punctuation or a stray fragment, rather than words.
   *
   * `\p{L}`, not `[a-z]`. The ASCII class asked "are there three consecutive
   * English letters", which is a proxy for "are there words" that fails on
   * every reply not written in the Latin alphabet: "Ståle, 日本語, Привет."
   * contains no run of three `a-z` characters and was discarded and replaced
   * by the deterministic fallback. Welly's interface is English, but the model
   * answers in the language it is addressed in, and a student writing Spanish
   * or Korean should not silently lose the reply.
   *
   * The class of output this was written to catch — punctuation, digits, a
   * stray fragment with no letters in it — is caught identically.
   */
  if (!/\p{L}{3}/u.test(raw)) return false;

  return true;
}

