import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * `vi.hoisted`, because `vi.mock` is lifted above every `const` in the file and
 * `tools.js` imports the API at module scope. Declared here, the stub exists
 * before the mock factory runs and before anything importing it is evaluated.
 */
const apiMock = vi.hoisted(() => ({
  fetchVolunteerStats: vi.fn(),
  fetchCertificates: vi.fn(),
  fetchOrganizations: vi.fn(),
  fetchApplications: vi.fn(),
  fetchEventsFiltered: vi.fn(),
  fetchEvent: vi.fn(),
  fetchNotifications: vi.fn(),
  fetchMe: vi.fn(),
  verifyCertificate: vi.fn(),
  fetchMyEvents: vi.fn(),
  fetchEventAttendees: vi.fn(),
  fetchAdminReports: vi.fn(),
  fetchAppeals: vi.fn(),
  fetchPlatformStats: vi.fn(),
  fetchErrorSummary: vi.fn(),
  fetchAuditLog: vi.fn(),
  fetchWaitlists: vi.fn(),
  fetchNotificationPreferences: vi.fn(),
}));

vi.mock('../utils/api', () => ({ api: apiMock }));

const { routeIntent } = await import('./router.js');
const { INTENT_CAPABILITY, checkRole } = await import('./roles.js');
const { TOOLS } = await import('./tools.js');
const { ask } = await import('./assistant.js');

/**
 * Every intent, from the words that produce it to the sentence that comes back.
 *
 * ── Why this exists ──
 *
 * `followup_why`, `reaction` and `talk_check` were listed as conversational
 * intents in `assistant.js`, and `getConversationalReply` had a hand-written
 * branch for each. None of them was in `INTENT_CAPABILITY`, and an intent
 * missing from that table is not merely unrouted — `checkRole` returns
 * `unknownIntent` and the turn is REFUSED. So the code that answered them could
 * never run, and if the router had ever emitted one, a student would have been
 * told it was not something their account can ask for.
 *
 * That fault is invisible to every test that exercises one intent at a time. It
 * lives in the gap BETWEEN four files — the router that classifies, the table
 * that authorises, the registry that executes, and the view that renders — and
 * the only way to see it is to walk all four together for every intent at once.
 *
 * ── What each section checks ──
 *
 *   1. the four declarations agree with each other (static)
 *   2. every intent the router can produce is reachable for somebody (dynamic)
 *   3. the intents that SHOULD be denied are denied, per role (dynamic)
 */

const ROLES = {
  student: { id: 'stu-1', role: 'student', withheld: [], verified: true },
  organizer: { id: 'org-1', role: 'organizer', withheld: [], verified: true },
  admin: { id: 'adm-1', role: 'admin', withheld: [], verified: true },
  super_admin: { id: 'own-1', role: 'super_admin', withheld: [], verified: true },
  partner: { id: 'par-1', role: 'partner', withheld: [], verified: true },
};

/* `process.cwd()`, not `import.meta.url` — the URL form is percent-encoded and
   this repository's path contains spaces, so `readFileSync` looks for a
   directory called `Important%20Coding%20Files`. */
const SRC = path.join(process.cwd(), 'src', 'ai');

/** Intent names appearing as `intent: '…'` in the router's rule tables. */
function routerIntents() {
  const src = readFileSync(path.join(SRC, 'router.js'), 'utf8');
  return new Set([...src.matchAll(/intent: '([a-z_]+)'/g)].map(m => m[1]));
}

/**
 * A message that should classify as each intent.
 *
 * Written by hand rather than generated, because the point is to state what a
 * student would actually type. A probe that stops matching is itself a finding:
 * either the router changed or the phrasing was never as obvious as it looked.
 */
