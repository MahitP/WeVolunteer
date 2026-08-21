/**
 * Turning a question into an answer.
 *
 * ── The shape of every turn ──
 *
 *   message → router (deterministic) → one tool / action → facts
 *                                                             ├── card    (authoritative)
 *                                                             └── prose   (model, optional)
 *
 * The card is the authoritative answer. It is built from the tool result by plain
 * code, it is what the interface renders, and it is correct whether or not a model is
 * loaded, fast, or any good. The model writes the sentence above it.
 *
 * ── Safe Mutations & Confirmation Lifecycle ──
 *
 * Write tools never execute immediately. They produce an explicit draft card
 * and await the user's explicit confirmation ("confirm" / "yes").
 */

import { routeIntent } from './router.js';
import { TOOLS, runTool, normalizeEventCategory } from './tools.js';
import { AIStatus } from './runtime/types.js';
import { isAbort } from './runtime/types.js';
import { SYSTEM_PROMPT, CHAT_PROMPT, isUsableReply, WELLY_NAME } from './prompts/welly.js';
import { asDataBlock } from './prompts/tasks.js';
import { checkRole, actionReplyFor, abilitiesFor } from './roles.js';
import { getInformationalAnswer } from './informational.js';
import { resolveNavigation } from './navigation.js';
import {
  createDraft,
  getPendingDraft,
  updateActiveDraft,
  confirmDraft,
  cancelDraft,
} from './confirm.js';
import { can } from '../authz.js';
import { api } from '../utils/api.js';

/** Replies are comfortably sized to prevent cutting off sentences mid-thought. */
const MAX_REPLY_TOKENS = 512;

/** Answers that need no lookup. */
const FIXED = {
  empty: 'Ask me about opportunities, your hours, your certificates, or the organizations you are part of.',

  unknown:
    "I can't help with that one. I can look up opportunities, your volunteer hours, your "
    + 'certificates, the organizations you are part of, and what you have applied to.',

  affirmation:
    "You're welcome! Let me know if you need anything else with WeVolunteer.",

  greeting:
    'Hi. I can find opportunities, tell you your verified hours, list your certificates '
    + 'and organizations, show what you have applied to, and check a certificate code. '
    + 'What would you like to look at?',

  action_request:
    'I can look things up, but I can\'t create or change anything myself. Events are '
    + 'set up from the Create event page, and applications are decided by the organizer '
    + 'running the event. I can show you what already exists, though.',

  eligibility_question:
    'I can\'t tell you what counts — that is set by your school or the organizer running '
    + 'the event, and it is worth asking them directly. What I can do is show you the '
    + 'hours already credited to you, or what you have applied to.',

  capabilities:
    'I can find opportunities, tell you your verified hours, list your certificates and '
    + 'organizations, show what you have applied to, and check a certificate code. '
    + 'I can suggest things, but I never decide them.',

  verify_certificate_missing_code:
    'Send me the code from the certificate and I will check it. They look like WEV-XXXX-XXXX.',

  refuse_other_user_data:
    "I can only look at your own record, so I can't answer that. Public profiles are on the "
    + 'member directory.',

  refuse_credentials:
    "I can't see passwords, codes or anything used to sign in — nobody can, including me. "
    + 'You can change your password in Settings under Security.',

  refuse_account_action:
    "I can't change anything about an account. Deleting an account is in Settings under "
    + 'Security, and decisions about hours, places and certificates are made by organizers '
    + 'and administrators.',
};

/**
 * The sentence to show when there is no model, or the model failed.
 */
