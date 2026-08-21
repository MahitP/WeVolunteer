/**
 * Deciding what a question is about, without asking the model.
 *
 * ── The Router Architecture ──
 *
 * 1. Typos repair: Damerau-Levenshtein comparison for key routing terms.
 * 2. Refusals: Guardrails refusing credentials, PII of others, or destructive account acts.
 * 3. Confirmations: Explicit confirmation/cancellation for draft workflows.
 * 4. Informational queries: Clear platform knowledge requests answered without tool calls.
 * 5. Action requests & Eligibility: Intercepted before matchers so rules and actions are not hallucinated.
 * 6. Navigation: Allowlisted navigation to application screens.
 * 7. Matchers: Specific record lookups, event queries, and tool invocations.
 * 8. Fallback to conversational chat: Unmatched queries handled under CHAT_PROMPT.
 */

import { resolveNavigation } from './navigation.js';

/** `WEV-XXXX-XXXX`, the shape minted by `server/certificates.js`. */
const CERTIFICATE_CODE = /\bWEV-[0-9A-HJ-NP-Z]{4}-[0-9A-HJ-NP-Z]{4}\b/i;

/** Words that mean "close to me". */
const NEARBY = /\b(near(by| me| here)?|close(st| by| to me)?|around here|walking distance)\b/i;

/** Repairing near-misses on routing keywords. */
const REPAIRABLE = [
  'hours',
  'certificates',
  'organizations',
  'volunteering',
  'opportunities',
  'applications',
  'notifications',
];

/** Words that are already correct and must never be "repaired". */
const SPELLED_CORRECTLY = new Set([
  ...REPAIRABLE,
  'hour', 'certificate', 'organization', 'organizations', 'application',
  'opportunity', 'volunteer', 'volunteers', 'event', 'events', 'shift', 'shifts',
  'notification', 'notifications', 'roster', 'appeal', 'appeals', 'report', 'reports',
]);

/** Damerau-Levenshtein, capped at 1. */
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

/** Rewrites near-misses so matchers see the word that was meant. */
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
 */
const ACTION_REQUEST = new RegExp([
  /\b(create|make|add|set ?up|schedule|post|publish|start)\b.{0,20}\b(event|opportunit(y|ies)|shift|slot)\b/,
  /\b(delete|remove|cancel|close|edit|change|update)\b.{0,20}\b(event|opportunit(y|ies)|shift|slot|application)\b/,
  /\b(approve|reject|accept|decline|waitlist)\b.{0,20}\b(applicant|application|volunteer|student)\b/,
  /\b(sign me up|apply me|register me|book me)\b/,
].map(r => r.source).join('|'), 'i');

/** Questions about eligibility and platform policies. */
const ELIGIBILITY = /\b(counts?|allowed|eligible|qualif(y|ies)|permitted|supposed to|rules?|policy|okay to|ok to|fine to)\b/i;
const QUESTION_SHAPE = /^\s*(does|do|is|are|am|can|could|may|should|would|will|what|why|if)\b/i;

/**
 * Intent to search for opportunities.
 *
 * `any` used to be in the first group on its own, which made "Any advice?" and
 * "Any tips for a first time volunteer?" search requests — the word says
 * nothing by itself. It now has to reach the thing being asked for, within one
 * sentence: `[^.?!]` cannot cross a full stop, so "Any advice? … opportunities"
 * two sentences later does not match, while "any #environment or #gardening
 * opportunities" does. The window is 40 characters because that real query
 * needs 26 of them.
 */
