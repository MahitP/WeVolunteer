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
import { TOOLS, runTool } from './tools.js';
import { AIStatus } from './runtime/types.js';
import { isAbort } from './runtime/types.js';
import { CHAT_PROMPT, isUsableReply, WELLY_NAME } from './prompts/welly.js';
import { checkRole, actionReplyFor, abilitiesFor } from './roles.js';
import { getInformationalAnswer } from './informational.js';
import { resolveNavigation } from './navigation.js';
import { haversineDistance } from '../utils/helpers.js';
import {
  createDraft,
  getPendingDraft,
  confirmDraft,
  cancelDraft,
  runConfirmedDraft,
} from './confirm.js';
import {
  beginEventDraft,
  getEventDraft,
  clearEventDraft,
  applyEventMessage,
  missingField,
  questionFor,
  buildEventPayload,
  describeEventDraft,
  explainInvalidEvent,
} from './eventDraft.js';
import { can } from '../authz.js';
import { api } from '../utils/api.js';
import { coarsePosition } from '../utils/coarsePosition.js';

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

  /**
   * Identity, written down rather than generated.
   *
   * Asked "who trained you", the on-device model answered "I was trained in
   * WeVolunteer and are volunteers" — a sentence with no true reading. Asked
   * what this place was, it answered "Welly, a place where students can
   * volunteer", having taken its own name for the platform's.
   *
   * Both have one correct answer, so neither is a generation. See the rules in
   * `router.js` for the third of the set.
   */
  /**
   * The model is named from the registry entry that is LOADED — see
   * `identityAnswer` — because this string used to say "Qwen2.5 0.5B" whatever
   * was running. Somebody on the Advanced model, which is Qwen2.5 1.5B, asked
   * Welly what it was and was told the name of the other one. This is the
   * fallback for when nothing is loaded and there is no model to name.
   */
  /**
   * ── Why this does not say "nothing you type here is sent anywhere" ──
   *
   * It used to, and that was the one place Welly overstated itself. The
   * sentence is true of INFERENCE and false of the feature: a search question
   * reaches `search_opportunities`, whose `query` slot is the residual of the
   * typed sentence — `searchTopic` strips certificate codes, tags, time
   * phrases and asking-words and keeps the rest — and `tools.js` sends it as
   * `q` to `GET /api/events`, where `shouldUseSemantic` may hand it to Pinecone
   * to be embedded server-side.
   *
   * The product had already reached this conclusion about this very sentence.
   * `WellyView.jsx`, beside the composer footer: "Nothing leaves your device …
   * is not true of the whole feature … Saying the stronger thing here would
   * make the assistant's one privacy claim the one place it overstates itself."
   * The footer follows that reasoning; this answer did not.
   *
   * The on-device claim stays, because it is true and it is the point. What
   * replaces the absolute half is the other thing the footer already says: a
   * lookup is answered by WeVolunteer's server, exactly as the rest of the app
   * is. That is a smaller promise and a keepable one.
   *
   * It also no longer says "your words are not sent to any AI service" (owner,
   * 2026-10-04). Pinecone runs a hosted embedding model over the words a search
   * sends, so that was the same overstatement in other words. What is true,
   * and what the footer and AI policy 2.0 now say, is narrower: no AI service
   * writes the replies, and a search sends the words searched for.
   */
  identity_self:
    'I am Welly, the assistant built into WeVolunteer by the people who make the app. '
    + 'I am software, not a person. When Welly AI is switched on I run a small open '
    + 'language model entirely on your own device, so no AI service writes my replies. '
    + 'Looking something up — your hours, your shifts, opportunities to join — is '
    + "answered by WeVolunteer's server, the same as the rest of the app, and a search "
    + 'sends the words you searched for.',

  identity_platform:
    'This is WeVolunteer — the app schools use to post volunteer events, sign students '
    + 'up for shifts, and credit the hours afterwards. Welly is just me, the assistant '
    + 'inside it.',

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
    case 'applications': {
      /* The status has to reach the sentence. A filtered empty result phrased
         as "you have not applied to anything yet" answers a different question
         than the one asked, and answers it wrongly. */
      if (!data.total) {
        return data.status
          ? `You have no ${data.status} applications.`
          : 'You have not applied to anything yet.';
      }
      /* The unfiltered wording is unchanged — it was right, and "you have 3
         applications" is a flatter sentence than "you have applied to 3
         opportunities" for no gain. */
      if (!data.status) {
        return `You have applied to ${data.total} ${data.total === 1 ? 'opportunity' : 'opportunities'}.`;
      }
      return `You have ${data.total} ${data.status} ${data.total === 1 ? 'application' : 'applications'}.`;
    }
    case 'opportunities':
      if (!data.total) return "I couldn't find any opportunities matching that.";
      return `I found ${data.total} ${data.total === 1 ? 'opportunity' : 'opportunities'}.`;
    case 'certificate':
      return data.valid
        ? `That certificate is valid: ${data.hours ?? 0} hours for ${plainValue(data.eventTitle) || 'an event'}.`
        : 'No certificate matches that code.';
    case 'notifications':
      if (!data.total) return 'You have no recent notifications.';
      return `You have ${data.total} recent ${data.total === 1 ? 'notification' : 'notifications'}.`;
    case 'profile':
      /* `plainValue`, like every other user-authored value in this switch. It
         was the one branch interpolating a name raw — self-targeting only,
         since this tool reads `api.getMe()`, but `accountValidation` checks a
         name for length and trims it and nothing else, so a control character
         could reach the history `sanitizeHistory` replays into the next
         prompt. That is precisely what `plainValue` exists to strip, and the
         defence is worth applying uniformly rather than in six of seven
         places. */
      return `Profile for ${plainValue(data.name) || 'you'} (${plainValue(data.role) || 'volunteer'}) with ${data.hours || 0} verified hours.`;
    case 'event_details':
      return `Details for ${plainValue(data.title)}: ${data.slots?.length || 0} shifts available.`;
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
      const where = [plainValue(eventTitle), plainValue(slotName)].filter(Boolean).join(' — ');
      const length = hours ? ` It is ${hours} ${hours === 1 ? 'hour' : 'hours'}.` : '';
      return `Your next shift is ${where || 'a shift'}${startsAt ? `, ${startsAt}` : ''}.${length}`;
    }

    case 'waitlists': {
      if (!data.total) return 'You are not on any waitlists at the moment.';
      const first = data.items?.[0];
      const place = first?.position
        ? ` You are number ${first.position} for ${plainValue(first.eventTitle) || 'the first one'}.`
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
      const tail = latest?.action ? ` The most recent is "${plainValue(latest.action)}"${latest.at ? `, ${latest.at}` : ''}.` : '';
      return `The audit trail has ${data.total} recent ${data.total === 1 ? 'entry' : 'entries'}.${tail}`;
    }
    case 'application_withdrawn':
      return 'Your application has been withdrawn.';
    case 'profile_updated':
      return `Your profile has been updated (${(data.updated || []).join(', ')}).`;
    case 'preferences_updated':
      return 'Your notification preferences have been updated.';
    /**
     * Said only after the API has answered with an id — see `create_event` in
     * tools.js, which reports a failure rather than a success for anything
     * else. The date and the place are repeated because they are the two
     * things the organizer will check, and because a confirmation that names
     * them is a confirmation of the right event.
     *
     * The title and the location go through `plainValue` because an
     * organizer typed them: control characters and folded whitespace are
     * how a stored string steers the sentence it is quoted into. The date
     * is formatted by `localDay` and the shift count is a number, so
     * neither is text anybody supplied.
     */
    case 'event_created': {
      const when = data.startsOn || null;
      const where = data.location ? ` at ${plainValue(data.location)}` : '';
      const shifts = data.shifts > 1 ? ` (${data.shifts} shifts)` : '';
      return when
        ? `Done — “${plainValue(data.title)}” is created and open for applications, starting ${when}${where}${shifts}.`
        : `Done — “${plainValue(data.title)}” is created and open for applications${where}${shifts}.`;
    }
    default:
      return 'Here is what I found.';
  }
}