function summarise(kind, data) {
  switch (kind) {
    case 'hours': {
      const h = data.hours;
      if (!h) return 'You do not have any verified hours yet.';
      return `You have ${h} verified ${h === 1 ? 'hour' : 'hours'}.`;
    }
    case 'certificates':
      if (!data.total) return 'You do not have any certificates yet.';
      return `You have ${data.total} ${data.total === 1 ? 'certificate' : 'certificates'}.`;
    case 'organizations':
      if (!data.total) return 'You are not part of any organizations yet.';
      return `You are part of ${data.total} ${data.total === 1 ? 'organization' : 'organizations'}.`;
    case 'applications':
      if (!data.total) return 'You have not applied to anything yet.';
      return `You have applied to ${data.total} ${data.total === 1 ? 'opportunity' : 'opportunities'}.`;
    case 'opportunities':
      if (!data.total) return "I couldn't find any opportunities matching that.";
      return `I found ${data.total} ${data.total === 1 ? 'opportunity' : 'opportunities'}.`;
    case 'certificate':
      return data.valid
        ? `That certificate is valid: ${data.hours ?? 0} hours for ${data.eventTitle || 'an event'}.`
        : 'No certificate matches that code.';
    case 'notifications':
      if (!data.total) return 'You have no recent notifications.';
      return `You have ${data.total} recent ${data.total === 1 ? 'notification' : 'notifications'}.`;
    case 'profile':
      return `Profile for ${data.name || 'you'} (${data.role || 'volunteer'}) with ${data.hours || 0} verified hours.`;
    case 'event_details':
      return `Details for ${data.title}: ${data.slots?.length || 0} shifts available.`;
    case 'event_roster':
      return `Roster for event ${data.eventId}: ${data.total} ${data.total === 1 ? 'volunteer' : 'volunteers'} registered.`;
    case 'vacant_events':
      if (!data.total) return 'None of your active events currently need volunteers.';
      return `You have ${data.total} ${data.total === 1 ? 'event' : 'events'} needing more volunteers.`;
    case 'admin_reports':
      return `There are currently ${data.openReports || 0} open safety reports requiring moderator review.`;
    case 'admin_appeals':
      if (!data.total) return 'There are no pending suspension appeals.';
      return `There are ${data.total} pending suspension ${data.total === 1 ? 'appeal' : 'appeals'}.`;

    /**
     * ── The seven that used to fall through ──
     *
     * Every kind below reached `default` and answered "Here is what I found."
     * None of them has a card renderer either (see AssistantCard's switch), so
     * the lookup succeeded, the data came back, and the reader was shown one
     * sentence containing none of it. Three of Welly's own suggestion
     * chips land here — "What is my next shift?" for a student, "Show my
     * events" and "Show my organizer statistics" for an organizer — so pressing
     * what Welly offers produced an answer with nothing in it.
     *
     * This has been true since before the assistant grew these tools: the same
     * seven were unsummarised at 42768bf, when there were thirteen kinds rather
     * than twenty-four. It is not a regression, and the sentence is the cheap
     * half of the fix — the cards are still missing and are worth building.
     */
    case 'next_shift': {
      if (!data.next) return 'You have nothing coming up that has been accepted yet.';
      const { eventTitle, slotName, startsAt, hours } = data.next;
      const where = [eventTitle, slotName].filter(Boolean).join(' — ');
      const length = hours ? ` It is ${hours} ${hours === 1 ? 'hour' : 'hours'}.` : '';
      return `Your next shift is ${where || 'a shift'}${startsAt ? `, ${startsAt}` : ''}.${length}`;
    }

    case 'waitlists': {
      if (!data.total) return 'You are not on any waitlists at the moment.';
      const first = data.items?.[0];
      const place = first?.position
        ? ` You are number ${first.position} for ${first.eventTitle || 'the first one'}.`
        : '';
      return `You are waitlisted for ${data.total} ${data.total === 1 ? 'shift' : 'shifts'}.${place}`;
    }

    case 'my_events': {
      if (!data.total) return 'You are not running any events at the moment.';
      return `You are running ${data.total} ${data.total === 1 ? 'event' : 'events'}.`;
    }

    case 'organizer_summary':
      if (!data.events) return 'You are not running any events yet, so there is nothing to total up.';
      return `Across your ${data.events} ${data.events === 1 ? 'event' : 'events'}: `
        + `${data.volunteers} ${data.volunteers === 1 ? 'volunteer' : 'volunteers'}, `
        + `${data.hours} ${data.hours === 1 ? 'hour' : 'hours'} credited, and `
        + `${data.pending} ${data.pending === 1 ? 'application' : 'applications'} still to review.`;

    case 'platform_stats':
      return `The platform has ${data.users} ${data.users === 1 ? 'member' : 'members'}, `
        + `${data.events} ${data.events === 1 ? 'event' : 'events'}, and `
        + `${data.hours} ${data.hours === 1 ? 'hour' : 'hours'} of credited service. `
        + `${data.openReports === 0 ? 'No reports are open.' : `${data.openReports} ${data.openReports === 1 ? 'report is' : 'reports are'} open.`}`;

    case 'system_health':
      if (!data.openGroups && !data.last24h) return 'Nothing is failing right now.';
      return `${data.openGroups} open ${data.openGroups === 1 ? 'error group' : 'error groups'}, `
        + `and ${data.last24h} ${data.last24h === 1 ? 'error' : 'errors'} in the last 24 hours.`;

    case 'recent_audit': {
      if (!data.total) return 'There is nothing in the audit trail yet.';
      const latest = data.items?.[0];
      const tail = latest?.action ? ` The most recent is "${latest.action}"${latest.at ? `, ${latest.at}` : ''}.` : '';
      return `The audit trail has ${data.total} recent ${data.total === 1 ? 'entry' : 'entries'}.${tail}`;
    }
    case 'application_withdrawn':
      return 'Your application has been withdrawn.';
    case 'profile_updated':
      return `Your profile has been updated (${(data.updated || []).join(', ')}).`;
    case 'preferences_updated':
      return 'Your notification preferences have been updated.';
    case 'event_created':
      return `Event "${data.title}" has been created successfully.`;
    default:
      return 'Here is what I found.';
  }
}

