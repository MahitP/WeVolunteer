import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CHANNEL_ACCEPTANCE, CHANNEL_AGREEMENT, CHANNEL_NOTICE,
  MATERIAL, MINOR,
  SIGNUP_CONSENT_GATED_CAPABILITIES,
  __resetGateCache,
  changeSeverity,
  isBehind,
  newestSeenVersion,
  noticeChannelFor,
  pendingSignupAcceptances,
  signupConsentWithholdingsFor,
} from './legalConsentGate.js';
import { ALL_CAPABILITIES } from './authz.js';
import { LEGAL_DOCUMENTS } from './legalDocuments.js';

/**
 * The rule that decides whether a legal change interrupts somebody.
 *
 * Tested here rather than only through HTTP because it is the rule the whole
 * feature rests on, and because the failure modes are asymmetric in a way an
 * endpoint test would not make obvious: getting it wrong in one direction shows
 * somebody a banner they did not need, and in the other it withholds a
 * fourteen-year-old's ability to sign up for a shift.
 *
 * `legalConsentGate.js` reaches the registry and `db/dialectSql.js` and never
 * `db.js`, so it can be imported statically. The two database-backed functions
 * take `db` as an argument for exactly this reason — a stub answers them without
 * a server, and `routes.legalReconsent.test.js` covers them end to end.
 */

/**
 * A database that answers the two queries this module makes, and nothing else.
 *
 * Deliberately not a real handle. What is being tested is the decision, and a
 * stub makes the inputs — which revisions exist, what this account has accepted
 * — visible in the test rather than three inserts away from it.
 */
function stubDb({ revisions = [], acceptances = [], tableExists = true } = {}) {
  return {
    prepare(sql) {
      if (/sqlite_master|information_schema/.test(sql)) {
        return { get: async () => (tableExists ? { present: 1 } : undefined) };
      }
      if (/legal_document_revisions/.test(sql)) {
        return { all: async (...slugs) => revisions.filter(r => slugs.includes(r.slug)) };
      }
      if (/legal_acceptances/.test(sql)) {
        return { all: async () => acceptances };
      }
      throw new Error(`stubDb: unexpected query ${sql}`);
    },
  };
}

/** A signup-scope document that really is registered, so the scope is not fiction. */
const SIGNUP_SLUG = LEGAL_DOCUMENTS.find(d => d.scope === 'signup').slug;

beforeEach(() => __resetGateCache());
afterEach(() => vi.restoreAllMocks());

