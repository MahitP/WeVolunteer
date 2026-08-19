/**
 * Deciding what a question is about, without asking the model.
 *
 * ── Why this is patterns and not a model call ──
 *
 * The obvious design is to hand the model a list of tools and let it choose.
 * That is how this works with a large model, and it does not survive being
 * shrunk to something that fits in a browser: multi-step tool calling collapses
 * below roughly two billion parameters, and the largest model offered here is
 * 1.5B. Published agentic benchmarks for models of this size sit in the low
 * tens out of a hundred.
 *
 * A wrong tool choice is not a small error. Asked "how many hours do I have",
 * a model that picks the opportunity search answers a different question
 * fluently and confidently, and the student has no way to tell. Patterns get
 * this right every time for the phrasings they cover, and — crucially — return
 * nothing rather than something for phrasings they do not, which produces an
 * honest "I cannot answer that" instead of a plausible wrong answer.
 *
 * The model still earns its place. It phrases the answer, and later phases use
 * it for the things patterns genuinely cannot do: reading a certificate,
 * suggesting tags, explaining why an opportunity fits.
 *
 * ── Order matters ──
 *
 * Matchers are tried in order and the first hit wins, so the most specific
 * come first. A message containing a certificate code is a verification request
 * even though it also contains the word "certificate".
 */

/** `WEV-XXXX-XXXX`, the shape minted by `server/certificates.js`. */
const CERTIFICATE_CODE = /\bWEV-[0-9A-HJ-NP-Z]{4}-[0-9A-HJ-NP-Z]{4}\b/i;

/**
 * Words that mean "close to me". Distance is only usable when a position has
 * been shared, so the slot is a request rather than a value — the caller
 * decides whether it can be honoured.
 */
const NEARBY = /\b(near(by| me| here)?|close(st| by| to me)?|around here|walking distance)\b/i;

/**
 * Repairing a near-miss on the handful of words that decide routing.
 *
 * "Can u give me horus?" is a transposition away from "hours". It matched no
 * pattern, reached the conversational path, and the 1.5B model — having no idea
 * what Horus is in this context — invented one: "Horus is a fun game that you
 * can play with friends. It's a classic board game that's been around for a
 * long time." Confident, detailed, entirely fabricated.
 *
 * The lookup was available the whole time and one character away.
 *
 * Deliberately NOT general fuzzy matching, which is how a router starts
 * answering questions nobody asked. It is a fixed list of the words that
 * actually select a tool, an edit distance of one, and a length floor so short
 * words are left alone — "hour" and "horn" are not the same word, and neither
 * is "even" and "event".
 */
const REPAIRABLE = ['hours', 'certificates', 'organizations', 'volunteering', 'opportunities', 'applications'];

/**
 * Words that are already correct and must never be "repaired".
 *
 * The first version listed both singular and plural — `certificate` AND
 * `certificates` — and each is one insertion away from the other, so a
 * correctly typed `certificate` was rewritten to `certificates`. That broke two
 * matchers that test the singular with a word boundary: "verify my certificate"
 * stopped asking for the code, and "delete my application" stopped being
 * refused. Both were caught by existing tests, which is exactly what they are
 * for.
 *
 * So a word spelled correctly is left alone, whatever it is near.
 */
const SPELLED_CORRECTLY = new Set([
  ...REPAIRABLE,
  'hour', 'certificate', 'organization', 'organizations', 'application',
  'opportunity', 'volunteer', 'volunteers', 'event', 'events', 'shift', 'shifts',
]);

/** Damerau-Levenshtein, capped at 1. Transpositions are the typo people make. */
function isNearMiss(word, target) {
  if (Math.abs(word.length - target.length) > 1) return false;
  if (word === target) return false;

  /* One transposition: "horus" for "hours". */
  if (word.length === target.length) {
    const diff = [];
    for (let i = 0; i < word.length; i += 1) if (word[i] !== target[i]) diff.push(i);
    if (diff.length === 1) return true;
    if (diff.length === 2 && diff[1] === diff[0] + 1
        && word[diff[0]] === target[diff[1]] && word[diff[1]] === target[diff[0]]) return true;
    return false;
  }

  /* One insertion or deletion. */
  const [shorter, longer] = word.length < target.length ? [word, target] : [target, word];
  let i = 0; let j = 0; let skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) { i += 1; j += 1; continue; }
    if (skipped) return false;
    skipped = true;
    j += 1;
  }
  return true;
}