/**
 * What to say when the lookup itself failed.
 */
function failureMessage(reason) {
  switch (reason) {
    case 'offline':
      return "I couldn't reach WeVolunteer just now, so I can't check that. It might be your connection.";
    case 'rate_limited':
      return "That has been checked a lot recently, so I can't look right now. Try again in a few minutes — "
        + 'this says nothing about whether the certificate is genuine.';
    case 'not_allowed':
      return "You don't have access to that.";
    case 'not_found':
      return "I couldn't find a record matching that.";
    case 'missing_code':
      return FIXED.verify_certificate_missing_code;
    case 'missing_application_id':
      return "Please specify which application you would like to withdraw.";
    default:
      return "I couldn't look that up just now. Please try again.";
  }
}

/** The untrusted payload, fenced and labelled. */
function dataBlock(kind, data) {
  return asDataBlock(`DATA (${kind})`, JSON.stringify(data));
}

/**
 * Results where the deterministic sentence is already the best answer.
 */
function isEmptyResult(kind, data) {
  switch (kind) {
    case 'hours': return !data.hours;
    case 'certificate': return data.valid !== true;
    case 'certificates':
    case 'organizations':
    case 'applications':
    case 'opportunities':
    case 'notifications':
    case 'vacant_events':
    case 'admin_appeals': return !data.total;
    case 'admin_reports': return !data.openReports;
    default: return false;
  }
}

/**
 * What to say when the role gate refuses.
 */
function refusedForRole(user, intent, permission) {
  const list = abilitiesFor(user);
  const alternatives = `I can ${list.slice(0, -1).join(', ')} and ${list.at(-1)}.`;
  if (permission?.reason === 'resource_out_of_scope') {
    return `You can only access or modify your own records. ${alternatives}`;
  }
  return `That is not something your account can ask me for. ${alternatives}`;
}

/** Recent turns given back to the model. */
const CHAT_HISTORY_TURNS = 6;

/**
 * The only thing done to a model reply before it is shown.
 *
 * ── Why this is three whitespace rules and not a repair kit ──
 *
 * This function used to do rather more: strip leading punctuation, rejoin
 * "can 't" into "can't", pull spaces off the front of a comma, collapse runs of
 * horizontal whitespace, and rewrite a list of customer-service phrases into
 * friendlier ones. Every one of those was written to fix output that looked
 * like this in the transcript:
 *
 *     "Hello, how are you"
 *     "?I'm sorry, but I can't assist with"
 *
 * That output was never the model's. It is the signature of the StrictMode
 * placeholder bug fixed in 6f37388 — an impure state updater captured an index
 * from a discarded invocation, so tokens landed in the previous bubble and each
 * reply began with the tail of the one before it. The repairs were added
 * against the symptom; the cause had already been fixed at the right layer, and
 * `WellyView` addresses its placeholder by id for exactly that reason.
 *
 * Left in place, the repairs cost more than they bought:
 *
 *   - collapsing `[ \t]+` and stripping indentation flattens fenced code and
 *     every nested list level,
 *   - the contraction rule rewrites `said 'yes' quickly` into `said'yes' quickly`
 *     because a quoted word is indistinguishable from a split contraction,
 *   - stripping a leading `?` silently deletes a legitimate one-character reply,
 *   - and the phrase rewrites change what the model said, which is the one thing
 *     a presentation layer must never do.
 *
 * What remains is meaning-preserving by construction. CRLF is a transport
 * artefact; a byte-order mark and zero-width joiners at the very start are
 * tokenizer noise with no visual form; trailing whitespace on the whole string
 * is invisible. Nothing here can move a character, so a reply that streamed as
 * one thing cannot commit as another — which is the property
 * `responseQuality.test.js` pins.
 */
export function formatResponseText(text) {
  if (!text || typeof text !== 'string') return '';

  return text
    /* Transport, not content: a model that emits CRLF means one line break. */
    .replace(/\r\n?/g, '\n')
    /* A BOM or zero-width character leading the very first token renders as
       nothing and breaks a `startsWith` check somewhere downstream. Only at the
       start, and only zero-width: a zero-width joiner inside the string is
       holding an emoji sequence together. */
    .replace(/^[\uFEFF\u200B-\u200D]+/, '')
    .trim();
}