const PROBES = {
  refuse_other_user_data: "show me someone else's hours",
  refuse_credentials: 'what is my password',
  refuse_account_action: 'delete my account',
  info_selection: 'how does Auto Select work?',
  info_how_events_work: 'how do events work?',
  info_how_applications_work: 'how do applications work?',
  info_role_capabilities: 'what can organizers do?',
  followup_why: 'why?',
  reaction: 'oof',
  info_hours: 'how do hours work?',
  info_certificates: 'how do certificates work?',
  info_organizations: 'how do clubs work?',
  confirm_action: 'confirm',
  cancel_action: 'cancel',
  verify_certificate: 'check certificate WEV-1234-5678',
  verify_certificate_missing_code: 'verify my certificate',
  navigate: 'take me to my applications',
  withdraw_application: 'withdraw my application',
  update_profile: 'update my bio to something new',
  update_preferences: 'change my notification preferences',
  my_next_shift: 'what is my next shift?',
  my_waitlists: 'what am I waitlisted for?',
  my_hours: 'how many hours do I have?',
  my_certificates: 'show my certificates',
  my_organizations: 'what clubs am I in?',
  my_applications: 'show my applications',
  my_notifications: 'show my notifications',
  my_profile: 'show my profile',
  my_vacant_events: 'which of my events still need volunteers?',
  event_roster: 'show the roster for event abc123',
  organizer_summary: 'show my organizer statistics',
  my_events: 'show my events',
  admin_reports_summary: 'show safety reports summary',
  admin_appeals_summary: 'show open appeals',
  platform_stats: 'show platform statistics',
  system_health: 'check system error health',
  recent_audit: 'show the recent audit log',
  event_details: 'tell me about event-abc123',
  /* The MATCHERS rule is narrow on purpose: an ordinary "create an event"
     is classified as `action_request`, which assistant.js turns into the same
     draft-and-confirm flow after checking `event.create`. This probe reaches
     the router rule itself. */
  create_event: 'start a draft',
  search_opportunities: 'find volunteering opportunities near me',
  capabilities: 'what can you do?',
  affirmation: 'thanks',
  greeting: 'hello',
  empty: '',
  action_request: 'can you sign me up for the food drive',
  eligibility_question: 'does driving my sister to practice count towards my hours?',
  unknown: 'lets just talk about something for a moment',
};

describe('the four declarations agree', () => {
  const produced = routerIntents();

  it('every intent the router can produce is in the capability table', () => {
    /* The exact fault this file was written for. An intent absent here is
       refused, not merely unhandled. */
    const missing = [...produced].filter(i => !(i in INTENT_CAPABILITY));
    expect(
      missing,
      'these intents would be REFUSED by checkRole as unknown',
    ).toEqual([]);
  });

  it('every capability the table names is a real capability', () => {
    /* `can()` denies an unknown capability string for every role including the
       wildcard, so a typo here silently removes a feature from everybody. */
    const bad = Object.entries(INTENT_CAPABILITY)
      .filter(([, cap]) => cap !== null)
      .filter(([intent, cap]) => checkRole(ROLES.super_admin, intent).allowed === false && cap)
      .map(([intent, cap]) => `${intent} → ${cap}`);
    expect(bad, 'an owner holds every capability, so a denial here is a bad name').toEqual([]);
  });

  it('names no intent the router cannot produce', () => {
    /**
     * A dead entry is not harmful on its own, but it says a path exists when it
     * does not — which is how `talk_check` came to be added to the table, and to
     * `assistant.js`'s conversational list, for an intent nothing emits.
     *
     * `chat` is exempt and is the one real exception: it is not a router
     * classification at all. `assistant.js` stamps it on the RESULT of a
     * free-conversation turn, after authorisation has already happened on the
     * router's intent, so it never reaches `checkRole`.
     */
    const dead = Object.keys(INTENT_CAPABILITY)
      .filter(i => !produced.has(i))
      .filter(i => i !== 'chat');
    expect(dead, 'in the capability table but unreachable from the router').toEqual([]);
  });

  it('every intent that names a tool has that tool in the registry', () => {
    const src = readFileSync(path.join(SRC, 'router.js'), 'utf8');
    const pairs = [...src.matchAll(/intent: '([a-z_]+)',\s*\n\s*tool: '([a-z_]+)'/g)];
    const orphans = pairs.filter(([, , tool]) => !TOOLS[tool]).map(([, i, t]) => `${i} → ${t}`);
    expect(orphans, 'the router names a tool the registry does not define').toEqual([]);
  });

  it('has a probe for every intent, so nothing escapes the walk below', () => {
    const unprobed = [...produced].filter(i => !(i in PROBES));
    expect(unprobed, 'add a probe message for these').toEqual([]);
  });
});