/**
 * What to say when the lookup itself failed.
 */
function failureMessage(reason, detail = null) {
  /**
   * The server's own sentence, when it wrote one for the reader.
   *
   * ── Why this is here rather than a bigger `switch` ──
   *
   * Event creation has a dozen refusal rules and gains more as the product
   * does, and every one of them already has a sentence written for an
   * organizer: "The application deadline must be on or before the first shift
   * starts.", "Each shift must allow between 1 and 100 volunteers.",
   * "Organizer account pending admin approval." Mapping them here would mean
   * maintaining a second copy of the server's vocabulary, and a rule added
   * server-side would surface as "I couldn't look that up just now" until
   * somebody remembered this file.
   *
   * `tools.js` only attaches this for the statuses that carry an explanation
   * for the person who caused it — 400, 403, 409 — so nothing here can leak a
   * 500's internal text.
   */
  if (detail?.serverMessage) {
    return `That didn't go through: ${lowerFirst(detail.serverMessage)}`;
  }

  if (reason === 'missing_event_fields') {
    const missing = detail?.missing?.length ? detail.missing.join(', ') : null;
    return missing
      ? `I still need ${missing} before I can create that event.`
      : 'I still need a few details before I can create that event.';
  }

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
    case 'confirmation_required':
      return "I can't make that change from here, so nothing was changed.";
    default:
      return "I couldn't look that up just now. Please try again.";
  }
}