describe('change severity', () => {
  it('calls a major bump material', () => {
    expect(changeSeverity('1.0', '2.0.0')).toBe(MATERIAL);
    expect(changeSeverity('1.9.9', '2.0.0')).toBe(MATERIAL);
  });

  it('calls a minor or patch bump a clarification', () => {
    expect(changeSeverity('1.0', '1.1.0')).toBe(MINOR);
    expect(changeSeverity('1.0', '1.0.1')).toBe(MINOR);
    expect(changeSeverity('1.0', '1.99.99')).toBe(MINOR);
  });

  /**
   * The rule is §13's, and §13 is about being worse off, not about distance.
   *
   * A reader who skipped from 1.0 to 1.4 has missed four clarifications, none
   * of which asked anything of them. Treating "a lot has changed" as material
   * would re-consent everybody who was away for a term.
   */
  it('does not turn a run of clarifications into a material change', () => {
    expect(changeSeverity('1.0', '1.4.0')).toBe(MINOR);
  });

  it('is not fooled by string comparison', () => {
    /* '1.9' > '1.10' lexicographically, and '10.0' < '9.0'. Both are wrong. */
    expect(changeSeverity('1.9.0', '1.10.0')).toBe(MINOR);
    expect(changeSeverity('9.0.0', '10.0.0')).toBe(MATERIAL);
  });

  /**
   * An unreadable version is a clarification, and the direction is the point.
   *
   * A malformed version can only come from a hand-written row. Guessing
   * MATERIAL would withhold capabilities from a real account over a string; the
   * reader is still told the document moved either way.
   */
  it('degrades to a clarification, loudly, on a version it cannot read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(changeSeverity('not-a-version', '2.0.0')).toBe(MINOR);
    expect(changeSeverity('1.0', 'banana')).toBe(MINOR);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('which surface owns a change', () => {
  const TODAY = '2026-09-04';
  const doc = (over = {}) => ({
    slug: SIGNUP_SLUG, scope: 'signup', version: '2.0.0', effectiveAt: '2026-09-01', ...over,
  });

  it('sends a material, in-effect change to the mandatory dialog', () => {
    expect(noticeChannelFor(doc(), '1.0', TODAY)).toBe(CHANNEL_ACCEPTANCE);
  });

  it('sends a clarification to the ordinary banner', () => {
    expect(noticeChannelFor(doc({ version: '1.1.0' }), '1.0', TODAY)).toBe(CHANNEL_NOTICE);
  });

  /**
   * The 30-day promise, in one assertion.
   *
   * §13 says a change that matters is announced "at least 30 days before it
   * takes effect". A material revision published today and effective in three
   * weeks is therefore a NOTICE today. Requiring the acceptance on publication
   * would make the product break its own terms every time the feature was used
   * correctly.
   */
  it('announces a material change that has not taken effect yet, and does not block on it', () => {
    expect(noticeChannelFor(doc({ effectiveAt: '2026-10-04' }), '1.0', TODAY)).toBe(CHANNEL_NOTICE);
  });

  it('blocks from the effective date, inclusive', () => {
    expect(noticeChannelFor(doc({ effectiveAt: TODAY }), '1.0', TODAY)).toBe(CHANNEL_ACCEPTANCE);
  });

  /**
   * A `notice`-scope document collects no acceptance in any version, so there
   * is nothing to re-accept however major the bump.
   */
  it('never demands acceptance of a document nobody ever accepted', () => {
    expect(noticeChannelFor(doc({ scope: 'notice' }), '1.0', TODAY)).toBe(CHANNEL_NOTICE);
  });

  /**
   * Part of the reason there is never a duplicate notification: the two
   * onboarding agreements already withhold capabilities on ANY version change
   * and already have a screen that renders the whole document. This subsystem
   * stays out of their way entirely.
   */
  it('leaves the organizer agreements to their own screens', () => {
    for (const scope of ['organizer-onboarding', 'student-organizer-onboarding']) {
      expect(noticeChannelFor(doc({ scope }), '1.0', TODAY)).toBe(CHANNEL_AGREEMENT);
      expect(noticeChannelFor(doc({ scope, version: '1.1.0' }), '1.0', TODAY)).toBe(CHANNEL_AGREEMENT);
    }
  });
});

describe('behind, rather than merely different', () => {
  /**
   * `legal_document_revisions` is append-only and refuses a version that is not
   * strictly greater, so an account can never overtake the effective version
   * through the application. It can through a hand-deleted revision or a
   * restored backup — and under the old equality test that state produced a
   * dialog demanding agreement to a version OLDER than the one already agreed
   * to.
   */
  it('is true only when the recorded version is older', () => {
    expect(isBehind('1.0', '1.1.0')).toBe(true);
    expect(isBehind('1.0', '1.0.0')).toBe(false);
    expect(isBehind('2.0.0', '1.0')).toBe(false);
  });

  it('is not a string comparison', () => {
    expect(isBehind('1.9.0', '1.10.0')).toBe(true);
    expect(isBehind('1.10.0', '1.9.0')).toBe(false);
  });

  it('falls back to inequality for a version it cannot read', () => {
    /* Preserves the previous behaviour for a hand-written row rather than
       silently reporting "not behind" for anything malformed. */
    expect(isBehind('garbage', '1.0')).toBe(true);
    expect(isBehind('garbage', 'garbage')).toBe(false);
  });
});

describe('the newest version an account has been shown', () => {
  /**
   * `legal_change_notices` holds one row per version, and the query that reads
   * it has no ORDER BY. Taking "whichever came back last" meant dismissing the
   * newer notice could record the older version, and the notice returned for
   * ever.
   */
  it('is a maximum, not whichever row arrived last', () => {
    expect(newestSeenVersion(['1.2.0', '1.1.0'])).toBe('1.2.0');
    expect(newestSeenVersion(['1.1.0', '1.2.0'])).toBe('1.2.0');
  });

  it('is not a string comparison', () => {
    expect(newestSeenVersion(['1.9.0', '1.10.0'])).toBe('1.10.0');
  });

  /** An acknowledgement of 1.1 must not outrank an acceptance of 2.0. */
  it('lets the stronger record win when it is newer', () => {
    expect(newestSeenVersion(['1.1.0', '2.0.0'])).toBe('2.0.0');
  });

  it('ignores rows it cannot parse rather than throwing', () => {
    /* `compareVersions` raises on an unparseable version, and one hand-written
       row must not be able to take down the request that renders the shell. */
    expect(newestSeenVersion(['garbage', '1.1.0'])).toBe('1.1.0');
    expect(newestSeenVersion(['garbage'])).toBeNull();
    expect(newestSeenVersion([])).toBeNull();
  });
});

describe('what the gate withholds', () => {
  it('names only real capabilities', () => {
    for (const cap of SIGNUP_CONSENT_GATED_CAPABILITIES) {
      expect(ALL_CAPABILITIES, `${cap} is not a capability`).toContain(cap);
    }
  });

  /**
   * The four exemptions, asserted rather than described.
   *
   * Each is a specific failure the list is shaped to avoid: a reader who cannot
   * read the document they are being asked about, an account that cannot be
   * closed by somebody who declines, a student whose earned hours cannot be
   * recorded because the organizer at the desk owes an acceptance, a safety
   * report nobody can resolve, and an owner who publishes a major revision by
   * mistake and loses the editor that would fix it.
   */
  it('leaves reading, leaving, other people and the editor alone', () => {
    for (const kept of [
      'event.view', 'self.read', 'directory.read', 'stats.self',
      'self.write',
      'attendance.mark', 'attendance.scan', 'attendance.view', 'qr.present',
      'report.resolve', 'appeal.review', 'user.warn', 'user.suspend',
      'legal.edit',
      'persona.preview.exit',
    ]) {
      expect(
        SIGNUP_CONSENT_GATED_CAPABILITIES,
        `${kept} must survive the gate — see the note on the list`
      ).not.toContain(kept);
    }
  });
});

describe('who owes an acceptance', () => {
  const revision = (over = {}) => ({
    slug: SIGNUP_SLUG, version: '2.0.0', effective_at: '2026-01-01', ...over,
  });
  const accepted = (version) => [{ slug: SIGNUP_SLUG, version }];

  it('nobody, when no signup document has ever been revised', async () => {
    const db = stubDb({ revisions: [], acceptances: accepted('1.0') });
    expect(await pendingSignupAcceptances(db, 'u1')).toEqual([]);
  });

  it('an account behind a material, in-effect revision', async () => {
    const db = stubDb({ revisions: [revision()], acceptances: accepted('1.0') });
    const owed = await pendingSignupAcceptances(db, 'u1');

    expect(owed.map(d => d.slug)).toEqual([SIGNUP_SLUG]);
    expect(owed[0].version).toBe('2.0.0');
    expect(owed[0].previousVersion).toBe('1.0');
  });

  it('not an account already at the current version', async () => {
    const db = stubDb({ revisions: [revision()], acceptances: accepted('2.0.0') });
    expect(await pendingSignupAcceptances(db, 'u1')).toEqual([]);
  });

  it('not an account behind only a clarification', async () => {
    const db = stubDb({ revisions: [revision({ version: '1.1.0' })], acceptances: accepted('1.0') });
    expect(await pendingSignupAcceptances(db, 'u1')).toEqual([]);
  });

  it('not during the notice period, however material the change', async () => {
    const db = stubDb({ revisions: [revision({ effective_at: '2099-01-01' })], acceptances: accepted('1.0') });
    expect(await pendingSignupAcceptances(db, 'u1')).toEqual([]);
  });

  /**
   * The rule that keeps every seeded and legacy account out of the gate.
   *
   * An absent acceptance row means the account predates the consent record, so
   * there is no previous version it was shown and nothing it can be asked to
   * re-accept. Treating absence as "behind" would gate the entire existing
   * population out of the product on the first major revision.
   */
  it('not an account that never accepted the document at all', async () => {
    const db = stubDb({ revisions: [revision()], acceptances: [] });
    expect(await pendingSignupAcceptances(db, 'u1')).toEqual([]);
  });

  it('not an account whose recorded version is AHEAD of the one in effect', async () => {
    /* Only reachable operationally — a deleted revision, a restored backup.
       Demanding agreement to a version older than the one already accepted is
       the worst possible response to it. */
    const db = stubDb({ revisions: [revision({ version: '1.0.0' })], acceptances: accepted('2.0.0') });
    expect(await pendingSignupAcceptances(db, 'u1')).toEqual([]);
  });

  it('nobody at all without a user', async () => {
    const db = stubDb({ revisions: [revision()], acceptances: accepted('1.0') });
    expect(await pendingSignupAcceptances(db, null)).toEqual([]);
  });

  /**
   * Mid-migration: the revisions table does not exist yet.
   *
   * A boot that answered requests while migration 34 had not run would throw
   * on every one of them, because this runs inside `buildPrincipal`.
   */
  it('nobody on a database without the revisions table', async () => {
    const db = stubDb({ revisions: [revision()], acceptances: accepted('1.0'), tableExists: false });
    expect(await pendingSignupAcceptances(db, 'u1')).toEqual([]);
  });

  it('withholds the participation capabilities, and only when owed', async () => {
    const behind = stubDb({ revisions: [revision()], acceptances: accepted('1.0') });
    expect(await signupConsentWithholdingsFor(behind, { id: 'u1', role: 'student' }))
      .toEqual([...SIGNUP_CONSENT_GATED_CAPABILITIES]);

    const current = stubDb({ revisions: [revision()], acceptances: accepted('2.0.0') });
    expect(await signupConsentWithholdingsFor(current, { id: 'u1', role: 'student' })).toEqual([]);
  });

  /**
   * No role is exempt, unlike the organizer arm.
   *
   * The Terms bind every account including the owner's, and that is only safe
   * to say because no administrative capability is in the withheld list — the
   * case above asserts that half.
   */
  it('applies to an owner as well as to a student', async () => {
    const db = stubDb({ revisions: [revision()], acceptances: accepted('1.0') });
    expect(await signupConsentWithholdingsFor(db, { id: 'u1', role: 'super_admin' }))
      .toEqual([...SIGNUP_CONSENT_GATED_CAPABILITIES]);
  });

  it('withholds nothing without a user row', async () => {
    const db = stubDb({ revisions: [revision()], acceptances: accepted('1.0') });
    expect(await signupConsentWithholdingsFor(db, null)).toEqual([]);
  });
});