/** Rewrites near-misses so the matchers below see the word that was meant. */
function repairTypos(text) {
  return text.replace(/[a-z]{5,}/gi, (word) => {
    const lower = word.toLowerCase();
    if (SPELLED_CORRECTLY.has(lower)) return word;
    const hit = REPAIRABLE.find(target => isNearMiss(lower, target));
    return hit || word;
  });
}

/**
 * Asking Welly to DO something.
 *
 * "I'd like you to create an event" reached the conversational path and was
 * answered "Sure, I can help you create an event! What kind of event are you
 * envisioning?" — from a student account, about a thing Welly cannot do for
 * anybody. Every tool is read-only; there is no create path at all. The reply
 * was a promise to a person who would then wait for it to happen.
 *
 * Both halves of that are wrong independently. The account could not create an
 * event, and the assistant could not create one either. Neither is a fact the
 * model has, and CHAT_PROMPT saying "you can only look things up" is the kind
 * of negative instruction this codebase has already measured failing.
 *
 * So an action request is answered by the application, which knows the truth.
 * The wording sends them to where the action actually lives rather than simply
 * refusing, because somebody asking to create an event usually may.
 */
const ACTION_REQUEST = new RegExp([
  /\b(create|make|add|set ?up|schedule|post|publish|start)\b.{0,20}\b(event|opportunit(y|ies)|shift|slot)\b/,
  /\b(delete|remove|cancel|close|edit|change|update)\b.{0,20}\b(event|opportunit(y|ies)|shift|slot|application)\b/,
  /\b(approve|reject|accept|decline|waitlist)\b.{0,20}\b(applicant|application|volunteer|student)\b/,
  /\b(sign me up|apply me|register me|book me)\b/,
].map(r => r.source).join('|'), 'i');

/**
 * Questions about the RULES rather than about a record.
 *
 * "Does driving someone to practice count as volunteering?" contains the word
 * `volunteering`, so it reached the opportunity search and came back "I
 * couldn't find any opportunities matching that" — a catalogue answer to a
 * question about eligibility. "Does this count towards my hours" contains
 * `hours` and `my`, so it reached the hours lookup and was answered with a
 * total the student did not ask for.
 *
 * Both are the same shape: a question about what is allowed, which this
 * application does not store and no tool can answer. Left to the matchers they
 * are captured by a keyword and answered as something else — the exact failure
 * the header warns about, arriving from the conversational side.
 *
 * So they are pulled out ahead of the matchers and left to `unknown`, which is
 * the conversational path. That is where they belong: CHAT_PROMPT tells the
 * model it does not know this school's rules and to offer a lookup instead, so
 * the honest answer is available. Answering "you have 0 hours" is not.
 *
 * Narrow on purpose. It needs an eligibility word AND a question shape, so
 * "how many hours do I have" and "what counts" are not confused with each
 * other.
 */
const ELIGIBILITY = /\b(counts?|allowed|eligible|qualif(y|ies)|permitted|supposed to|rules?|policy|okay to|ok to|fine to)\b/i;
const QUESTION_SHAPE = /^\s*(does|do|is|are|am|can|could|may|should|would|will|what|why|if)\b/i;

/**
 * Wanting to be SHOWN something, as opposed to merely mentioning it.
 *
 * The opportunity search used to fire on the nouns alone — opportunity, event,
 * volunteering, shift. In an app about volunteering those words appear in
 * almost every sentence somebody types, so "I'm a bit nervous about my first
 * shift" was answered "I couldn't find any opportunities matching that". A
 * catalogue answer to a feeling.
 *
 * A search needs the noun AND a reason to think a search was wanted. Bare nouns
 * still work — somebody typing "events" means browse — which is what the short
 * message allowance below is for.
 */