/**
 * Who Welly is, naming the model that is actually running.
 *
 * The fixed sentence named one model regardless, so an organizer on the
 * Advanced model — Qwen2.5 1.5B — was told they were running the 0.5B. That is
 * a small thing to get wrong and a bad one: it is the answer somebody asks for
 * precisely when they are checking whether the model they chose is the model
 * they got.
 *
 * The name comes from the loaded registry entry rather than from the
 * preference, so it describes what is answering rather than what was asked for.
 */
function identityAnswer(runtime) {
  const model = runtime?.status === AIStatus.READY ? runtime.model : null;
  if (!model) return FIXED.identity_self;

  const name = [model.family, model.parameters].filter(Boolean).join(' ')
    || model.parameters
    || model.label;

  /* Same wording as `FIXED.identity_self`, and for the same reason — see the
     note there. The two must not drift: this one is what anybody with a model
     loaded actually reads. */
  return 'I am Welly, the assistant built into WeVolunteer by the people who make the app. '
    + 'I am software, not a person. Right now I am running a small open language model '
    + `(${name}) entirely on your own device, so no AI service writes my replies. `
    + 'Looking something up — your hours, your shifts, opportunities to join — is '
    + "answered by WeVolunteer's server, the same as the rest of the app, and a search "
    + 'sends the words you searched for.';
}

/** "The deadline must…" → "the deadline must…", for use inside a sentence. */
function lowerFirst(sentence) {
  const text = String(sentence || '').trim();
  if (!text) return 'the server refused it.';
  return text[0].toLowerCase() + text.slice(1);
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
/**
 * A user-authored value, flattened to one line before it enters an answer.
 *
 * ── What this is defending ──
 *
 * Event titles, shift names and audit action strings are written by other
 * people. `summarise()` interpolates them into the sentence Welly says, and that
 * sentence is committed to the transcript as an ordinary assistant turn —
 * `systemNotice` is false for a successful answer, deliberately, because
 * `sanitizeHistory` keeps real answers so a follow-up has something to refer to.
 *
 * So on the next conversational turn that text is replayed into the model's
 * context as `{ role: 'assistant', content: … }`. Attacker-authored text,
 * wearing the assistant's role, in the instruction channel.
 *
 * Nothing is escalated by it: the model cannot select a tool, and every
 * capability is checked on the server. What it can do is steer the next reply,
 * and the reply is rendered to a minor in the voice of the assistant the app
 * told them to trust.
 *
 * ── Why flattening, specifically ──
 *
 * Chat-template injection works by looking like structure — a blank line, then
 * `System:` or `Assistant:` at the start of a line. Collapse every run of
 * whitespace to a single space and that shape is unavailable: the words remain,
 * but they are stuck mid-sentence inside a line Welly is visibly saying.
 *
 * The words REMAIN on purpose. A student looking at an event whose name is
 * suspicious has to be able to read it, and an organizer who typed something odd
 * should not have it quietly rewritten. This is not sanitisation and must not
 * become it — `containsLink` in `prompts/welly.js` is what stops the model
 * turning any of it into somewhere to go.
 *
 * Control characters go entirely. They are not content, and they are how a
 * value smuggles line structure past a whitespace collapse.
 */
export function plainValue(value) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  /* eslint-disable-next-line no-control-regex -- the point is to remove these */
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

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
    /**
     * ── Why the application's own notices are held back ──
     *
     * Some assistant turns are not answers. "I can't help with that one",
     * "That is not something your account can ask me for", "Something went
     * wrong", "Stopped." — those are the interface speaking about a failure,
     * and they reach the transcript through the same `role: 'assistant'` door
     * as a real reply.
     *
     * A small model reads the history as a record of how the assistant talks
     * and imitates it. Measured against Qwen2.5-0.5B on 2026-08-21, in a
     * conversation where an earlier turn had fallen back: asked a fresh
     * question, the model reproduced
     *
     *     "I can't help with that one. I can look up opportunities, your
     *      volunteer hours, your certificates, …"
     *
     * word for word as its own answer — a refusal the application had written,
     * handed back as though the model had decided it.
     *
     * Only the notices go. The deterministic ANSWERS stay, because they carry
     * the facts a follow-up depends on: "You do not have any verified hours
     * yet" is what makes the next turn's "why?" mean anything. The user's own
     * message stays either way, so the thread still reads as a conversation.
     */
    .filter(m => !(m.role === 'assistant' && m.systemNotice))
    .slice(-maxTurns)
    .map(m => ({ role: m.role, content: formatResponseText(m.text) }));
}

