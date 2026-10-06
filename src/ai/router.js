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

/**
 * Asking for an event to be created, when the sentence describes the event
 * rather than naming the word.
 *
 * ── Why ACTION_REQUEST was not enough ──
 *
 * `ACTION_REQUEST` wants a creation verb within twenty characters of the word
 * "event", "opportunity", "shift" or "slot". That covers "create an event" and
 * misses the sentence an organizer in a hurry actually types:
 *
 *     "Create a food drive at the community center on September 15
 *      from 9 AM to 1 PM with 20 volunteer spots."
 *
 * — which never says "event" at all, and was classified as `unknown`. The
 * assistant then had nothing to do with it, so the fastest possible way to
 * create an event was the one way that did not work.
 *
 * ── Why these two shapes and no more ──
 *
 * The first is the same verb-and-noun pair with a wider window, so a described
 * event ("set up a new volunteer event for the food pantry") still reaches it.
 *
 * The second is the sentence above: a creation verb, a determiner, and then —
 * within one sentence, because `[^.?!]` cannot cross a full stop — a COUNT of
 * volunteers. Both of the narrowing parts are load-bearing, and both were added
 * after watching the rule over-reach without them:
 *
 *   the determiner   without it, "make it 25 spots" matches — and that is a
 *                    correction to an event already being discussed, not a
 *                    request for a new one
 *   the number       without it, "can you make a list of my shifts" matches on
 *                    the word "shifts" alone, and a lookup becomes a write
 *
 * A number of volunteers is what nobody writes unless they are describing an
 * event to be staffed, which is why it is the signal this leans on.
 *
 * Both are still gated by `INTENT_CAPABILITY.create_event`, which is
 * `event.create`. A wider rule cannot widen who may use it.
 */