/**
 * The recent turns handed back to the model.
 *
 * ── Why this no longer edits what Welly said ──
 *
 * It used to. An assistant turn that did not end in `.`, `!` or `?` had any
 * trailing preposition or conjunction cut off and a full stop appended, so
 *
 *     "I'm sorry, but I can't assist with"
 *
 * went back into the next prompt as
 *
 *     "I'm sorry, but I can't assist."
 *
 * — a different sentence, asserting the opposite of what the transcript on
 * screen says, and now permanently disagreeing with it. The student reads one
 * thing and the model is told another.
 *
 * The fragments that motivated it came from the bubble bug above rather than
 * from truncation, and a genuinely truncated turn is better handled by the
 * model seeing what actually happened. So history is now filtered and bounded
 * and nothing else: the turn that goes back is the turn that was shown.
 */
export function sanitizeHistory(history, maxTurns = CHAT_HISTORY_TURNS) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .slice(-maxTurns)
    .map(m => ({ role: m.role, content: formatResponseText(m.text) }));
}

/**
 * Answer conversationally, with no lookup behind it.
 */
async function chat(message, { runtime, onToken, signal, history = [] }) {
  try {
    const rawMsg = String(message || '').trim();
    // Do not pass lone punctuation to the model (prevents KV cache degeneration)
    if (/^[.?!,:;]+$/.test(rawMsg)) return null;

    const recent = sanitizeHistory(history);

    const text = await runtime.generate(
      [
        { role: 'system', content: CHAT_PROMPT },
        ...recent,
        { role: 'user', content: rawMsg },
      ],
      { onToken, signal, maxTokens: MAX_REPLY_TOKENS },
    );

    const cleaned = formatResponseText(text);

    if (!isUsableReply(cleaned)) return null;

    // Reject if the model echoed the user's message back verbatim (e.g. User: "What is?" -> Model: "What is")
    const normUser = rawMsg.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normModel = cleaned.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normUser.length > 0 && normModel === normUser) return null;

    return { intent: 'chat', answer: cleaned, card: null, phrasedByModel: true };
  } catch (err) {
    if (isAbort(err)) return { intent: 'chat', answer: '', card: null, cancelled: true, phrasedByModel: false };
    return null;
  }
}

/**
 * Context-aware conversational responses when on-device model is unavailable or in standard mode.
 */
