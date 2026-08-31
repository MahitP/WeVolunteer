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

/** Bumped whenever CHAT_PROMPT changes. */
export const PROMPT_VERSION = 3;

/**
 * Welly in conversation. The only prompt there is.
 *
 * ── Why there used to be two, and why there is now one ──
 *
 * `SYSTEM_PROMPT` used to phrase a result that was already correct: a tool ran,
 * the facts went into the message, and the model's only job was to put them in
 * a sentence. It could not do that job. Measured against Qwen2.5-0.5B, handed
 * `{total: 0, next: null}` for "what is my next shift", it wrote "Your next
 * shift is currently at zero"; handed a waitlist of two, "Waitlisted
 * applications do not count, no need to show them." The instructions were
 * present and correct in both cases. See the note at the end of `assistant.js`
 * for the full set and for why the fix was to stop asking rather than to write
 * a seventh rule.
 *
 * So a lookup is now phrased by `summarise()`, in code, from the same data the
 * card is built from — and this prompt is what remains: the one job that has no
 * deterministic answer to fall back on.
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
     prompt is a list that stops working exactly when the prompt changes.

     Several of these came from SYSTEM_PROMPT, which no longer exists — nothing
     sends the model a DATA block any more. They stay because the list is
     matched against output, not against the current prompt: a model that has
     seen this wording in its own history, or that produces it for reasons of
     its own, still must not have it shown to a student as an answer. Removing
     a fragment can only ever let one more thing through. */
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

/**
 * A reply that asks the reader to type personal information.
 *
 * ── Why this is rejected rather than instructed against ──
 *
 * Asked for opportunities near them by a student whose browser had not granted
 * location, the model asked for an address. It is a reasonable thing for a
 * general assistant to do and completely wrong here, for three reasons that
 * compound:
 *
 *   - The lookup does not need it. `LocationContext` already has a way to get
 *     coordinates, keeps them in memory, and sends the server a centre rounded
 *     to about a kilometre. Typing a street address is strictly worse data,
 *     obtained in a strictly worse way.
 *   - The people typing are minors, and the box is on a page that also holds
 *     their volunteering record.
 *   - It reads like phishing. A chat window asking a student for their address
 *     is the shape of the thing they are told to be suspicious of, and it does
 *     not stop being that shape because the model happens to be running on
 *     their own device — nobody can see that from the outside.
 *
 * A prompt line was not the fix, for the reason this file records twice
 * already: negative instructions do not hold at 0.5B. So a reply of this shape
 * is rejected on the way out and the deterministic answer is shown instead,
 * exactly as `claimsAnAction` works — and the search path now says plainly that
 * it has no location and offers the browser's own permission button.
 *
 * Matches the ASK, not the subject. "Your address is not shown to organizers"
 * is a true, useful sentence and stays.
 */