const CREATE_EVENT = new RegExp([
  /\b(create|make|set ?up|schedule|post|publish|host|organi[sz]e|run)\b[^.?!]{0,40}\b(event|opportunit(y|ies)|sign-?up sheet)\b/,
  /\b(create|make|set ?up|schedule|host|organi[sz]e|run)\s+(?:a|an|another|the|new)\b[^.?!]{0,140}\b\d{1,3}\s+(volunteers?|spots?|people|slots?|helpers?)\b/,
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
  /* Two ways of asking that found nothing before 2026-10-05, each held to the
     thing being looked for so that a question about the rules ("Can I apply to
     more than five events at once?") is not turned into a search:
     "what food pantry events can I apply to", and "events I can join". */
  /\b(what|which|any)\b[^.?!]{0,40}\bcan i\s+(apply|join|attend|participate|sign ?up|volunteer|help)\b/,
  /\b(opportunit(y|ies)|events?|shifts?|slots?|openings?)\s+(that\s+)?i (can|could)\s+(apply|join|attend|participate|sign ?up|volunteer|help)\b/,
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

/**
 * Which applications, when the question narrows it.
 *
 * ── The defect ──
 *
 * "Rejected Applications?" matched `my_applications` on the word "applications"
 * and produced no slots at all, so the tool returned every application and the
 * sentence over it said "You have applied to 3 opportunities." The reported
 * answer named accepted ones in reply to a question about rejected ones — and
 * it was not the model doing it, the tool genuinely returned them.
 *
 * ── Rejected before accepted ──
 *
 * The order of these tests is load-bearing. "not accepted" and "wasn't
 * accepted" both contain "accepted", so an accepted-first list answers the
 * opposite of what was asked. Every negation lives in the rejected pattern for
 * that reason rather than as a separate guard.
 *
 * Waitlisted is absent on purpose: `my_waitlists` is matched earlier and has a
 * card that shows the place in the queue, which is the thing somebody asking is
 * actually after.
 */
const APPLICATION_STATUS_WORDS = [
  ['rejected', /\b(rejected|declined|denied|turned down|unsuccessful|not (accepted|selected|chosen|picked)|wasn'?t (accepted|selected|chosen|picked)|did ?n(?:'|o)?t get (in|picked|selected|chosen))\b/i],
  ['accepted', /\b(accepted|approved|selected|chosen|got in|successful|confirmed)\b/i],
  ['pending', /\b(pending|waiting|undecided|not (yet )?(decided|answered)|still (open|out|waiting))\b/i],
  ['withdrawn', /\b(withdrawn|withdrew|cancell?ed|pulled out|backed out)\b/i],
];

function applicationStatusAsked(text) {
  for (const [status, pattern] of APPLICATION_STATUS_WORDS) {
    if (pattern.test(text)) return status;
  }
  return null;
}

/**
 * What somebody is searching FOR, with the asking stripped out.
 *
 * ── The defect ──
 *
 *     "Find volunteering opportunities near me"     → 1 opportunity
 *     "Search up Volunteering Oppertunities near me" → none found
 *
 * Same request, same database, same second. The phrase list below removed
 * "find", "opportunities", "near me" and the rest — but not "search" or "up".
 * So `query` came out as the literal string "Search up", which went to the
 * server as a free-text filter, matched no event title, and produced "I
 * couldn't find any opportunities matching that." A student reads that as
 * "there is nothing", not "you phrased it differently".
 *
 * ── Why a residue check and not more words on the list ──
 *
 * Adding "search" and "up" fixes that sentence and not the next one. The list
 * is subtractive: it removes what it recognises and TRUSTS WHATEVER IS LEFT to
 * be a topic, so every unlisted way of asking becomes a nonsense filter. The
 * failure is silent and looks exactly like an empty database.
 *
 * So the residue is checked instead. After the phrase pass, a token only counts
 * as a topic if it is not one of the words people ask WITH. Something unlisted
 * — "kindly dig up any gardening shifts" — leaves "kindly gardening", which is
 * a worse filter than "gardening" but still finds the gardening events; the old
 * shape would have searched for "kindly dig up".
 *
 * Wrong in the harmless direction, in other words, which is the opposite of
 * what it did before.
 */
const ASKING_WORDS = new Set([
  /* Verbs of requesting. */
  'search', 'find', 'look', 'looking', 'lookup', 'get', 'give', 'show', 'list',
  'need', 'want', 'wanted', 'help', 'see', 'check', 'browse', 'discover',
  /* Particles and fillers that survive a verb. */
  'up', 'out', 'me', 'my', 'i', 'im', 'you', 'your', 'us', 'we',
  'a', 'an', 'the', 'some', 'any', 'anything', 'something', 'stuff', 'things', 'thing',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'can', 'could',
  'would', 'will', 'shall', 'should', 'may', 'might', 'have', 'has', 'had', 'got',
  'to', 'for', 'of', 'on', 'in', 'at', 'by', 'with', 'from', 'about',
  'and', 'or', 'but', 'so', 'that', 'this', 'these', 'those', 'it', 'its',
  'there', 'here', 'please', 'hey', 'hi', 'hello', 'just', 'also', 'well',
  'what', 'whats', 'which', 'where', 'when', 'who', 'how',
  'near', 'nearby', 'close', 'around', 'local', 'area',
  /* Taking part. "Events I can join" is how a student asks, not what about:
     left in, "join" became a search term and found nothing (2026-10-05). */
  'join', 'joining', 'sign', 'signup', 'apply', 'applying', 'attend', 'attending',
  'participate', 'take', 'part', 'go', 'going',
  /* Timing a phrase above did not catch. Every search is for open events. */
  'available', 'upcoming', 'open', 'soon', 'today', 'tonight', 'tomorrow', 'weekend', 'weekends',
  /* The domain nouns. Every search is for these; naming one says nothing. */
  'opportunity', 'opportunities', 'event', 'events', 'shift', 'shifts',
  'volunteer', 'volunteering', 'volunteers', 'opening', 'openings', 'slot', 'slots',
]);

function searchTopic(text) {
  const stripped = String(text)
    .replace(CERTIFICATE_CODE, ' ')
    .replace(/#[\p{L}\p{N}][\p{L}\p{N} -]*/gu, ' ')
    .replace(NEARBY, ' ')
    /* Multi-word and inflected forms, which a per-token set cannot express. */
    .replace(/\b(coming up|this (weekend|week|month)|next (weekend|week|month)|right now)\b/gi, ' ')
    .replace(/[?!.,;:'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const topic = stripped
    .split(' ')
    .filter(w => w && !ASKING_WORDS.has(w.toLowerCase()))
    .join(' ');

  return topic;
}

/** `YYYY-MM-DD` for a local calendar day, the form the events API filters on. */
function localIso(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The day `n` days after `d`, at the same local time. */
function plusDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/**
 * The days a question means by "this weekend", "tomorrow" and the like, as
 * `{ from, to }`, or null when it names no time.
 *
 * "Find food bank events this weekend" used to search every date: the phrase
 * was removed from the search words (`searchTopic`) and then dropped. The
 * events API filters on the first shift's day, so this is passed as its
 * `from`/`to` (2026-10-05).
 *
 * Weeks run Monday to Sunday. "This weekend" on a Saturday or Sunday is the one
 * already under way; "next week" on a Sunday is the week that starts tomorrow.
 */
export function dateWindow(text, today = new Date()) {
  const t = String(text).toLowerCase();
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  const dow = (day.getDay() + 6) % 7; /* Monday 0 … Sunday 6 */
  const span = (a, b) => ({ from: localIso(a), to: localIso(b) });

  if (/\bnext weekend\b/.test(t)) {
    const saturday = plusDays(day, 12 - dow);
    return span(saturday, plusDays(saturday, 1));
  }
  if (/\b(this )?weekend\b/.test(t)) {
    if (dow === 6) return span(day, day);
    const saturday = plusDays(day, 5 - dow);
    return span(dow === 5 ? day : saturday, plusDays(saturday, 1));
  }
  if (/\bnext week\b/.test(t)) {
    const monday = plusDays(day, 7 - dow);
    return span(monday, plusDays(monday, 6));
  }
  if (/\bthis week\b/.test(t)) return span(day, plusDays(day, 6 - dow));
  if (/\bnext month\b/.test(t)) {
    return span(new Date(day.getFullYear(), day.getMonth() + 1, 1), new Date(day.getFullYear(), day.getMonth() + 2, 0));
  }
  if (/\bthis month\b/.test(t)) return span(day, new Date(day.getFullYear(), day.getMonth() + 1, 0));
  if (/\btomorrow\b/.test(t)) return span(plusDays(day, 1), plusDays(day, 1));
  if (/\b(today|tonight)\b/.test(t)) return span(day, day);
  return null;
}

/** Affirmations, gratitude and conversational wrap-ups. */
const AFFIRMATION = /^(thanks?|thank you|ty|thx|cool|awesome|great|perfect|ok|okay|k|alright|got it|understood|sounds good|will do|nice)[\s!.,?]*$/i;

/**
 * Somebody other than the asker having a record: "does Leo Chen have",
 * "has Priya logged", "did my friend earn".
 *
 * A name cannot be on a word list, so the question's shape is matched instead.
 * The subject may not be the asker ("I", "you" addressed to Welly) or a thing
 * ("it", "this", "the river cleanup"), which is what keeps "how many hours does
 * this event have" an ordinary question. Without it, "How many hours does Leo
 * Chen have?" was answered with the asker's own record (2026-10-05).
 */
const NAMED_SUBJECT =
  /\b(?:does|did|has)\s+(?!(?:i|you|it|this|that|these|those|the|a|an|we|one|there)\b)[\p{L}'’-]+(?:\s+[\p{L}'’-]+){0,2}?\s+(?:have|got|earn|earned|log|logged)\b/iu;

/**
 * Requests that must be refused immediately for safety and privacy.
 */
const REFUSALS = [
  {
    intent: 'refuse_other_user_data',
    test: text =>
      (/\b(someone else|somebody else|another (student|user|person|volunteer)|other (students|users|people|volunteers)|(every|each|all|any) (student|user|person|volunteer|students|users|people|volunteers)|everyone|everybody|their|his|her|them)\b/i.test(text)
        || NAMED_SUBJECT.test(text))
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
  /**
   * Who Welly is, what it runs on, and where "here" is.
   *
   * ── Three answers a 0.5B model cannot be trusted to give ──
   *
   * Measured against Qwen2.5-0.5B, none of these reached a rule, so all three
   * fell through to free conversation:
   *
   *   "who trained you"      -> "I was trained in WeVolunteer and are
   *                             volunteers."
   *   "what is this place"   -> "Welly, a place where students can volunteer."
   *   "what's my name"       -> "Your name is Welly."
   *
   * The second takes Welly's own name for the platform's. The third is the
   * same confusion pointed at the reader, and it is the one that matters: a
   * student asking whether the assistant knows who they are is told, with
   * total confidence, that they are the assistant.
   *
   * A prompt line cannot fix this — the model has no access to the answer for
   * the third one and no reliable grip on the first two. Each has exactly one
   * correct response, so each gets a rule.
   */
  /**
   * "How far is it?"
   *
   * ── Why this is a rule and not a search ──
   *
   * It matched nothing, so it fell to the unknown fallback: "I can't help with
   * that one. I can look up opportunities, your volunteer hours, …" — a list
   * that does not include the thing just asked for, in reply to a question
   * about the opportunity Welly had listed one turn earlier.
   *
   * The answer needs no lookup at all. The card already on screen carries the
   * event's coordinates and the app already has the reader's, so this is
   * arithmetic over context. See `distance_to_event` in assistant.js.
   *
   * ── What it deliberately does not match ──
   *
   * "How far am I from my goal" and "how far through the term" are not about
   * places. Requiring a distance word next to a place-ish or pronoun subject
   * keeps those out, and `intentCoverage` re-checks that the hours and
   * milestone questions still route where they did.
   */
  {
    intent: 'distance_to_event',
    tool: null,
    test: text =>
      (/\bhow\s+far\b/i.test(text)
        && !/\bhow far (through|along|into)\b/i.test(text)
        && !/\b(goal|target|milestone|award|hours?)\b/i.test(text))
      || /\bhow\s+close\s+(is|are)\b/i.test(text)
      || /\b(is|are)\s+(it|that|this|they|these|those)\s+(far|close|nearby|near)\b/i.test(text)
      || /\bdistance\s+(to|from)\b/i.test(text)
      || /\bhow\s+long\s+(does it take\s+)?to\s+get\s+(there|to it)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'identity_self',
    tool: null,
    test: text =>
      /\b(who|what)\s+(made|built|created|trained|wrote|designed|owns?)\s+(you|welly)\b/i.test(text)
      /* Not a bare "what version" — that is as likely to be about the app. */
      || /\b(what|which)\s+(ai|model|llm|engine|context window)\b/i.test(text)
      || /\b(are|r)\s+(you|u)\s+(chatgpt|gpt|claude|gemini|llama|siri|alexa|an? (llm|language model))\b/i.test(text)
      || /\bwhat\s+(are|r)\s+(you|u)\b/i.test(text)
      || /\bhow\s+(do|does)\s+(you|welly)\s+work\b/i.test(text)
      || /\bwhat('?s| is)\s+your\s+(context window|token limit|model)\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'identity_platform',
    tool: null,
    test: text =>
      /\bwhat('?s| is)\s+(this|the)\s+(app|site|website|platform|place|thing|program)\b/i.test(text)
      || /\b(this|the)\s+(app|site|website|platform|place)\s+(is\s+)?called\b/i.test(text)
      || /\bwhat\s+is\s+wevolunteer\b/i.test(text)
      || /\bwhere\s+am\s+i\b/i.test(text),
    slots: () => ({}),
  },
  {
    intent: 'my_name',
    tool: null,
    test: text =>
      /\bwhat('?s| is)\s+my\s+name\b/i.test(text)
      || /\b(do you|you)\s+know\s+(my name|who i am)\b/i.test(text)
      || /^who\s+am\s+i[\s!.,?]*$/i.test(text),
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
      /\b(update|change|edit)\s+my\s+(bio|about (me|you))\b/i.test(text),
    /**
     * "About you" is the bio's label in the profile editor. The headline is a
     * different field, on distinguished accounts only, and is not something
     * Welly can write, so it is not matched here: "update my headline to …"
     * drafted a bio change until 2026-10-05.
     *
     * Everything after "bio to" (or "bio:", "bio as"), with one pair of
     * surrounding quotes removed. The old pattern stopped at any quote mark,
     * so "I'm a junior" was not recognised at all, and it needed a space after
     * "to", so "bio to: I love…" saved "to: I love…" (2026-10-05).
     */
    slots: text => {
      const slots = { fields: {} };
      const bioMatch = text.match(/\b(?:bio|about (?:me|you))\b\s*(?:(?:to|as)\b)?\s*:?\s*(\S[\s\S]*)$/i);
      if (bioMatch) {
        const bio = bioMatch[1].trim().replace(/^["'“‘]([\s\S]*)["'”’]$/, '$1').trim();
        if (bio) slots.fields.bio = bio;
      }
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
    slots: text => {
      const status = applicationStatusAsked(text);
      return status ? { status } : {};
    },
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
      /\b(draft|new event workflow)\b/i.test(text)
      || CREATE_EVENT.test(text),
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

      const query = searchTopic(text);
      if (query) slots.query = query;

      const window = dateWindow(text);
      if (window) {
        slots.from = window.from;
        slots.to = window.to;
      }

      return slots;
    },
  },

  /* ── 9. Core System & Orientation Intents ────────────────────────────────── */
  {
    intent: 'capabilities',
    tool: null,
    test: text =>
      /\b(what can you|what do you|help me with)\b/i.test(text),
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