/**
 * The places Welly has just shown, newest first.
 *
 * ── Why this reads the transcript rather than running a tool ──
 *
 * "How far is it?" is only answerable in context: "it" is whatever was on
 * screen a moment ago. The cards already carry the coordinates — see `coord` in
 * tools.js — and the app already has the reader's, so the answer is arithmetic
 * over what has been said, not a new request.
 *
 * Newest first, and it stops at the first card that has any place in it: a
 * question about "it" means the last thing shown, not everything ever shown.
 */
function placesInHistory(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const card = history[i]?.card;
    if (!card || history[i].role !== 'assistant') continue;

    const rows = card.kind === 'opportunities' ? (card.data?.items || [])
      : card.kind === 'event_details' ? [card.data]
        : [];

    const places = rows.filter(r => r
      && typeof r.latitude === 'number'
      && typeof r.longitude === 'number');

    /* A card with events but no coordinates on them is still THE card the
       question is about — stopping here rather than looking further back is
       what lets the answer say "I do not know where that one is" instead of
       measuring to something older and wrong. */
    if (rows.length) return places;
  }
  return [];
}

/** One mile figure, rounded the way the rest of the app rounds it. */
function milesTo(position, place) {
  return Number(haversineDistance(
    position.lat, position.lng, place.latitude, place.longitude,
  ).toFixed(1));
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

    /**
     * `truncated` when the model was cut off by the token budget rather than
     * finishing. Reported, never repaired: the interface shows a short note so
     * a sentence ending mid-air is explained instead of looking like a bug, and
     * the text itself is exactly what was generated.
     */
    return {
      intent: 'chat',
      answer: cleaned,
      card: null,
      phrasedByModel: true,
      truncated: runtime.lastFinishReason === 'length',
    };
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

/* ── Creating an event, conversationally ─────────────────────────────────── */

/**
 * The capability that decides whether Welly may run this at all.
 *
 * `event.create` and nothing wider. The server also admits
 * `organization.event.create` — the Student Organizer rank — but only for an
 * event attached to an organization the person helps run, which is a choice
 * (which club, and are they a manager of it) that this conversation does not
 * ask for and must not guess. So that account is told plainly where to do it,
 * rather than being walked through a flow whose last step would 403. Widening
 * this means adding the organization question first, not relaxing the check.
 */
const EVENT_CREATE_CAPABILITY = 'event.create';

/** Asking for an event to be created, as opposed to asking about one. */
const CREATE_EVENT_REQUEST =
  /\b(create|make|add|set ?up|schedule|post|publish|start|new|organi[sz]e|host|run)\b[^.?!]{0,30}\b(event|opportunit(y|ies)|shift|sign-?up sheet)\b/i;

/**
 * Intents that INTERRUPT a collection instead of answering its question.
 *
 * ── Why a list rather than "anything that routes" ──
 *
 * Most answers to Welly's questions do not route to anything. "Food Drive",
 * "South Brunswick Community Center" and "September 15" are all `unknown`, and
 * "20 volunteers" is two words containing "volunteer", which the router reads
 * as a terse opportunity search. If every routed intent broke out of the
 * collection, half the answers an organizer gives would be answered as
 * something else and the flow would be unusable.
 *
 * So the break-out set is the intents that cannot plausibly be an answer: a
 * refusal, a lookup in somebody's records, a page to open, a question about how
 * the platform works. Those are answered normally and the collection is left
 * exactly where it was, so the next answer continues it.
 */
const COLLECTION_INTERRUPTS = new Set([
  'refuse_other_user_data', 'refuse_credentials', 'refuse_account_action',
  'navigate', 'capabilities', 'identity_self', 'identity_platform', 'my_name',
  'info_how_events_work', 'info_how_applications_work', 'info_role_capabilities',
  'info_selection', 'info_hours', 'info_certificates', 'info_organizations',
  'my_hours', 'my_certificates', 'my_organizations', 'my_applications',
  'my_next_shift', 'my_waitlists', 'my_notifications', 'my_profile',
  'my_events', 'my_vacant_events', 'organizer_summary', 'event_roster',
  'event_details', 'verify_certificate', 'verify_certificate_missing_code',
  'platform_stats', 'admin_reports_summary', 'admin_appeals_summary',
  'system_health', 'recent_audit', 'eligibility_question', 'distance_to_event',
  'withdraw_application', 'update_profile', 'update_preferences',
  'empty',
]);

/** Words that are agreement, not an event name. */
const NOT_AN_ANSWER = new Set(['affirmation', 'confirm_action', 'greeting']);

/**
 * One turn of the collection: ask for the next thing, or present the finished
 * event for confirmation.
 *
 * Never creates anything. When the event is complete and passes the same
 * validation the API runs, it is handed to `confirm.js` as a draft — and a
 * draft is the only thing "yes" can execute.
 */
function eventCollectionTurn(draft, user, { intro = null } = {}) {
  const outstanding = missingField(draft);
  if (outstanding) {
    return {
      intent: 'create_event',
      answer: [intro, questionFor(outstanding, draft)].filter(Boolean).join(' '),
      card: null,
      collecting: outstanding,
      phrasedByModel: false,
    };
  }

  const payload = buildEventPayload(draft);
  const problem = explainInvalidEvent(payload);
  if (problem) {
    /**
     * Put the offending answer back to being missing, so the organizer's next
     * message is read as the correction rather than as free text. Without this
     * the flow tells somebody their deadline is wrong and then has nowhere to
     * put the new one.
     */
    if (problem.field === 'deadline') draft.fields.deadlineDate = null;
    if (problem.field === 'shifts') {
      draft.fields.shifts = draft.fields.shifts.map(s => ({ ...s, startTime: null, endTime: null }));
    }
    if (problem.field === 'capacity') {
      draft.fields.shifts = draft.fields.shifts.map(s => ({ ...s, maxSpots: null }));
    }
    return {
      intent: 'create_event',
      answer: problem.message,
      card: null,
      invalid: true,
      phrasedByModel: false,
    };
  }

  const pending = createDraft({
    tool: 'create_event',
    args: payload,
    preview: `Create “${payload.title}” at ${payload.location}`,
    summary: `Create “${payload.title}”`,
    user,
  });

  return {
    intent: 'create_event',
    answer: `Everything checks out — here is what I have:\n\n${describeEventDraft(draft)}\n\n`
      + 'Nothing has been created yet. Shall I create it?',
    card: { kind: 'draft', data: pending },
    draft: true,
    phrasedByModel: false,
  };
}

/** What an account that cannot create events is told when it asks. */
function cannotCreateEvents(user) {
  if (can(user, 'organization.event.create')) {
    return 'Events for a club are set up on the Create event page, where you choose which '
      + 'organization the event is for — that choice is why I do not do this one for you. '
      + 'I can show you what your club already has running if that helps.';
  }
  return actionReplyFor(user, { kind: 'event' });
}

export async function ask(
  message,
  { runtime = null, position = null, onToken, signal, history = [], user = null } = {},
) {
  const routed = routeIntent(message);
  const { tool, slots } = routed;
  /* Reassigned in exactly one place — a "yes" with nothing pending behind it is
     agreement, not a confirmation. See section 2. */
  let intent = routed.intent;

  /* ── 1. Role Gate ────────────────────────────────────────────────────────── */
  const permission = checkRole(user, intent);
  if (!permission.allowed) {
    return {
      intent: 'not_permitted',
      answer: refusedForRole(user, intent, permission),
      card: null,
      phrasedByModel: false,
      systemNotice: true,
    };
  }

  /**
   * ── 1b. A collection in progress owns the turn ────────────────────────────
   *
   * Before the confirmation lifecycle, because while an event is being
   * collected there is no draft to confirm — and "yes" said to "What's the
   * event called?" must be re-asked, not answered as agreement to nothing.
   *
   * `cancel_action` still gets out, and so does anything in
   * `COLLECTION_INTERRUPTS`; those are answered normally with the collection
   * left where it was.
   */
  const collecting = getEventDraft({ user });
  /**
   * The finished event waiting for a yes, if there is one.
   *
   * Its presence is what separates the two stages of the same conversation.
   * While it exists the collection is complete and the turn belongs to the
   * confirmation lifecycle below — otherwise "confirm" would be re-asked as if
   * it were an answer to a question, which is the loop this whole change
   * exists to end.
   */
  const awaitingCreate = (() => {
    const p = getPendingDraft(null, { user });
    return p && p.tool === 'create_event' ? p : null;
  })();

  if ((collecting || awaitingCreate) && intent === 'cancel_action') {
    clearEventDraft();
    cancelDraft(null, { user });
    return {
      intent: 'cancel_action',
      answer: "I've stopped setting that event up. Nothing was created.",
      card: null,
      phrasedByModel: false,
    };
  }
  if (collecting && !awaitingCreate && !COLLECTION_INTERRUPTS.has(intent)) {
    /**
     * Agreement is not an event name.
     *
     * "yes", "sure" and "hi" are the words somebody types when they have lost
     * the thread, not answers to the question that was asked — and storing one
     * as a title is how an event ends up called "yes". Re-asked instead, with
     * the question repeated so the thread is easy to pick back up.
     */
    if (NOT_AN_ANSWER.has(intent)) {
      return eventCollectionTurn(collecting, user, { intro: 'Before I can create it:' });
    }

    const outcome = applyEventMessage(message, { user });
    if (!outcome?.understood) {
      const stuck = missingField(collecting);
      const f = collecting.fields;
      const nudge = stuck === 'dates'
        ? "I didn't catch a date there."
        : stuck === 'shifts'
          ? (f.shifts.length && f.shifts.every(sh => sh.startTime)
            ? "I didn't catch a number there."
            : "I didn't catch the hours there.")
          : stuck === 'deadline'
            ? "I didn't catch a closing date there."
            : "Sorry, I didn't catch that.";
      return eventCollectionTurn(collecting, user, { intro: nudge });
    }
    return eventCollectionTurn(collecting, user);
  }

  /* ── 2. Draft Lifecycle Confirmations & Cancellations ─────────────────────── */
  if (intent === 'confirm_action') {
    const pending = getPendingDraft(null, { user });
    /**
     * ── "sure" is not always a confirmation ──
     *
     * `confirm_action` matches "yes", "sure", "go ahead" and the rest, which is
     * right when a draft is waiting and wrong the rest of the time — and the
     * rest of the time is most of the time, because those are also the ordinary
     * words for agreeing with something that was just said.
     *
     * Reported: Welly said "You have no verified hours. I can help find them
     * for you." A student replied "sure" and was told "There is no pending
     * action to confirm." Two faults in one exchange. The offer was a
     * hallucination from the model paraphrasing a tool result, which is fixed
     * at the source; this is the other half — the reply to it read as an error
     * report about a mechanism the student had no idea existed.
     *
     * With nothing pending, this is an affirmation and is answered as one, by
     * the conversational path below. The intent is reassigned rather than
     * answered here so there is one implementation of what "sure" means.
     */
    if (!pending) {
      intent = 'affirmation';
    } else {
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

      const result = await runConfirmedDraft(draft, { user });
      if (!result.ok) {
        /**
         * The collection is kept when the refusal is one the organizer can
         * answer — a rule about the dates, the hours or the capacity — so
         * "change the deadline to the 12th" has something to change. It is
         * dropped when there is nothing to fix from here: no permission, or a
         * failure that is not about this event at all.
         */
        const fixable = draft.tool === 'create_event'
          && (result.detail?.status === 400 || result.detail?.status === 409);
        if (draft.tool === 'create_event' && !fixable) clearEventDraft();

        return {
          intent,
          answer: failureMessage(result.reason, result.detail),
          card: null,
          toolFailed: true,
          phrasedByModel: false,
          systemNotice: true,
        };
      }

      /* Created. The conversation that gathered it is over — anything further
         is a new event, not an edit of one that now exists. */
      if (draft.tool === 'create_event') clearEventDraft();

      const summary = summarise(result.kind, result.data);
      return {
        intent,
        answer: summary,
        card: { kind: result.kind, data: result.data },
        phrasedByModel: false,
      };
    }
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
        systemNotice: true,
      };
    }
  }

  /* ── 5. Revising the Finished Event, and Action Requests ─────────────────── */

  /**
   * A change asked for while the summary is on screen.
   *
   * The draft waiting for a yes is immutable and correct to be — what is edited
   * is the collection that produced it, which is then re-validated and
   * re-presented as a NEW draft. So a revision can never leave a stale payload
   * confirmable, and it goes through the same validation the first version did.
   *
   * `awaitingCreate` is only set when the collection is complete, so anything
   * read out of the message here is a change to something already stated.
   */
  if (awaitingCreate && collecting) {
    const revision = applyEventMessage(message, { user, revising: true });
    if (revision?.understood) {
      cancelDraft(null, { user });
      const turn = eventCollectionTurn(collecting, user);
      return turn.draft
        ? { ...turn, answer: `Updated.\n\n${turn.answer}` }
        : turn;
    }
  }

  if (intent === 'action_request') {
    if (CREATE_EVENT_REQUEST.test(message)) {
      if (!can(user, EVENT_CREATE_CAPABILITY)) {
        return {
          intent,
          answer: cannotCreateEvents(user),
          card: null,
          phrasedByModel: false,
        };
      }

      /**
       * ── Nothing is drafted from one sentence ──
       *
       * A collection is started and whatever the request already contained is
       * folded into it, so "create a food drive at the community center on
       * September 15" arrives three fields ahead and Welly asks for the rest.
       * "Create an event" on its own arrives with nothing and Welly asks for
       * all of it — which is the whole difference from the invented
       * "Community Service Event / Community Center / 10 spots" this replaced.
       */
      const started = beginEventDraft({ user });
      applyEventMessage(message, { user, initial: true });
      return eventCollectionTurn(started, user);
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
        preview: `Withdraw application for ${plainValue(eventTitle) || targetId}`,
        summary: `Withdraw application for ${plainValue(eventTitle) || targetId}`,
        user,
      });

      return {
        intent,
        answer: `Are you sure you want to withdraw your application for ${plainValue(eventTitle) || targetId}? Reply "confirm" to proceed or "cancel" to keep your spot.`,
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
      /**
       * Reached from the router's own `create_event` rule ("start a draft",
       * "new event workflow") rather than from an action request. Same
       * conversation either way — the router decides which words got here, and
       * there is one implementation of what happens next.
       *
       * The capability gate has already run: `INTENT_CAPABILITY.create_event`
       * is `event.create`, so an account without it was refused before this
       * line. `runTool` checks it again before anything is posted, and so does
       * the server.
       */
      const started = beginEventDraft({ user });
      applyEventMessage(message, { user, initial: true });
      return eventCollectionTurn(started, user);
    }

    if (tool === 'update_preferences') {
      /**
       * ── Answered, not drafted ──
       *
       * There was no branch here, so this fell through to section 8 and was
       * run as a lookup. The router supplies no category, channel or setting,
       * so the tool refused, and the reader was told "I couldn't look that up
       * just now. Please try again." — a transient failure, for a request
       * trying again can never satisfy.
       *
       * Welly cannot read which notification and which channel out of a
       * sentence, so it says where the setting is. A link rather than a jump:
       * they asked for a change, not to be moved. When the router learns those
       * three slots, this becomes a draft like `update_profile` above.
       */
      return {
        intent,
        answer: "I can't change your notification settings myself. You can choose which "
          + 'notifications you get, and how, in Settings under Notifications.',
        card: { kind: 'navigate', data: { path: '/settings?section=notifications', label: 'Notification Settings' } },
        phrasedByModel: false,
      };
    }

    /**
     * A write tool with no branch above is answered here and goes no further.
     *
     * Section 8 is the read path; `runTool` would refuse a write there anyway,
     * and say so as a failure. This says it as an answer.
     */
    return {
      intent,
      answer: "I can't make that change from here, so nothing was changed.",
      card: null,
      phrasedByModel: false,
    };
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

    if (intent === 'distance_to_event') {
      /**
       * ── "How far is it?" ──
       *
       * Reported: asked straight after Welly listed an opportunity, and
       * answered "I can't help with that one. I can look up opportunities,
       * your volunteer hours, …" — a list of abilities that does not mention
       * the one just asked for, about the thing on screen.
       *
       * No lookup runs. The card carries the event's coordinates and the app
       * has the reader's, so this is arithmetic over the transcript.
       *
       * The three ways it can have no answer are three different sentences,
       * because they need three different things from the reader: grant
       * location, ask about something, or accept that this event has no
       * address on it. Collapsing them into one "I can't work that out" is the
       * shape of failure this whole file keeps having to undo.
       */
      const places = placesInHistory(history);

      if (!places.length) {
        return {
          intent,
          answer: 'I am not sure which place you mean. Ask me to find some opportunities '
            + 'first, or open one, and then I can tell you how far away it is.',
          card: null,
          phrasedByModel: false,
          systemNotice: true,
        };
      }

      if (!position) {
        return {
          intent,
          answer: 'I don’t have your location, so I can’t measure the distance yet.',
          card: null,
          phrasedByModel: false,
          /* The same offer the search path makes: a button, because a browser
             opens its permission dialog only for a gesture. */
          needsLocation: true,
        };
      }

      const measured = places
        .map(p => ({ title: p.title, location: p.location || null, miles: milesTo(position, p) }))
        .sort((a, b) => a.miles - b.miles);

      const nearest = measured[0];
      const answer = measured.length === 1
        ? `${plainValue(nearest.title)} is about ${nearest.miles} ${nearest.miles === 1 ? 'mile' : 'miles'} away.`
        : `The closest is ${plainValue(nearest.title)}, about ${nearest.miles} `
          + `${nearest.miles === 1 ? 'mile' : 'miles'} away.`;

      return {
        intent,
        answer,
        card: { kind: 'distances', data: { total: measured.length, items: measured } },
        phrasedByModel: false,
      };
    }

    if (intent === 'my_name') {
      /**
       * Asked "what's my name", the model replied "Your name is Welly" — it had
       * no way to know and answered anyway. The session does know, so this
       * reads it, and says so plainly when the record has no name on it rather
       * than inventing one.
       */
      const known = String(user?.name || '').trim();
      return {
        intent,
        answer: known
          ? `You are signed in as ${known}.`
          : 'Your account does not have a name on it yet — you can add one in Settings, under Profile.',
        card: null,
        phrasedByModel: false,
      };
    }

    return {
      intent,
      answer: intent === 'identity_self'
        ? identityAnswer(runtime)
        : (FIXED[intent] || FIXED.unknown),
      card: null,
      phrasedByModel: false,
      /* Only the two that mean "the application did not understand". The rest
         of FIXED — the greeting, the capability list, the eligibility answer —
         are real answers and belong in the history like any other. */
      systemNotice: intent === 'unknown' || intent === 'empty',
    };
  }

  /* ── 8. Read Tool Execution ──────────────────────────────────────────────── */
  /* Reads only. Every write returned in section 6, and `runTool` refuses one
     regardless — see the note on it in tools.js. */
  const args = { ...slots };
  if (slots.wantsNearby && position) {
    /**
     * Blurred at the boundary, because this pair is about to cross to the
     * server.
     *
     * It used to be `position.lat` verbatim, and `LocationContext` stores
     * `position.coords` as the browser gives them — so Welly sent a
     * full-precision GPS fix to `GET /api/events`, the same endpoint
     * `BrowseEvents` deliberately sends a ~1.1 km centre to. The Privacy Policy
     * promises the blurred one ("rounded to about a kilometre to sort a list by
     * distance"), and the offer that asks for the permission says the position
     * stays on the device.
     *
     * The exact position is untouched and still used on the device —
     * `distance_to_event` computes the miles a reader sees from it, for the
     * same reason `EventModal` does.
     */
    const coarse = coarsePosition(position);
    if (coarse) {
      args.lat = coarse.lat;
      args.lng = coarse.lng;
    }
  }
  /**
   * ── "Near me" with nothing to be near ──
   *
   * Asked for opportunities near them, a student whose browser had never been
   * granted location got an ordinary unsorted list, presented as though it had
   * been filtered by distance. Nothing said otherwise. The model, filling the
   * gap in free conversation, asked them to type an address instead — which is
   * the one thing this must never do: an address typed into a chat box is
   * personal information a lookup did not need, from a minor, and it teaches
   * that giving it up here is normal.
   *
   * WeVolunteer already knows how to ask properly. `LocationContext` holds the
   * coordinates in memory only, computes distance in the browser, and sends the
   * server nothing but a centre rounded to about a kilometre — and it asks with
   * a button, because a browser only shows the permission dialog for a gesture.
   *
   * So the flag travels up to the view, which offers that same button. Welly
   * says what it does not have and stops there; it never asks for it in words.
   */
  const needsLocation = Boolean(slots.wantsNearby) && !position;
  delete args.wantsNearby;

  const result = await runTool(tool, args, { user });

  if (!result.ok) {
    return {
      intent,
      answer: failureMessage(result.reason),
      card: null,
      toolFailed: true,
      phrasedByModel: false,
      systemNotice: true,
    };
  }

  /**
   * ── The sentence over a lookup is written here, not by the model ──
   *
   * It used to be: the tool ran, and the model was handed the data and asked to
   * phrase it, with `summarise()` kept only as a fallback for when there was no
   * model or the reply was unusable.
   *
   * At 0.5B that inverted the reliability. Measured against the real model, on
   * lookups that had SUCCEEDED and had a correct card sitting under them:
   *
   *   next shift, none upcoming   → "Your next shift is currently at zero."
   *   waitlists, empty            → "Waitlisted applications do not count, no
   *                                  need to show them."
   *   applications, asked which
   *   were rejected               → "Yes, some applications have been accepted
   *                                  in various events."
   *   next shift again            → "You are now ready to start your next shift."
   *   hours, zero                 → "You have no verified hours. I can help
   *                                  find them for you."
   *
   * Every one of those is wrong, and the last also promises something no tool
   * here can do. The card beside them was right the whole time, so the reader
   * was shown a correct figure under an incorrect sentence — which is worse
   * than either alone, because it is the sentence people read.
   *
   * `summarise()` is computed from the same data as the card, so it cannot
   * disagree with it. It is now the answer rather than the fallback. The model
   * keeps free conversation, where there is no record to get wrong, and this
   * path stops spending a generation on rephrasing a sentence that was already
   * correct — which also makes every lookup faster.
   */
  const summary = summarise(result.kind, result.data);

  return {
    intent,
    answer: needsLocation
      ? `${summary} I don${'\u2019'}t have your location, so these aren${'\u2019'}t sorted by distance.`
      : summary,
    card: { kind: result.kind, data: result.data },
    phrasedByModel: false,
    ...(needsLocation ? { needsLocation: true } : {}),
  };
}