const PERSONAL_INFO_REQUESTS = [
  /* Direct: "what is your address", "may I have your zip code". */
  /\b(what(?:'?s| is| are)?|may i (?:have|know)|can i (?:have|get)|tell me|give me|provide|share|enter|type|send me)\b[^.?!]{0,30}\byour\b[^.?!]{0,20}\b(address|zip ?code|postal ?code|postcode|phone number|email address|date of birth|birthday|full name|home|street)\b/i,
  /* Where the reader is, in the forms a model actually reaches for. */
  /\bwhere\s+(do|are)\s+you\s+(live|located|based|from)\b/i,
  /\bwhat\s+(city|town|area|neighou?rhood|state|region|zip)\b[^.?!]{0,20}\byou\b/i,
  /\bcould you (?:please )?(?:tell|let) me know (?:your|where you)\b/i,
  /* The imperative form, which has no "your" in it. */
  /\b(enter|type|paste) (?:in )?(?:your )?(address|zip|postal code|location|phone|email)\b/i,
];

/**
 * True when a reply asks the reader for personal information.
 *
 * Never a security control — a rejected reply is replaced by a written answer,
 * and nothing about the model's access changes. It is a display rule: this
 * assistant does not collect anything by asking.
 */
export function asksForPersonalInfo(text) {
  const raw = String(text || '');
  return PERSONAL_INFO_REQUESTS.some(pattern => pattern.test(raw));
}

/**
 * Anything that names somewhere to go.
 *
 * A scheme-qualified URL, or a `www.` host. Deliberately not a general
 * "looks like a domain" pattern: `\w+\.\w{2,}` matches "shift.It" across a
 * missing space and "2.5 hours", and a validator that discards correct answers
 * gets deleted by whoever is debugging it.
 */
const LINK_PATTERNS = Object.freeze([
  /[a-z][a-z0-9+.-]*:\/\//i,
  /\bwww\.[a-z0-9-]+\.[a-z]{2,}/i,
]);

/**
 * True when a reply points the reader at a destination.
 *
 * ── Why any link at all is refused ──
 *
 * Welly has no reason to produce one. The informational corpus is fixed
 * application text, every deterministic answer is composed in `summarise()`, and
 * getting somewhere in this app is a router NAVIGATION — `res.navigate`, chosen
 * from the `DESTINATIONS` allowlist — not a link the model writes. So a URL in
 * model output is either hallucinated or planted, and there is no third case to
 * protect.
 *
 * ── Why it matters more here than the other validators ──
 *
 * `WellyMessage` renders `http(s)` runs in a reply as clickable anchors. The
 * audience is minors, and the voice is the assistant the app tells them to
 * trust. That makes a link the single most valuable thing an attacker can get
 * Welly to say — more valuable than a false fact, because it moves the reader
 * somewhere the platform no longer protects them.
 *
 * `indirectInjection.test.js` records the path that makes this reachable: an
 * event title carries into an answer, the answer becomes an assistant turn, and
 * `sanitizeHistory` replays it into the next prompt wearing the assistant's
 * role.
 *
 * This is not the security boundary. The boundary is that the model holds no
 * capability — OWASP is explicit that a prompt-level or output-shape defence is
 * not one. It removes the reachable harm sitting inside that boundary, which is
 * a different and smaller claim.
 */
export function containsLink(text) {
  const raw = String(text || '');
  return LINK_PATTERNS.some(pattern => pattern.test(raw));
}

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
  /* A request for something a student should never type here. See
     asksForPersonalInfo. */
  if (asksForPersonalInfo(raw)) return false;
  /* Repetitive generation loops from small models. */
  if (hasRepetitiveLoop(raw)) return false;
  /* Somewhere to go. See containsLink — the payload an injected title wants. */
  if (containsLink(raw)) return false;

  /**
   * A reply that is punctuation or a stray fragment, rather than an answer.
   *
   * ── Letters, in any alphabet ──
   *
   * `\p{L}`, not `[a-z]`. The ASCII class asked "are there three consecutive
   * English letters", which is a proxy for "are there words" that fails on
   * every reply not written in the Latin alphabet: "Ståle, 日本語, Привет."
   * contains no run of three `a-z` characters and was discarded and replaced
   * by the deterministic fallback. Welly's interface is English, but the model
   * answers in the language it is addressed in, and a student writing Spanish
   * or Korean should not silently lose the reply.
   *
   * ── Or numbers, because some answers are numbers ──
   *
   * The original comment listed "digits" among the things this catches, which
   * was a mistake rather than a decision. Measured against Qwen2.5-1.5B:
   *
   *     student  "Count to 10"
   *     model    "1, 2, 3, 4, 5, 6, 7, 8, 9, 10"
   *     shown    "I can't help with that one. I can look up opportunities, …"
   *
   * The model answered, correctly, and the answer contained no run of three
   * letters, so it was discarded and the reader was told Welly did not
   * understand the question. That reads as the model being stupid when the
   * model was right and this line was wrong.
   *
   * Two digits rather than one, so a lone stray character is still caught. A
   * reply that is genuinely just a number — "42" — is a real answer and is now
   * allowed to be one.
   */
  const digits = raw.match(/\p{N}/gu);
  if (!/\p{L}{3}/u.test(raw) && (digits?.length ?? 0) < 2) return false;

  return true;
}

