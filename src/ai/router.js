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
    intent: 'my_hours',
    tool: 'my_hours',
    test: text =>
      /\bhours?\b/i.test(text)
      && /\b(my|i|me|have|got|many|much|total)\b/i.test(text)
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
    test: text =>
      /\b(applied|applications?|signed up|sign-?ups?|volunteering for)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'search_opportunities',
    tool: 'search_opportunities',
    test: text =>
      /\b(opportunit(y|ies)|events?|volunteer(ing)?|shifts?|help out|somewhere to)\b/i.test(text),
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
  const text = String(message || '').trim();
  if (!text) return { intent: 'empty', tool: null, slots: {} };

  for (const refusal of REFUSALS) {
    if (refusal.test(text)) return { intent: refusal.intent, tool: null, slots: {} };
  }

  for (const matcher of MATCHERS) {
    if (matcher.test(text)) {
      return { intent: matcher.intent, tool: matcher.tool, slots: matcher.slots(text) };
    }
  }

  return { intent: 'unknown', tool: null, slots: {} };
}