const SEARCH_INTENT = new RegExp([
  /* Asking to be shown. */
  /\b(find|show|search|browse|list|any|available|open|upcoming|recommend|suggest)\b/,
  /\b(looking for|sign ?up for|what'?s on)\b/,
  /* Asking about place or time, which only a search can answer. */
  /\b(near|nearby|around|close (by|to)|this (week|weekend|month))\b/,
  /* "What events can I participate in" — wanting to take part is wanting to be
     shown what there is. Present tense only: the past tense of the same verbs
     is a question about their own record and is matched well before here. */
  /\bcan i\b.{0,15}\b(do|join|participate|attend|help|sign ?up|volunteer)\b/,
].map(r => r.source).join('|'), 'i');

/** Three words or fewer: "events", "any shifts", "volunteering near me". */
const isTerse = text => String(text).trim().split(/\s+/).length <= 3;

/** A message that is nothing but hello. Anchored at both ends deliberately. */
const GREETING = /^(hi+|hey+|hello+|hullo|yo|hiya|howdy|sup|greetings|good (morning|afternoon|evening))([\s,]+(there|welly))?[\s!.,?]*$/i;

/** Asking whether it converses at all — answered with what it can actually do. */
const SMALLTALK = /^(can (you|u) (talk|chat|speak)|(are|r) (you|u) (there|real|a bot|human)|how are (you|u)|what'?s up)[\s!.,?]*$/i;

const MATCHERS = [
  {
    intent: 'verify_certificate',
    tool: 'verify_certificate',
    /* First, because a message with a code in it is a verification request
       whatever else it says. */
    test: text => CERTIFICATE_CODE.test(text),
    slots: text => ({ code: text.match(CERTIFICATE_CODE)[0].toUpperCase() }),
  },
  {
    intent: 'verify_certificate_missing_code',
    tool: null,
    /* Asked to verify, but no code given. Answering "no certificate found"
       would be wrong — nothing was looked up. */
    test: text => /\b(verify|validate|check)\b/i.test(text) && /\bcertificate\b/i.test(text),
    slots: () => ({}),
  },
  {
    /* Ahead of `my_applications`: "when is my next shift" is about one specific
       row, and answering it with the whole list is a worse answer. */
    intent: 'my_next_shift',
    tool: 'my_next_shift',
    test: text =>
      /\b(next|upcoming|coming up)\b/i.test(text)
      && /\b(shift|event|volunteer(ing)?|am i|do i)\b/i.test(text)
      && /\b(my|i|me)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'my_waitlists',
    tool: 'my_waitlists',
    test: text => /\bwait\s?-?lists?(ed)?\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'my_hours',
    tool: 'my_hours',
    /* `how` is in the qualifier set because "how mnay hours?" — a typo away from
       a phrasing that already worked — fell through to `unknown`, and a student
       who mistypes one word should not get "I can't help with that one". It
       widens nothing that was not already reachable: "how many hours is this
       shift" matched on `many` before this and matches on `how` now. */
    test: text =>
      /\bhours?\b/i.test(text)
      && /\b(my|i|me|have|got|how|many|much|total)\b/i.test(text)
      && !/\bexternal\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'my_certificates',
    tool: 'my_certificates',
    test: text => /\bcertificates?\b/i.test(text) && /\b(my|i|me|have|show|list)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'my_organizations',
    tool: 'my_organizations',
    test: text =>
      /\b(organi[sz]ations?|clubs?|groups?)\b/i.test(text)
      && /\b(my|i|me|belong|part of|member|in)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'my_applications',
    tool: 'my_applications',
    /**
     * Past-tense participation belongs here, not in the opportunity search.
     *
     * "What events did i participate in" contains the word `events`, so it fell
     * through to `search_opportunities`, which stripped the routing words and
     * searched the catalogue for the leftovers — "did participate in" — then
     * reported "I couldn't find any opportunities matching that". That is
     * exactly the failure this module's header says patterns exist to prevent:
     * a different question answered confidently, with nothing to tell the
     * student their question was changed.
     *
     * Gated on the PAST tense on purpose. "What events did I participate in" is
     * a history question; "What events can I participate in" is a search, and
     * both contain `participate`. The auxiliary is what separates them, so the
     * bare present tense is deliberately left to the search below.
     */
    test: text =>
      /\b(applied|applications?|signed up|sign-?ups?|volunteering for)\b/i.test(text)
      || /\b(participated|attended|took part|been to|went to)\b/i.test(text)
      || /\bdid i\b.{0,20}\b(participate|attend|go|volunteer|do)\b/i.test(text)
      || /\bhave i\b.{0,20}\b(participated|attended|been|volunteered)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'organizer_summary',
    tool: 'organizer_summary',
    test: text =>
      /\b(volunteers?|applicants?|sign-?ups?|pending)\b/i.test(text)
      && /\b(how many|total|summary|across|all)\b/i.test(text)
      && /\b(my|i)\b/i.test(text),
    slots: () => ({}),
  },
  {
    /**
     * Before the opportunity search, and possessive on purpose.
     *
     * "my events" and "events" differ by one word and mean opposite things: one
     * is the organizer's own roster, the other is the public catalogue. Without
     * the possessive requirement an organizer asking about their own events
     * would be shown everybody's.
     */
    intent: 'my_events',
    tool: 'my_events',
    test: text =>
      /\b(events?|opportunit(y|ies))\b/i.test(text)
      && /\b(my|i run|i organi[sz]e|i'?m running|i created|i host|i'?m hosting)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'platform_stats',
    tool: 'platform_stats',
    test: text =>
      /\b(platform|site|whole school|overall|everyone)\b/i.test(text)
      && /\b(stats?|statistics|totals?|how many|numbers)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'system_health',
    tool: 'system_health',
    test: text =>
      /\b(system|platform|anything|something)\b/i.test(text)
      && /\b(health|healthy|broken|failing|errors?|down|wrong)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'recent_audit',
    tool: 'recent_audit',
    test: text => /\baudit\b/i.test(text) || /\bwhat happened\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'search_opportunities',
    tool: 'search_opportunities',
    /* The noun is necessary and no longer sufficient — see SEARCH_INTENT. */
    test: text =>
      /\b(opportunit(y|ies)|events?|volunteer(ing)?|shifts?|help out|somewhere to)\b/i.test(text)
      && (SEARCH_INTENT.test(text) || isTerse(text)),
    slots: text => {
      const slots = {};
      if (NEARBY.test(text)) slots.wantsNearby = true;

      /**
       * `#tag` is already how tags are written in browse and directory search,
       * so the same spelling means the same thing here.
       *
       * Deliberately stops at whitespace, unlike `normaliseTag`, which permits
       * a single space inside a tag. In a sentence there is no way to tell
       * where a multi-word tag ends: "#environment or #gardening" would
       * otherwise capture "environment or". Losing multi-word tags typed inline
       * is the lesser problem — they can still be searched for in browse, and a
       * silently wrong tag returns confidently empty results.
       */
      const tags = [...text.matchAll(/#([\p{L}\p{N}][\p{L}\p{N}-]*)/gu)]
        .map(m => m[1].trim())
        .filter(Boolean);
      if (tags.length) slots.tags = tags;

      /* Whatever is left over, once the routing words are removed, is the topic
         to search for. Sending the whole sentence would match almost nothing,
         because the server matches substrings against titles and descriptions. */
      const query = text
        .replace(CERTIFICATE_CODE, ' ')
        .replace(/#[\p{L}\p{N}][\p{L}\p{N} -]*/gu, ' ')
        .replace(NEARBY, ' ')
        .replace(/\b(find|show|me|any|some|are|there|what|whats|what's|is|the|a|an|for|to|i|can|could|you|please|opportunit(y|ies)|events?|volunteer(ing)?|shifts?|near|open|coming up|this|weekend|week)\b/gi, ' ')
        .replace(/[?!.,]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (query) slots.query = query;

      return slots;
    },
  },
  {
    intent: 'capabilities',
    tool: null,
    test: text =>
      /\b(what can you|what do you|help me with|who are you|what are you)\b/i.test(text),
    slots: () => ({}),
  },
  {
    /**
     * A greeting is not an unanswerable question.
     *
     * "Hi" returned "I can't help with that one", which reads as a rebuff to
     * somebody who has not asked for anything yet. It is also the first thing
     * most people type. Answering it with the capability list turns the opening
     * move into an orientation instead of a refusal.
     *
     * LAST in the list, and matched against the WHOLE message, so it only fires
     * when a greeting is all there is. "Hi, how many hours do I have?" is
     * matched by `my_hours` above and never reaches this.
     */
    intent: 'greeting',
    tool: null,
    test: text => GREETING.test(text) || SMALLTALK.test(text),
    slots: () => ({}),
  },
];

/**
 * Requests that must be refused rather than routed.
 *
 * Checked before anything else. These are not questions the assistant is bad
 * at — they are things it must not appear willing to do, because appearing
 * willing is itself the harm. A student asking to see somebody else's private
 * record should be told plainly that this is not possible, not handed an empty
 * search result that reads as "nothing found this time".
 */
const REFUSALS = [
  {
    intent: 'refuse_other_user_data',
    /**
     * Deliberately broad on the "whose" half.
     *
     * An earlier version listed only `someone else`, `another student`,
     * `their`, `his`, `her` and `everyone`. It let through "show me every
     * student's hours", which then matched the personal-hours pattern on the
     * words "me" and "hours" and was answered as though it had been asked about
     * the person doing the asking.
     *
     * The request would have been refused by the server regardless — the tool
     * can only ever fetch the signed-in person's own record — so no data was
     * reachable. But answering somebody's request for everyone's hours with
     * their own total, and no indication the question was changed, is its own
     * kind of wrong. Quantifiers over people are named explicitly now.
     */
    test: text =>
      /\b(someone else|somebody else|another (student|user|person|volunteer)|other (students|users|people|volunteers)|(every|each|all|any) (student|user|person|volunteer|students|users|people|volunteers)|everyone|everybody|their|his|her|them)\b/i.test(text)
      && /\b(hours?|certificates?|records?|profiles?|emails?|address|phone|grade|school)\b/i.test(text),
  },
  {
    intent: 'refuse_credentials',
    test: text => /\b(password|passcode|2fa|two[- ]factor|recovery code|token|api key)\b/i.test(text),
  },
  {
    intent: 'refuse_account_action',
    test: text =>
      /\b(delete|deactivate|close|ban|suspend|promote|demote|approve|reject|award|grant)\b/i.test(text)
      && /\b(my )?(account|user|student|hours?|certificate|admin|role|application)\b/i.test(text),
  },
];

/**
 * Work out what a message is asking for.
 *
 * Returns `{ intent, tool, slots }`. `tool` is null for intents answered
 * without looking anything up — refusals, the capability list, and the
 * "verify what?" case.
 *
 * Returns intent `unknown` rather than guessing. An assistant that answers
 * everything is an assistant that answers some things wrongly, and at this
 * model size the wrong answers would outnumber the right ones for phrasings
 * nobody anticipated.
 */
export function routeIntent(message) {
  const raw = String(message || '').trim();
  if (!raw) return { intent: 'empty', tool: null, slots: {} };

  /* Routing decisions are made on the repaired text; slots are still filled
     from it too, since a search query built from a misspelling finds nothing
     either. See repairTypos. */
  const text = repairTypos(raw);

  for (const refusal of REFUSALS) {
    if (refusal.test(text)) return { intent: refusal.intent, tool: null, slots: {} };
  }

  /**
   * Before the matchers, and NOT handed to the model.
   *
   * The first version of this returned `unknown`, which is the conversational
   * path, on the reasoning that CHAT_PROMPT tells the model it does not know
   * this school's rules. Measured against the 1.5B model, asked "does driving
   * someone to practice count as volunteering?", it answered:
   *
   *     "Yes, driving someone to practice can be considered volunteering, as it
   *      involves providing assistance and support to help them improve their
   *      skills."
   *
   * A ruling, with no hedge, on a question the platform does not decide. A
   * student would log those hours and have them refused by the person who does.
   *
   * This is the rule `prompts/tasks.js` already states from its own
   * measurements: negative instructions do not hold at this size, and anything
   * enforceable after the fact is enforced after the fact. So eligibility gets
   * a fixed answer — free conversation continues everywhere else, and the one
   * class of question where a confident wrong answer costs a student real hours
   * is answered by the application instead.
   */
  /* Ahead of everything: an action request mentioning an event would otherwise
     be read as a search for one. See ACTION_REQUEST. */
  if (ACTION_REQUEST.test(text)) {
    return { intent: 'action_request', tool: null, slots: {} };
  }

  if (ELIGIBILITY.test(text) && QUESTION_SHAPE.test(text)) {
    return { intent: 'eligibility_question', tool: null, slots: {} };
  }

  for (const matcher of MATCHERS) {
    if (matcher.test(text)) {
      return { intent: matcher.intent, tool: matcher.tool, slots: matcher.slots(text) };
    }
  }

  return { intent: 'unknown', tool: null, slots: {} };
}