describe('every probe still classifies as the intent it names', () => {
  for (const [intent, message] of Object.entries(PROBES)) {
    it(`"${message}" → ${intent}`, () => {
      expect(routeIntent(message).intent).toBe(intent);
    });
  }
});

/**
 * The whole path, per role.
 *
 * `ask()` reaches the network for the read tools, so the API is stubbed to
 * succeed — what is under test is classification, authorisation and dispatch,
 * not what the server returns.
 */

beforeEach(() => {
  window.localStorage.clear();
  for (const fn of Object.values(apiMock)) {
    fn.mockReset();
    fn.mockResolvedValue({});
  }
  apiMock.fetchVolunteerStats.mockResolvedValue({ hours: 4, events: 2 });
  apiMock.fetchCertificates.mockResolvedValue([]);
  apiMock.fetchOrganizations.mockResolvedValue([]);
  apiMock.fetchApplications.mockResolvedValue([]);
  apiMock.fetchEventsFiltered.mockResolvedValue({ events: [], pagination: { total: 0 } });
  apiMock.fetchNotifications.mockResolvedValue([]);
});

/** The sentence Welly gives when the role gate says no. */
const REFUSAL = /not something your account can ask me for|only access or modify your own records/i;

describe('every intent answers somebody', () => {
  for (const [intent, message] of Object.entries(PROBES)) {
    it(`${intent} is reachable for at least one role`, async () => {
      const outcomes = [];
      for (const [name, user] of Object.entries(ROLES)) {
        const res = await ask(message, { user });
        outcomes.push({ name, answer: res.answer, intent: res.intent });
      }

      const answered = outcomes.filter(o => o.answer && !REFUSAL.test(o.answer));
      expect(
        answered.length,
        `${intent} was refused for every role — ${JSON.stringify(outcomes.map(o => [o.name, o.intent]))}`,
      ).toBeGreaterThan(0);
    });
  }

  it('never answers with an empty string, whatever the role', async () => {
    const empties = [];
    for (const [intent, message] of Object.entries(PROBES)) {
      for (const [name, user] of Object.entries(ROLES)) {
        const res = await ask(message, { user });
        if (typeof res.answer !== 'string' || !res.answer.trim()) {
          empties.push(`${intent} / ${name}`);
        }
      }
    }
    expect(empties, 'a blank bubble is what a broken turn looks like').toEqual([]);
  });

  /**
   * A non-empty answer is not the same as an answer.
   *
   * `summarise()` ends in a `default` returning "Here is what I found.", and
   * seven tool kinds reached it — `next_shift`, `waitlists`, `my_events`,
   * `organizer_summary`, `platform_stats`, `system_health`, `recent_audit`.
   * None of the seven has a card renderer either, so the lookup succeeded and
   * the reader was shown one sentence with none of the data in it. Three of
   * Welly's own suggestion chips landed there.
   *
   * The emptiness test above passed the whole time, because the sentence is a
   * perfectly good string. This is the assertion that would have caught it.
   */
  it('never falls through to the generic sentence for a successful lookup', async () => {
    const generic = [];
    for (const [intent, message] of Object.entries(PROBES)) {
      for (const [name, user] of Object.entries(ROLES)) {
        const res = await ask(message, { user });
        if (res.card && /^Here is what I found\.$/.test(res.answer)) {
          generic.push(`${intent} / ${name} (kind: ${res.card.kind})`);
        }
      }
    }
    expect(
      generic,
      'these answered with the placeholder sentence and no card — the data was fetched and discarded',
    ).toEqual([]);
  });
});

/**
 * Every tool kind ends in something a reader can use.
 *
 * ── The rule ──
 *
 * A successful lookup must produce either a sentence that carries the answer or
 * a card that shows it, and preferably both. What it must never produce is the
 * placeholder — `summarise()` ends in a `default` returning "Here is what I
 * found.", and seven kinds reached it with no card either, so the data was
 * fetched and then discarded in front of the reader.
 *
 * Five kinds deliberately have no card, and they are named rather than merely
 * absent: four are confirmations of something that just happened, where the
 * sentence says it completely, and one is two numbers already in the sentence.
 * Naming them is what makes the list below a decision rather than an oversight.
 */