const SEARCH_INTENT = new RegExp([
  /\b(find|show|search|browse|list|available|upcoming|recommend|suggest)\b/,
  /\bany\b[^.?!]{0,40}\b(opportunit(y|ies)|events?|shifts?|slots?|openings?)\b/,
  /\bopen\b[^.?!]{0,40}\b(opportunit(y|ies)|events?|shifts?|slots?|spots?)\b/,
  /\b(looking for|sign ?up for|what'?s on)\b/,
  /\b(near|nearby|around|close (by|to)|this (week|weekend|month))\b/,
  /\bcan i\b.{0,15}\b(do|join|participate|attend|help|sign ?up|volunteer)\b/,
].map(r => r.source).join('|'), 'i');

/**
 * The message is talking ABOUT the domain rather than asking Welly to look
 * something up in it.
 *
 * ── Why this is one guard and not six tightened rules ──
 *
 * Several tool rules fire on a domain noun plus a very weak second signal:
 * `my_applications` on the word "application" alone, `my_organizations` on
 * "organization" plus the word "in", `my_next_shift` on "next" plus "I".
 * Those are cheap and mostly right, because most sentences containing
 * "application" ARE about the reader's applications.
 *
 * They are wrong in one recognisable class, and it is a class a student hits
 * immediately:
 *
 *   "I am nervous about my first volunteering shift. Any advice?"
 *      → an opportunity search, answered "I couldn't find any opportunities"
 *   "Do you think volunteering looks good on a college application?"
 *      → their applications list
 *   "Our organization is planning something big and I am excited."
 *      → their organizations list
 *
 * What those have in common is not a keyword. It is that they ask for advice,
 * or narrate an experience, rather than requesting a record. Tightening each
 * rule separately would mean encoding that same judgement six times and
 * missing it on the seventh; stating it once, before any tool matches, keeps
 * the rules as simple as they should be.
 *
 * Deliberately narrow. It suppresses TOOLS only — refusals, informational
 * answers, confirmations and navigation are matched before it — and it looks
 * for explicit advice-seeking or explicit first-person feeling, not for the
 * absence of a request. "Show my applications" contains neither and is
 * untouched, which `router.test.js` and `intentCoverage.test.js` both hold.
 */
const ADVICE_SOUGHT = new RegExp([
  /\bany\s+(other\s+)?(advice|tips?|suggestions?|pointers?|ideas?)\b/,
  /\b(advice|tips?)\s+(for|on|about)\b/,
  /\b(do|what do) you think\b/,
  /\bshould i\b/,
  /\bis it (normal|okay|ok|weird|bad|fine|worth it)\b/,
  /\bhow do i (stay|get better|cope|deal|handle|prepare|make friends|feel less)\b/,
  /\bwhat (should|do) i (wear|bring|say|expect|do first)\b/,
].map(r => r.source).join('|'), 'i');

const EXPERIENCE_TOLD = new RegExp([
  /\bi(?:'m| am|'ve been| have been| was| felt| feel| get| got)\s+(so |really |a bit |kind of |quite |very |pretty )?(nervous|worried|anxious|scared|excited|happy|sad|tired|exhausted|stressed|overwhelmed|proud|glad|upset|terrible|awful|nervous|unsure|confused|lost|embarrassed)\b/,
  /\bi(?:'m| am)\s+(thinking|planning|hoping|wondering|considering)\b/,
  /\bit (was|is|felt)\s+(so |really |very |pretty )?(fun|great|good|hard|tough|exhausting|tiring|boring|amazing|nice|awful|terrible|worth it)\b/,
  /\bi (loved|hated|enjoyed|miss|missed|regret)\b/,
  /\bmade me (feel|so)\b/,
].map(r => r.source).join('|'), 'i');

/** True when the message is conversation about the domain, not a lookup in it. */
const isTalkingAbout = text => ADVICE_SOUGHT.test(text) || EXPERIENCE_TOLD.test(text);

/** Terse search queries (<= 3 words). */
const isTerse = text => String(text).trim().split(/\s+/).length <= 3;

/** Greetings and smalltalk. */
const GREETING = /^(hi+|hey+|hello+|hullo|yo|hiya|howdy|sup|greetings|good (morning|afternoon|evening|day))([\s,]+(there|welly))?[\s!.,?]*$/i;
const SMALLTALK = /^((can|can'?t|why can'?t)\s+(you|u)\s+(talk|chat|speak)|(u|you)\s+(can'?t|cannot)\s+(talk|chat|speak)|what happened to (free )?chat|(are|r)\s+(you|u)\s+(there|real|a bot|human|an ai)|how are (you|u)|how'?s it going|what'?s up|sup|who are you|what is your name)[\s!.,?]*$/i;

/** Affirmations, gratitude and conversational wrap-ups. */
const AFFIRMATION = /^(thanks?|thank you|ty|thx|cool|awesome|great|perfect|ok|okay|k|alright|got it|understood|sounds good|will do|nice)[\s!.,?]*$/i;

/**
 * Requests that must be refused immediately for safety and privacy.
 */
const REFUSALS = [
  {
    intent: 'refuse_other_user_data',
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

/** Informational question matchers (evaluated BEFORE Action Requests) */
const INFORMATIONAL_MATCHERS = [
  {
    intent: 'info_selection',
    tool: null,
    test: text =>
      /\b(auto[- ]?select|equalizer|lottery|selection (process|algorithm|run)|why was(n't| not) i selected|how does selection work)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'info_how_events_work',
    tool: null,
    test: text =>
      (/\b(how (do|does|to)|explain|what is)\b/i.test(text)
        && /\b(events?|event creation|creating events?|organizing events?)\b/i.test(text))
      || /\b(how do organizers create events|how does event creation work|how do events work)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'info_how_applications_work',
    tool: null,
    test: text =>
      (/\b(how (do|does|to)|explain|what happens)\b/i.test(text)
        && /\b(applications?|applying|sign ?ups?|after i apply)\b/i.test(text)
        && !/\b(withdraw my|cancel my)\b/i.test(text))
      || /\b(how does (?:withdrawing|withdrawal) work|how do i withdraw|what happens if i withdraw)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'info_role_capabilities',
    tool: null,
    test: text =>
      (/\bwhat can\b/i.test(text) && /\b(organizers?|admins?|administrators?|students?|volunteers?|roles?)\b/i.test(text) && /\b(do|access)\b/i.test(text))
      || /\b(what do organizers do|what do admins do|what does an admin do|what can an admin do)\b/i.test(text),
    slots: () => ({}),
  },
  /**
   * A question about the turn that just happened, rather than about hours.
   *
   * "why?", "how come?", "why do I have zero?" used to match the `info_hours`
   * rule below, which meant a bare "why?" produced the two-paragraph
   * explanation of verified and external hours NO MATTER what the previous
   * answer had been about — ask about certificates, say "why?", and read about
   * hours. The rule was right about the commonest case and had no way to be
   * right about any other.
   *
   * `followup_why` is answered by `getConversationalReply`, which reads the
   * previous assistant turn and explains hours, applications, certificates or
   * opportunities accordingly — and falls back to the hours explanation when
   * the previous turn was about hours, so the common case is unchanged.
   *
   * Bounded to SHORT questions on purpose. "Why do volunteers need training
   * before a shift?" is a question in its own right, not a follow-up, and
   * belongs in conversation where the model or the fixed answer can take it.
   */
  {
    intent: 'followup_why',
    tool: null,
    test: text => {
      const t = String(text).trim();
      if (!/^(why|how come)\b/i.test(t)) return false;
      /**
       * A follow-up refers to the previous turn, so it names nothing itself.
       * "Why do I have verified hours?" names its own subject and is a question
       * about how hours work; "Why do I have zero?" names nothing and only
       * makes sense after an answer. Testing for a subject is what separates
       * them — a word count alone put both in the same bucket.
       */
      if (/\b(hours?|certificates?|applications?|events?|shifts?|opportunit(y|ies)|organi[sz]ations?|badges?|clubs?|volunteers?)\b/i.test(t)) {
        return false;
      }
      /* And short: past about six words it is a question in its own right even
         without naming one of ours. */
      return t.split(/\s+/).length <= 6;
    },
    slots: () => ({}),
  },
  /**
   * An interjection, which is a turn even though it asks nothing.
   *
   * These matched `info_hours` too — "oof" returned the hours explanation.
   * `getConversationalReply` answers them from the previous turn, and returns
   * null when there is nothing to react to, which falls through to the ordinary
   * conversational path.
   */
  {
    intent: 'reaction',
    tool: null,
    /**
     * Unambiguous interjections only.
     *
     * "bruh", "sad" and "sigh" are in `getConversationalReply`'s own list but
     * deliberately not here: `router.test.js` pins "Bruh" as noise, on the
     * grounds that inventing an intent for it is the guessing this router
     * exists to avoid, and that reasoning holds. Nothing is lost by leaving
     * them out — the reaction branch returns null without matching context
     * anyway, so both paths end at the same sentence.
     */
    test: text => /^(dang( it)?|darn( it)?|damn( it)?|aww?|aw man|bummer|oh no|oof|yay|woohoo|awesome|cool|nice|sweet|great)[\s!.,?]*$/i.test(String(text).trim()),
    slots: () => ({}),
  },
  {
    intent: 'info_hours',
    tool: null,
    test: text =>
      !/\b(how many hours|check my hours|what are my (?:verified )?hours|show my hours)\b/i.test(text)
      && ((/\b(how (do|does|are)|explain|why (do|are|is)|what are)\b/i.test(text)
        && /\b(volunteer hours|hours work|hours verified|verified hours|getting hours|logging hours|0 hours|no hours)\b/i.test(text))
      || /\b(why do i have (?:0|zero|no|verified) hours|what are verified hours|how do hours work)\b/i.test(text)),
    slots: () => ({}),
  },
  {
    intent: 'info_certificates',
    tool: null,
    test: text =>
      (/\b(how (do|does)|explain|what (is|are))\b/i.test(text)
        && /\b(certificates? work|certificate code|certificate verification|official certificates?)\b/i.test(text))
      || /\b(what are official certificates|how do certificates work)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'info_organizations',
    tool: null,
    test: text =>
      /\b(how (do|does)|explain)\b/i.test(text)
      && /\b(clubs? work|organizations? work|joining a club|student organizer)\b/i.test(text),
    slots: () => ({}),
  },
];

/** Specific tool matchers */
const MATCHERS = [
  /* ── 1. Confirmations & Cancellations for Draft Lifecycle ────────────────── */
  {
    intent: 'confirm_action',
    tool: null,
    test: text => /^(yes|yeah|yep|confirm|do it|go ahead|sure|create it|withdraw it|update it|yes please|confirm it)\s*[!.]?$/i.test(text.trim()),
    slots: () => ({}),
  },
  {
    intent: 'cancel_action',
    tool: null,
    test: text => /^(no|cancel|don'?t do it|stop|nevermind|never mind|abort|discard)\s*[!.]?$/i.test(text.trim()),
    slots: () => ({}),
  },

  /* ── 2. Verification Lookups ─────────────────────────────────────────────── */
  {
    intent: 'verify_certificate',
    tool: 'verify_certificate',
    test: text => CERTIFICATE_CODE.test(text),
    slots: text => ({ code: text.match(CERTIFICATE_CODE)[0].toUpperCase() }),
  },
  {
    intent: 'verify_certificate_missing_code',
    tool: null,
    test: text => /\b(verify|validate|check)\b/i.test(text) && /\bcertificate\b/i.test(text) && !/\bhow\b/i.test(text),
    slots: () => ({}),
  },

  /* ── 3. Navigation Requests ──────────────────────────────────────────────── */
  {
    intent: 'navigate',
    tool: null,
    test: text => {
      const isExplicitNav = /^(take\s+me\s+to|go\s+to|open|navigate\s+to)\b/i.test(text)
        || /\b(the|to\s+the)\s+[a-z\s]+\s+(page|screen|section)\b/i.test(text);
      return isExplicitNav && Boolean(resolveNavigation(text));
    },
    slots: text => {
      const nav = resolveNavigation(text);
      return { destination: nav?.key || null, path: nav?.path || null, label: nav?.label || null };
    },
  },

  /* ── 4. Specific Tool Actions ────────────────────────────────────────────── */
  {
    intent: 'withdraw_application',
    tool: 'withdraw_application',
    test: text =>
      /\bwithdraw\b/i.test(text)
      && /\b(my\s+)?(application|sign-?up|registration)\b/i.test(text),
    slots: text => {
      const slots = {};
      const idMatch = text.match(/\b(app-[a-z0-9-]+)\b/i);
      if (idMatch) slots.applicationId = idMatch[1];
      return slots;
    },
  },
  {
    intent: 'update_profile',
    tool: 'update_profile',
    test: text =>
      /\b(update|change|edit)\s+my\s+(bio|headline|about me)\b/i.test(text),
    slots: text => {
      const slots = { fields: {} };
      const bioMatch = text.match(/bio\s+(?:to\s+)?["']?([^"']+)["']?$/i);
      if (bioMatch) slots.fields.bio = bioMatch[1].trim();
      return slots;
    },
  },
  {
    intent: 'update_preferences',
    tool: 'update_preferences',
    test: text =>
      /\b(update|change)\s+my\s+(notification\s+preferences?|channel\s+preferences?)\b/i.test(text),
    slots: () => ({}),
  },

  /* ── 5. Personal Record Lookups ──────────────────────────────────────────── */
  {
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
    test: text =>
      /\b(applied|applications?|signed up|sign-?ups?|volunteering for)\b/i.test(text)
      || /\b(participated|attended|took part|been to|went to)\b/i.test(text)
      || /\bdid i\b.{0,20}\b(participate|attend|go|volunteer|do)\b/i.test(text)
      || /\bhave i\b.{0,20}\b(participated|attended|been|volunteered)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'my_notifications',
    tool: 'my_notifications',
    test: text =>
      /\b(notifications?|alerts?)\b/i.test(text)
      && /\b(my|show|what|recent|unread)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'my_profile',
    tool: 'my_profile',
    test: text =>
      /\b(profile|bio|account details)\b/i.test(text)
      && /\b(my|show|what is|view)\b/i.test(text),
    slots: () => ({}),
  },

  /* ── 6. Organizer Tools & Chaining ───────────────────────────────────────── */
  {
    intent: 'my_vacant_events',
    tool: 'my_vacant_events',
    test: text =>
      /\b(events?|shifts?)\b/i.test(text)
      && /\b(need(s)?\s+(more\s+)?volunteers?|vacan(t|cy)|open spots?)\b/i.test(text)
      && /\b(my|i run|i host)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'event_roster',
    tool: 'event_roster',
    test: text =>
      /\b(roster|attendees?|who is attending|attendance list)\b/i.test(text),
    slots: text => {
      const idMatch = text.match(/\b(event-[a-z0-9-]+)\b/i);
      return idMatch ? { eventId: idMatch[1] } : {};
    },
  },
  {
    intent: 'organizer_summary',
    tool: 'organizer_summary',
    /**
     * Two shapes, because organizers ask for this two ways.
     *
     * The three-part conjunction below describes the question — "how many
     * volunteers do I have across all my events" — and it is the one somebody
     * types when they are thinking about volunteers. The named alternative
     * above it is what they type when they are thinking about the FEATURE, and
     * it is what Welly's own organizer suggestion offers: "Show my organizer
     * statistics" matched none of the three parts and fell through to
     * `unknown`, so pressing Welly's own chip answered "I can't help with that
     * one."
     *
     * Deliberately anchored on "organizer". A bare "show my stats" from a
     * student would land here and be refused for lacking `event.create`, which
     * is a worse answer than the hours they were asking about.
     */
    test: text =>
      /\borgani[sz]er\s+(stats?|statistics|summary|overview|numbers)\b/i.test(text)
      || (/\b(volunteers?|applicants?|sign-?ups?|pending)\b/i.test(text)
      && /\b(how many|total|summary|across|all)\b/i.test(text)
      && /\b(my|i)\b/i.test(text)),
    slots: () => ({}),
  },
  {
    intent: 'my_events',
    tool: 'my_events',
    test: text =>
      /\b(events?|opportunit(y|ies))\b/i.test(text)
      && /\b(my|i run|i organi[sz]e|i'?m running|i created|i host|i'?m hosting)\b/i.test(text),
    slots: () => ({}),
  },

  /* ── 7. Admin Tools ──────────────────────────────────────────────────────── */
  {
    intent: 'admin_reports_summary',
    tool: 'admin_reports_summary',
    test: text =>
      /\b(reports?|moderation queue)\b/i.test(text)
      && /\b(open|pending|admin|summary)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'admin_appeals_summary',
    tool: 'admin_appeals_summary',
    test: text =>
      /\b(appeals?|suspension appeals?)\b/i.test(text)
      && /\b(open|pending|admin|summary|review)\b/i.test(text),
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
    test: text => /\baudit\b/i.test(text) || /\bwhat happened today\b/i.test(text),
    slots: () => ({}),
  },

  /* ── 8. General Search ───────────────────────────────────────────────────── */
  {
    intent: 'event_details',
    tool: 'event_details',
    test: text =>
      /\b(event-[a-z0-9-]+)\b/i.test(text) && /\b(details?|about|info|slots?)\b/i.test(text),
    slots: text => {
      const match = text.match(/\b(event-[a-z0-9-]+)\b/i);
      return { eventId: match ? match[1] : null };
    },
  },
  {
    intent: 'create_event',
    tool: 'create_event',
    test: text =>
      /\b(draft|new event workflow)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'search_opportunities',
    tool: 'search_opportunities',
    test: text =>
      /\b(opportunit(y|ies)|events?|volunteer(ing)?|shifts?|help out|somewhere to)\b/i.test(text)
      && (SEARCH_INTENT.test(text) || isTerse(text)),
    slots: text => {
      const slots = {};
      if (NEARBY.test(text)) slots.wantsNearby = true;

      const tags = [...text.matchAll(/#([\p{L}\p{N}][\p{L}\p{N}-]*)/gu)]
        .map(m => m[1].trim())
        .filter(Boolean);
      if (tags.length) slots.tags = tags;

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

  /* ── 9. Core System & Orientation Intents ────────────────────────────────── */
  {
    intent: 'capabilities',
    tool: null,
    test: text =>
      /\b(what can you|what do you|help me with|what are you)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'affirmation',
    tool: null,
    test: text => AFFIRMATION.test(text),
    slots: () => ({}),
  },
  {
    intent: 'greeting',
    tool: null,
    test: text => GREETING.test(text) || SMALLTALK.test(text),
    slots: () => ({}),
  },
];

/**
 * Route user text to an intent and tool.
 */
export function routeIntent(message) {
  const raw = String(message || '').trim();
  if (!raw) return { intent: 'empty', tool: null, slots: {} };

  const text = repairTypos(raw);

  /* 1. Refusals always checked first */
  for (const refusal of REFUSALS) {
    if (refusal.test(text)) return { intent: refusal.intent, tool: null, slots: {} };
  }

  /* 2. Informational questions before action requests */
  for (const infoMatcher of INFORMATIONAL_MATCHERS) {
    if (infoMatcher.test(text)) {
      return { intent: infoMatcher.intent, tool: null, slots: {} };
    }
  }

  /* 3. Action requests and eligibility interceptors */
  if (ACTION_REQUEST.test(text)) {
    return { intent: 'action_request', tool: null, slots: {} };
  }

  if (ELIGIBILITY.test(text) && QUESTION_SHAPE.test(text)) {
    return { intent: 'eligibility_question', tool: null, slots: {} };
  }

  /**
   * 4. Matchers — unless the message is talking about the domain rather than
   *    asking Welly to look something up in it.
   *
   * The guard sits here rather than inside each rule, and after everything
   * above it, so a refusal, an informational question, an action request and a
   * confirmation are all still matched from a sentence that also happens to
   * seek advice. What it suppresses is the tool lookup — see `isTalkingAbout`.
   *
   * Suppression falls through to `unknown`, which is a CONVERSATIONAL intent:
   * `assistant.js` sends it to the model when one is loaded and to
   * `getConversationalReply` when one is not. So the reader gets an answer to
   * what they asked rather than an empty search result.
   */
  const talking = isTalkingAbout(text);

  for (const matcher of MATCHERS) {
    if (!matcher.test(text)) continue;
    /* Confirmations, cancellations and navigation are decisions about the
       conversation itself and are never incidental keyword matches. */
    const alwaysHonoured = ['confirm_action', 'cancel_action', 'navigate'].includes(matcher.intent);
    if (talking && !alwaysHonoured) break;
    return { intent: matcher.intent, tool: matcher.tool, slots: matcher.slots(text) };
  }

  return { intent: 'unknown', tool: null, slots: {} };
}