function getConversationalReply(intent, message, { history = [], user = null } = {}) {
  const lastAssistantTurn = [...history].reverse().find(m => m.role === 'assistant');
  const lastText = (lastAssistantTurn?.text || '').toLowerCase();
  const raw = String(message || '').trim().toLowerCase();

  // Language switching / preferences
  if (/\b(hablo ingles|yo hablo ingles|speak english|english please|no hablo espanol|i don'?t speak spanish)\b/i.test(raw)) {
    return "Got it, English it is! What would you like to check out — finding volunteer shifts, looking up your hours, or something else?";
  }

  // Asking what Welly can do / "idk how can you"
  if (/\b(how can you|how do you help|what can you help with|how can you help)\b/i.test(raw)) {
    return "I can help with a lot! For example, I can find volunteer opportunities near you, check your verified hours, show your applications, or answer questions about volunteering and clubs. Want to start by searching for opportunities or checking your hours?";
  }

  // Punctuation noise / empty input
  if (/^[.?!,:;\\-]+$/.test(raw)) {
    return "How can I help you today? Feel free to ask about volunteer opportunities, your hours, applications, or anything else on WeVolunteer.";
  }

  // Clarification questions referring to previous assistant turn
  if (/^(what is\??|what do you mean\??|what\??|which\??|which one\??|huh\??|what is what\??)$/i.test(raw)) {
    if (lastText.includes('paris') || lastText.includes('france')) {
      return "Paris! It's famous for its culture, landmark architecture, and history. Let me know if you want to chat more or look up volunteer opportunities!";
    }
    if (lastAssistantTurn?.text) {
      return `I was referring to: "${lastAssistantTurn.text.slice(0, 120).trim()}${lastAssistantTurn.text.length > 120 ? '...' : ''}". Let me know what you'd like to explore further!`;
    }
    return "Could you specify what you'd like to know more about? I'm happy to help!";
  }

  // Casual indecision, filler or hesitation
  if (/^(idk|i don'?t know|not sure|im not sure|i'?m not sure|hmm+|um+|uh+|huh|what should i (do|ask)|where do i start)[\s!.,?]*$/i.test(raw)) {
    return "No worries at all! Here are a few great things you can ask me to do:\n• Find open volunteer opportunities near you\n• Check your verified volunteer hours\n• View what you've applied to\n• Explain how service certificates or clubs work\n\nWhat would you like to explore first?";
  }

  // Reactions when there is prior conversational context
  if (intent === 'reaction'
    || /^(dang( it)?|darn( it)?|damn( it)?|aww?|aw man|bummer|oh no|oof|sad|bruh?|sigh|yay|woohoo|awesome|cool|nice|sweet|great)[\s!.,?]*$/i.test(raw)) {
    if (lastText.includes('verified hours') || lastText.includes('do not have any verified hours') || lastText.includes('0 verified')) {
      return "Don't worry! Verified hours are credited once you attend a volunteer shift and the event organizer signs off on attendance. Would you like me to help you find an upcoming event to get started?";
    }
    if (lastText.includes('couldn\'t find any opportunities') || lastText.includes('0 opportunit')) {
      return "New opportunities are added regularly by local organizations and schools. You can also search for different categories or check back soon!";
    }
    if (/^(yay|woohoo|awesome|cool|nice|sweet|great)[\s!.,?]*$/i.test(raw)) {
      return "Glad to hear! Let me know if there's anything else you'd like to check or do.";
    }
    return null;
  }

  /**
   * A follow-up about the turn before it.
   *
   * Keyed on the INTENT rather than on the exact wording. The pattern that used
   * to gate this branch listed the phrasings somebody had thought of — "why?",
   * "how come?", "why do I have 0 hours?" — and "Why do I have zero?" was not
   * one of them, so a perfectly ordinary follow-up fell past every branch below
   * and got the generic "I can't help with that one". The router now decides
   * what counts as a short follow-up (see `followup_why` there); this decides
   * what to say about it, from what was said last.
   */
  if (intent === 'followup_why'
    || /^(why\??|why not\??|how come\??|why though\??|why\s*(?:do i have\s*)?(?:0|zero|no)\s*hours\??)$/i.test(raw)) {
    if (/\b(select|selected|lottery|auto ?select|chosen|picked)\b/i.test(raw)
      || lastText.includes('auto select') || lastText.includes('waitlist')) {
      return "Events with more applicants than spots use Auto Select: after the application deadline a weighted draw runs, which gives a little more weight to people who have had fewer opportunities so far. Everyone not drawn goes onto the waitlist in draw order, and moves up if someone withdraws.";
    }
    if (lastText.includes('verified hours') || lastText.includes('do not have any verified hours') || lastText.includes('0 verified') || /hours/i.test(raw)) {
      return "Hours only appear as verified once you complete a volunteer shift and the organizer marks your attendance on the event roster. If you recently attended an event, it may still be pending organizer verification.";
    }
    if (lastText.includes('applied to') || lastText.includes('applications')) {
      return "Applications remain in pending status until the organizer reviews and accepts them, or until the selection lottery runs if the event uses Auto Select.";
    }
    if (lastText.includes('certificate')) {
      return "Official certificates are generated when you complete verified service hours or when an organizer awards one with a code like WEV-XXXX-XXXX.";
    }
    if (lastText.includes('opportunit')) {
      return "Opportunities are listed whenever partner non-profits, schools, or community organizers post open volunteer shifts.";
    }
    return "I'm grounded directly in your live WeVolunteer records and platform rules. Let me know what specific detail you'd like me to explain!";
  }

  // Common conversational inquiries
  if (/\b(what is wevolunteer|tell me about wevolunteer|how does wevolunteer work)\b/i.test(raw)) {
    return "WeVolunteer is a community platform designed for students, volunteers, and organizers. It makes finding local volunteer shifts easy, automatically tracks verified service hours, generates official certificates with verification codes, and helps community organizers coordinate events smoothly.";
  }

  if (/\b(how (do|can) i (get|earn|find) (more )?(volunteer )?hours|how to get hours|how to earn hours)\b/i.test(raw)) {
    return "You can earn verified volunteer hours by browsing the Discover page, finding shifts that fit your schedule, and applying. Once you attend and check in, the event organizer verifies your attendance and hours are credited directly to your profile!";
  }

  if (/\b(what should i wear|what to bring|prepare for (a )?shift|dress code)\b/i.test(raw)) {
    return "For most volunteer shifts, we recommend wearing comfortable closed-toe shoes, weather-appropriate clothing you don't mind getting a little dirty, and bringing a refillable water bottle. Be sure to check the specific event details on WeVolunteer for any organizer instructions!";
  }

  if (/\b(tell (me )?a joke|joke)\b/i.test(raw)) {
    return "Why did the volunteer bring a ladder to the food drive? Because they wanted to help out at the highest level! 😄 Let me know if you'd like to check out upcoming opportunities near you.";
  }

  if (/\b(can (we|you) (just )?talk|talk to me|free chat|let'?s chat|chat with me)\b/i.test(raw)) {
    return "I'm always here to chat! We can discuss volunteering ideas, upcoming community events, how hours and certificates work, or anything else you're curious about. What's on your mind?";
  }

  if (/\b(why do people volunteer|benefits of volunteering|why should i volunteer)\b/i.test(raw)) {
    return "Volunteering is a great way to make a tangible difference in your community, develop leadership skills, meet like-minded peers, fulfill school service requirements, and build a verified service portfolio for college or career applications.";
  }

  if (intent === 'affirmation' || /^(thanks?|thank you|ty|thx)[\s!.,?]*$/i.test(raw)) {
    return "You're welcome! Let me know whenever you need anything else with WeVolunteer.";
  }

  return null;
}

export async function ask(
  message,
  { runtime = null, position = null, onToken, signal, history = [], user = null } = {},
) {
  const { intent, tool, slots } = routeIntent(message);

  /* ── 1. Role Gate ────────────────────────────────────────────────────────── */
  const permission = checkRole(user, intent);
  if (!permission.allowed) {
    return {
      intent: 'not_permitted',
      answer: refusedForRole(user, intent, permission),
      card: null,
      phrasedByModel: false,
    };
  }

  /* ── 2. Draft Lifecycle Confirmations & Cancellations ─────────────────────── */
  if (intent === 'confirm_action') {
    const pending = getPendingDraft(null, { user });
    if (!pending) {
      return {
        intent,
        answer: "There is no pending action to confirm. What would you like help with?",
        card: null,
        phrasedByModel: false,
      };
    }

    const { ok: confirmed, draft, reason } = confirmDraft(pending.id, { user });
    if (!confirmed || !draft) {
      return {
        intent,
        answer: reason === 'user_mismatch'
          ? "This action was prepared by a different user session."
          : "The pending action has expired or was already processed.",
        card: null,
        phrasedByModel: false,
      };
    }

    const result = await runTool(draft.tool, draft.args, { user });
    if (!result.ok) {
      return {
        intent,
        answer: failureMessage(result.reason),
        card: null,
        toolFailed: true,
        phrasedByModel: false,
      };
    }

    const summary = summarise(result.kind, result.data);
    return {
      intent,
      answer: summary,
      card: { kind: result.kind, data: result.data },
      phrasedByModel: false,
    };
  }

  if (intent === 'cancel_action') {
    const { ok: cancelled } = cancelDraft(null, { user });
    return {
      intent,
      answer: cancelled
        ? "I've cancelled that action. Nothing was changed."
        : "No actions are currently pending.",
      card: null,
      phrasedByModel: false,
    };
  }

  /* ── 3. Informational Knowledge Answers ──────────────────────────────────── */
  const infoAnswer = getInformationalAnswer(intent);
  if (infoAnswer) {
    return {
      intent,
      answer: infoAnswer,
      card: null,
      phrasedByModel: false,
    };
  }

  /* ── 4. Navigation Requests ──────────────────────────────────────────────── */
  if (intent === 'navigate') {
    const nav = resolveNavigation(message, user);
    if (nav && nav.allowed) {
      return {
        intent: 'navigate',
        answer: `Navigating to ${nav.label}.`,
        card: { kind: 'navigate', data: { path: nav.path, label: nav.label } },
        navigate: nav.path,
        phrasedByModel: false,
      };
    } else if (nav && !nav.allowed) {
      return {
        intent: 'not_permitted',
        answer: refusedForRole(user, 'navigate', { reason: 'role_not_permitted' }),
        card: null,
        phrasedByModel: false,
      };
    }
  }

  /* ── 5. Conversational Draft Modification & Action Requests ─────────────── */
  const pending = getPendingDraft(null, { user });
  if (pending && pending.tool === 'create_event') {
    const spotsCorrection = message.match(/\b(?:make it|change spots to|set spots to|actually)\s*(\d+)\s*(?:spots|volunteers|people)?\b/i);
    const locCorrection = message.match(/\b(?:change location to|set location to|location should be)\s+["']?([^"',]+)["']?/i);

    if (spotsCorrection || locCorrection) {
      const updatedSlots = [...pending.args.slots];
      if (spotsCorrection) {
        const newSpots = parseInt(spotsCorrection[1], 10);
        if (newSpots > 0 && newSpots <= 100) {
          updatedSlots[0] = { ...updatedSlots[0], maxSpots: newSpots };
        }
      }
      const updatedArgs = {
        slots: updatedSlots,
        ...(locCorrection ? { location: locCorrection[1].trim() } : {}),
      };
      const updated = updateActiveDraft(updatedArgs, {
        user,
        preview: `Create event "${pending.args.title}" (${updatedSlots[0].maxSpots} spots at ${updatedArgs.location || pending.args.location})`,
      });

      return {
        intent: 'action_request',
        answer: `I've updated the draft:\n\nTitle: ${updated.args.title}\nLocation: ${updated.args.location}\nSpots: ${updated.args.slots[0].maxSpots}\n\nReply "confirm" to create this event, "cancel" to discard, or set it up directly on the Create event page.`,
        card: { kind: 'draft', data: updated },
        draft: true,
        phrasedByModel: false,
      };
    }
  }

  if (intent === 'action_request') {
    const isCreateEventRequest = /\b(create|make|add|set ?up|draft|post|schedule|new)\b.{0,20}\b(event|shift|opportunity)\b/i.test(message);

    if (isCreateEventRequest && can(user, 'event.create')) {
      const titleMatch = message.match(/(?:called|named|title[d]?)\s+["']?([^"',]+)["']?/i);
      const locMatch = message.match(/(?:at|location)\s+["']?([^"',]+)["']?/i);
      const spotsMatch = message.match(/(\d+)\s+(?:spots|volunteers|people)/i);

      const eventData = {
        title: titleMatch ? titleMatch[1].trim() : 'Community Service Event',
        category: normalizeEventCategory(slots.category || 'Other'),
        location: locMatch ? locMatch[1].trim() : 'Community Center',
        description: `Volunteer event for ${titleMatch ? titleMatch[1].trim() : 'community service'}.`,
        applicationDeadline: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        slots: [{
          name: 'General Shift',
          startDatetime: new Date(Date.now() + 8 * 86400000).toISOString(),
          endDatetime: new Date(Date.now() + 8 * 86400000 + 3600000 * 3).toISOString(),
          maxSpots: spotsMatch ? parseInt(spotsMatch[1], 10) : 10,
        }],
      };

      const draft = createDraft({
        tool: 'create_event',
        args: eventData,
        preview: `Create event "${eventData.title}" (${eventData.slots[0].maxSpots} spots at ${eventData.location})`,
        summary: `Create event "${eventData.title}"`,
        user,
      });

      return {
        intent: 'action_request',
        answer: `Event draft prepared:\n\nTitle: ${eventData.title}\nLocation: ${eventData.location}\nSpots: ${eventData.slots[0].maxSpots}\n\nThis hasn't been created yet. Reply "confirm" to create this event, "cancel" to discard, or set it up directly on the Create event page.`,
        card: { kind: 'draft', data: draft },
        draft: true,
        phrasedByModel: false,
      };
    }

    return {
      intent,
      answer: actionReplyFor(user, { kind: slots.kind || 'event' }),
      card: null,
      phrasedByModel: false,
    };
  }

  if (intent === 'capabilities') {
    const list = abilitiesFor(user);
    return {
      intent,
      answer: `I can ${list.slice(0, -1).join(', ')} and ${list.at(-1)}. `
        + 'I can suggest things, but I never decide them.',
      card: null,
      phrasedByModel: false,
    };
  }

  /* ── 6. Write Tool Drafting (Draft-and-Confirm Lifecycle) ────────────────── */
  if (tool && TOOLS[tool] && TOOLS[tool].mode === 'write') {
    if (tool === 'withdraw_application') {
      let targetId = slots.applicationId;
      let eventTitle = null;

      if (!targetId) {
        try {
          const apps = await api.fetchApplications();
          const list = Array.isArray(apps) ? apps : [];
          const active = list.filter(a => a.status === 'pending' || a.status === 'accepted' || a.status === 'waitlisted');
          if (active.length === 1) {
            targetId = active[0].id;
            eventTitle = active[0].event?.title || active[0].eventTitle;
          }
        } catch {
          // ignore lookup failure, fall through
        }
      }

      if (!targetId) {
        return {
          intent,
          answer: "Which application would you like to withdraw? You can specify the event name or application ID.",
          card: null,
          phrasedByModel: false,
        };
      }

      const draft = createDraft({
        tool: 'withdraw_application',
        args: { applicationId: targetId },
        preview: `Withdraw application for ${eventTitle || targetId}`,
        summary: `Withdraw application for ${eventTitle || targetId}`,
        user,
      });

      return {
        intent,
        answer: `Are you sure you want to withdraw your application for ${eventTitle || targetId}? Reply "confirm" to proceed or "cancel" to keep your spot.`,
        card: { kind: 'draft', data: draft },
        draft: true,
        phrasedByModel: false,
      };
    }

    if (tool === 'update_profile') {
      const fields = slots.fields || {};
      if (!fields || Object.keys(fields).length === 0) {
        return {
          intent,
          answer: "What would you like to update on your profile? (For example: 'update my bio to...')",
          card: null,
          phrasedByModel: false,
        };
      }

      const draft = createDraft({
        tool: 'update_profile',
        args: { fields },
        preview: `Update profile (${Object.keys(fields).join(', ')})`,
        summary: `Update profile (${Object.keys(fields).join(', ')})`,
        user,
      });

      return {
        intent,
        answer: `I've prepared a draft to update your profile (${Object.keys(fields).join(', ')}). Reply "confirm" to apply changes or "cancel" to abort.`,
        card: { kind: 'draft', data: draft },
        draft: true,
        phrasedByModel: false,
      };
    }

    if (tool === 'create_event') {
      const eventData = {
        title: slots.title || 'Community Service Event',
        category: normalizeEventCategory(slots.category || 'Other'),
        location: slots.location || 'Local Community Center',
        description: slots.description || `Volunteer event for ${slots.title || 'community service'}.`,
        applicationDeadline: slots.applicationDeadline || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        slots: [{
          name: 'Volunteer Shift',
          startDatetime: new Date(Date.now() + 8 * 86400000).toISOString(),
          endDatetime: new Date(Date.now() + 8 * 86400000 + 3600000 * 3).toISOString(),
          maxSpots: slots.maxSpots || 10,
        }],
      };

      const draft = createDraft({
        tool: 'create_event',
        args: eventData,
        preview: `Create event "${eventData.title}" (${eventData.slots[0].maxSpots} spots at ${eventData.location})`,
        summary: `Create event "${eventData.title}"`,
        user,
      });

      return {
        intent,
        answer: `Event draft prepared:\n\nTitle: ${eventData.title}\nLocation: ${eventData.location}\nSpots: ${eventData.slots[0].maxSpots}\n\nThis hasn't been created yet. Reply "confirm" to create this event, "cancel" to discard, or set it up directly on the Create event page.`,
        card: { kind: 'draft', data: draft },
        draft: true,
        phrasedByModel: false,
      };
    }
  }

  /* ── 7. Tool-less Responses & Conversational Fallback ────────────────────── */
  if (!tool) {
    /* `talk_check` was in this list too, for an intent the router has never
       emitted — smalltalk is folded into `greeting`. Removed rather than made
       reachable: `greeting` already answers it well, from
       `getConversationalReply`. */
    const isConversational = ['unknown', 'chat', 'reaction', 'followup_why', 'affirmation'].includes(intent);
    if (isConversational && runtime && runtime.status === AIStatus.READY) {
      const chatted = await chat(message, { runtime, onToken, signal, history });
      if (chatted) return chatted;
    }

    const conversationalAnswer = getConversationalReply(intent, message, { history, user });
    if (conversationalAnswer) {
      return {
        intent,
        answer: conversationalAnswer,
        card: null,
        phrasedByModel: false,
      };
    }

    return {
      intent,
      answer: FIXED[intent] || FIXED.unknown,
      card: null,
      phrasedByModel: false,
    };
  }

  /* ── 8. Read Tool Execution ──────────────────────────────────────────────── */
  const args = { ...slots };
  if (slots.wantsNearby && position) {
    args.lat = position.lat;
    args.lng = position.lng;
  }
  delete args.wantsNearby;

  const result = await runTool(tool, args, { user });

  if (!result.ok) {
    return {
      intent,
      answer: failureMessage(result.reason),
      card: null,
      toolFailed: true,
      phrasedByModel: false,
    };
  }

  const fallback = summarise(result.kind, result.data);
  const card = { kind: result.kind, data: result.data };

  if (!runtime || runtime.status !== AIStatus.READY || isEmptyResult(result.kind, result.data)) {
    return { intent, answer: fallback, card, phrasedByModel: false };
  }

  try {
    const text = await runtime.generate(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `${String(message).trim()}\n\n${dataBlock(result.kind, result.data)}`,
        },
      ],
      { onToken, signal, maxTokens: MAX_REPLY_TOKENS },
    );

    const formatted = formatResponseText(text);
    if (!isUsableReply(formatted)) return { intent, answer: fallback, card, phrasedByModel: false };
    return { intent, answer: formatted, card, phrasedByModel: true };
  } catch (err) {
    if (isAbort(err)) return { intent, answer: fallback, card, cancelled: true, phrasedByModel: false };
    return { intent, answer: fallback, card, phrasedByModel: false };
  }
}

export const __testing = {
  summarise,
  failureMessage,
  FIXED,
  SYSTEM_PROMPT,
  isEmptyResult,
  WELLY_NAME,
  formatResponseText,
  sanitizeHistory,
};