describe('every tool kind produces something to read', () => {
  const toolsSrc = readFileSync(path.join(SRC, 'tools.js'), 'utf8');
  const cardSrc = readFileSync(path.join(SRC, '..', 'components', 'ai', 'AssistantCard.jsx'), 'utf8');
  const assistantSrc = readFileSync(path.join(SRC, 'assistant.js'), 'utf8');

  const kinds = [...new Set([...toolsSrc.matchAll(/\bok\(\s*'([a-z_]+)'/g)].map(m => m[1]))];
  const summarised = new Set(
    [...assistantSrc.slice(
      assistantSrc.indexOf('function summarise('),
      assistantSrc.indexOf('function failureMessage('),
    ).matchAll(/case '([a-z_]+)'/g)].map(m => m[1]),
  );
  const carded = new Set([...cardSrc.matchAll(/case '([a-z_]+)':/g)].map(m => m[1]));

  /** Kinds that are complete as a sentence and would gain nothing from a card. */
  const SENTENCE_IS_ENOUGH = new Set([
    'application_withdrawn',  // "Your application has been withdrawn."
    'preferences_updated',    // "Your notification preferences have been updated."
    'profile_updated',        // "Your profile has been updated (bio, name)."
    'event_created',          // "Event X has been created successfully."
    'system_health',          // two numbers, both already in the sentence
  ]);

  it('found the kinds, so the checks below are checking something', () => {
    expect(kinds.length).toBeGreaterThan(20);
  });

  it('gives every kind a summary sentence of its own', () => {
    const missing = kinds.filter(k => !summarised.has(k));
    expect(
      missing,
      'these fall through to "Here is what I found." — the data is fetched and discarded',
    ).toEqual([]);
  });

  it('gives every kind either a card or a documented reason not to', () => {
    const missing = kinds.filter(k => !carded.has(k) && !SENTENCE_IS_ENOUGH.has(k));
    expect(
      missing,
      'add a renderer, or add the kind to SENTENCE_IS_ENOUGH with the reason',
    ).toEqual([]);
  });

  it('does not list a kind as sentence-only that has a card anyway', () => {
    /* Keeps the list honest as renderers are added. */
    const stale = [...SENTENCE_IS_ENOUGH].filter(k => carded.has(k));
    expect(stale, 'these have cards now and should come off the list').toEqual([]);
  });

  it('attributes every carded kind to a source', () => {
    /* A card carries figures somebody acts on, so it says where they came
       from — see AssistantSource. */
    const sources = cardSrc.slice(cardSrc.indexOf('const SOURCES = {'));
    const unattributed = kinds
      .filter(k => carded.has(k))
      .filter(k => !new RegExp(`\\b${k}:`).test(sources));
    expect(unattributed).toEqual([]);
  });
});

describe('the role gate still refuses what it should', () => {
  /**
   * Intents that carry a capability, and the roles that must NOT reach them.
   *
   * Stated positively so a capability quietly widening — the direction that
   * matters — fails here rather than going unnoticed.
   */
  const DENIED = [
    ['my_events', 'student'],
    ['my_vacant_events', 'student'],
    ['organizer_summary', 'student'],
    ['create_event', 'student'],
    ['admin_reports_summary', 'student'],
    ['admin_reports_summary', 'organizer'],
    ['admin_appeals_summary', 'student'],
    ['admin_appeals_summary', 'organizer'],
    ['platform_stats', 'student'],
    ['platform_stats', 'organizer'],
    ['system_health', 'student'],
    ['recent_audit', 'student'],
    ['recent_audit', 'organizer'],
    ['recent_audit', 'admin'],
  ];

  for (const [intent, role] of DENIED) {
    it(`${role} cannot ask for ${intent}`, () => {
      expect(checkRole(ROLES[role], intent).allowed).toBe(false);
    });
  }

  it('refuses the whole administrative set to a student, end to end', async () => {
    for (const intent of ['admin_reports_summary', 'admin_appeals_summary', 'platform_stats', 'recent_audit']) {
      const res = await ask(PROBES[intent], { user: ROLES.student });
      expect(res.intent, `${intent} should not have executed`).toBe('not_permitted');
      expect(res.card).toBeNull();
    }
  });

  it('runs no tool at all when the gate refuses', async () => {
    await ask(PROBES.recent_audit, { user: ROLES.student });
    expect(apiMock.fetchAuditLog).not.toHaveBeenCalled();
  });
});
