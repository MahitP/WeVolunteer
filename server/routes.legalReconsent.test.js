import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';
import { SIGNUP_CONSENT_GATED_CAPABILITIES, __resetGateCache } from './legalConsentGate.js';

/**
 * A material legal change, end to end.
 *
 * ── What this file is for ──
 *
 * `routes.legalUpdates.test.js` covers the ordinary notice: told once, and once
 * only. This covers the other half — the change §13 of the Terms says we "ask
 * you to accept again" — and the three properties that make it mean anything:
 *
 *   1. It is ENFORCED, not merely displayed. The capabilities are withheld
 *      server-side, so deleting the dialog from the bundle changes nothing.
 *   2. It does NOT also produce the ordinary banner. One change, one
 *      notification.
 *   3. Nothing the client sends can manufacture, forge or dodge the record.
 *
 * ── Why the fixture publishes a revision rather than editing the registry ──
 *
 * `legalVersioning.test.js` fails the build if any registered document leaves
 * 1.0 before launch, and it is right to. The effective version comes from
 * `legal_document_revisions` anyway — that is what the editor writes and what
 * `effectiveDocuments` resolves against — so a revision row is both the legal
 * way to do this and the realistic one.
 */

const STUDENT = 'leo.chen@example.com';
const OTHER_STUDENT = 'priya.patel@example.com';

/** A signup-scope document: the only scope this subsystem gates on. */
const SLUG = 'terms-of-service';

describe('a material legal change', () => {
  let srv;
  let db;
  let student;
  let studentId;
  let other;
  let otherId;

  const updates = (session = student) => srv.call('GET', '/api/legal/updates', undefined, session);
  const me = (session = student) => srv.call('GET', '/api/auth/me', undefined, session);
  const accept = (slug, version, session = student) =>
    srv.call('POST', '/api/legal/updates/accept', { slug, version }, session);

  /** Records an acceptance at `version`, as signup would have. */
  const acceptedAt = async (userId, version) => {
    await db.prepare('DELETE FROM legal_acceptances WHERE user_id = ? AND document_slug = ?')
      .run(userId, SLUG);
    await db.prepare(`INSERT INTO legal_acceptances
      (id, user_id, document_slug, version, content_hash, accepted_at, method, context)
      VALUES (?, ?, ?, ?, ?, ?, 'signup', 'test-fixture')`)
      .run(`acc-fix-${userId}-${version}`, userId, SLUG, version, 'hash-fixture',
        new Date().toISOString());
  };

  /**
   * Publishes a revision of the Terms.
   *
   * `effectiveAt` defaults to well in the past, so the change is in effect and
   * the gate is live. The notice-period cases pass a future date.
   */
  const publish = async (version, effectiveAt = '2026-01-01', body = null) => {
    await db.prepare(`INSERT INTO legal_document_revisions
      (slug, version, body, content_hash, effective_at, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, NULL)`)
      .run(
        SLUG, version,
        body ?? `## Draft\nWe may now share your attendance record with your school district.`,
        `hash-${version}`, effectiveAt, new Date().toISOString()
      );
  };

  const unpublishAll = async () => {
    await db.prepare('DELETE FROM legal_document_revisions WHERE slug = ?').run(SLUG);
  };

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    student = await srv.login(STUDENT);
    studentId = (await me()).body.id;
    other = await srv.login(OTHER_STUDENT);
    otherId = (await me(other)).body.id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    await unpublishAll();
    await db.prepare('DELETE FROM legal_change_notices WHERE user_id IN (?, ?)').run(studentId, otherId);
    await acceptedAt(studentId, '1.0');
    await acceptedAt(otherId, '1.0');
    /* The gate memoises only "does the revisions table exist", which cannot
       change here — but resetting keeps the seam honest if that ever grows. */
    __resetGateCache();
  });

  describe('before it takes effect', () => {
    /**
     * §13: "If a change matters, we will tell you in the app at least 30 days
     * before it takes effect."
     *
     * A major revision dated in the future is therefore an ANNOUNCEMENT. If it
     * blocked on publication the product would break its own published promise
     * every time an owner used the editor correctly.
     */
    it('is announced as an ordinary notice, and blocks nothing', async () => {
      await publish('2.0.0', '2099-01-01');

      const found = (await updates()).body.updates.find(u => u.slug === SLUG);
      expect(found, 'the change must still be announced').toBeTruthy();
      expect(found.severity).toBe('material');
      expect(found.requiresAcceptance).toBe(false);
      expect(found.channel).toBe('notice');

      expect((await me()).body.withheld).not.toContain('event.apply');
    });
  });

  describe('once it has taken effect', () => {
    beforeEach(() => publish('2.0.0'));

    it('is reported as requiring acceptance, not as an ordinary notice', async () => {
      const found = (await updates()).body.updates.find(u => u.slug === SLUG);
      expect(found).toBeTruthy();
      expect(found.severity).toBe('material');
      expect(found.channel).toBe('acceptance');
      expect(found.requiresAcceptance).toBe(true);
      expect(found.previousVersion).toBe('1.0');
      expect(found.version).toBe('2.0.0');
    });

    /**
     * The property the whole design rests on.
     *
     * A dialog is a client, and the account holder is the one person with both
     * the incentive and the opportunity to edit it. If the gate lived only in
     * the bundle then "you must accept the updated terms to continue" would be
     * a sentence the product says rather than a rule it keeps.
     */
    it('withholds the participation capabilities server-side', async () => {
      const withheld = (await me()).body.withheld;
      for (const cap of SIGNUP_CONSENT_GATED_CAPABILITIES) {
        expect(withheld, `${cap} should be withheld`).toContain(cap);
      }
    });

    it('refuses a gated action even when the dialog is never rendered', async () => {
      /* No client involved at all: this is the request a patched bundle would
         make. `event.apply` is withheld, so `requireCap` refuses before the
         handler runs. */
      const res = await srv.call('POST', '/api/events/event-softball/apply', {}, student);
      expect(res.status).toBe(403);
    });

    it('leaves reading, and the way out, alone', async () => {
      /* The three things somebody deciding whether to accept has to be able to
         do: read the app, read their own record, and read the document. */
      expect((await srv.call('GET', '/api/events', undefined, student)).status).toBe(200);
      expect((await me()).status).toBe(200);
      expect((await srv.call('GET', `/api/legal/documents/${SLUG}`)).status).toBe(200);
    });

    describe('accepting it', () => {
      it('records the acceptance and releases the capabilities', async () => {
        const res = await accept(SLUG, '2.0.0');
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.accepted).toBe(true);

        expect((await me()).body.withheld).not.toContain('event.apply');
        expect((await updates()).body.updates.find(u => u.slug === SLUG)).toBeUndefined();
      });

      it('writes a consent row naming the version actually in effect', async () => {
        await accept(SLUG, '2.0.0');

        const row = await db.prepare(`SELECT version, content_hash, method
          FROM legal_acceptances WHERE user_id = ? AND document_slug = ? AND method = 'reconsent'`)
          .get(studentId, SLUG);

        expect(row).toBeTruthy();
        expect(row.version).toBe('2.0.0');
        /* The hash comes from the resolved revision, never from the request —
           an acceptance record whose hash the client chose would be a record of
           bytes nobody can prove were shown. */
        expect(row.content_hash).toBe('hash-2.0.0');
      });

      it('keeps the original acceptance rather than rewriting it', async () => {
        /* "When did they agree to 1.0" must still have an answer after they
           agree to 2.0.0. `legal_acceptances` is a log, not a current-state
           table. */
        await accept(SLUG, '2.0.0');
        const versions = (await db.prepare(
          'SELECT version FROM legal_acceptances WHERE user_id = ? AND document_slug = ? ORDER BY version'
        ).all(studentId, SLUG)).map(r => r.version);
        expect(versions).toEqual(['1.0', '2.0.0']);
      });

      it('is refused a second time rather than writing a duplicate', async () => {
        expect((await accept(SLUG, '2.0.0')).status).toBe(200);

        const again = await accept(SLUG, '2.0.0');
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('not_required');

        const count = (await db.prepare(
          `SELECT COUNT(*) AS c FROM legal_acceptances
           WHERE user_id = ? AND document_slug = ? AND method = 'reconsent'`
        ).get(studentId, SLUG)).c;
        expect(count).toBe(1);
      });

      it('does not touch anybody else', async () => {
        await accept(SLUG, '2.0.0');

        expect((await me(other)).body.withheld).toContain('event.apply');
        expect((await updates(other)).body.updates.find(u => u.slug === SLUG).requiresAcceptance)
          .toBe(true);

        const rows = (await db.prepare(
          `SELECT COUNT(*) AS c FROM legal_acceptances WHERE method = 'reconsent' AND user_id != ?`
        ).get(studentId)).c;
        expect(rows).toBe(0);
      });
    });

    describe('what a hostile client cannot do', () => {
      it('cannot accept a version that is not the one in effect', async () => {
        /* A stale tab, or a client claiming to have read something else. The
           record would name a version this person was never shown. */
        const res = await accept(SLUG, '3.0.0');
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('version_stale');
        expect(res.body.version).toBe('2.0.0');
      });

      it('cannot invent an acceptance for a document nobody is being asked about', async () => {
        /* `privacy-policy` has no revision, so nothing is owed on it. A 200
           here would mint a consent row out of a request body. */
        const res = await accept('privacy-policy', '1.0');
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('not_required');

        const rows = (await db.prepare(
          `SELECT COUNT(*) AS c FROM legal_acceptances
           WHERE user_id = ? AND document_slug = 'privacy-policy' AND method = 'reconsent'`
        ).get(studentId)).c;
        expect(rows).toBe(0);
      });

      it('cannot accept a document that does not exist', async () => {
        expect((await accept('not-a-real-policy', '2.0.0')).status).toBe(404);
      });

      it('cannot accept without a session', async () => {
        const res = await srv.call('POST', '/api/legal/updates/accept', { slug: SLUG, version: '2.0.0' });
        expect(res.status).toBe(401);
      });

      it('rejects a malformed body', async () => {
        expect((await accept(undefined, '2.0.0')).status).toBe(400);
        expect((await accept(SLUG, undefined)).status).toBe(400);
      });

      /**
       * The most important refusal in the file.
       *
       * Dismissing the ordinary notice writes `legal_change_notices`, which is
       * deliberately not the consent table. If an acknowledgement satisfied the
       * gate, a client could clear a mandatory acceptance by calling the
       * dismiss endpoint — turning "I saw a popup" into "I agreed", which is
       * the exact defect migration 039 exists to make impossible.
       */
      it('cannot dismiss its way out of a mandatory acceptance', async () => {
        const ack = await srv.call(
          'POST', '/api/legal/updates/acknowledge', { slug: SLUG, version: '2.0.0' }, student
        );
        expect(ack.status).toBe(200);

        expect((await me()).body.withheld).toContain('event.apply');
        const found = (await updates()).body.updates.find(u => u.slug === SLUG);
        expect(found, 'the acceptance is still owed').toBeTruthy();
        expect(found.requiresAcceptance).toBe(true);
      });
    });

    describe('reloading does not change the answer', () => {
      it('reports the same state on repeated reads', async () => {
        const a = (await updates()).body.updates.find(u => u.slug === SLUG);
        const b = (await updates()).body.updates.find(u => u.slug === SLUG);
        expect(b).toEqual(a);
      });

      it('and the same after accepting, however many times it is asked', async () => {
        await accept(SLUG, '2.0.0');
        for (let i = 0; i < 3; i += 1) {
          expect((await updates()).body.updates.find(u => u.slug === SLUG)).toBeUndefined();
          expect((await me()).body.withheld).not.toContain('event.apply');
        }
      });
    });
  });

  describe('several documents at once', () => {
    /**
     * Two changes of different weights, on the same account, at the same time.
     *
     * The property that matters is that each document appears exactly ONCE and
     * on exactly one channel — never as a banner and a dialog for the same
     * change, which is the redundancy this feature was asked to avoid.
     */
    it('labels each change on one channel only', async () => {
      await publish('2.0.0');
      await db.prepare(`INSERT INTO legal_document_revisions
        (slug, version, body, content_hash, effective_at, created_at, created_by)
        VALUES ('privacy-policy', '1.1.0', ?, 'hash-pp-110', '2026-01-01', ?, NULL)`)
        .run('## Draft\nWe have clarified how long diagnostic records are kept.', new Date().toISOString());
      await db.prepare(`INSERT INTO legal_acceptances
        (id, user_id, document_slug, version, content_hash, accepted_at, method, context)
        VALUES (?, ?, 'privacy-policy', '1.0', 'hash-pp', ?, 'signup', 'test-fixture')`)
        .run(`acc-pp-${studentId}`, studentId, new Date().toISOString());

      try {
        const found = (await updates()).body.updates;
        const bySlug = new Map(found.map(u => [u.slug, u]));

        expect(bySlug.get(SLUG).channel).toBe('acceptance');
        expect(bySlug.get('privacy-policy').channel).toBe('notice');

        /* One entry per document. A duplicate here is a duplicate notification. */
        expect(found.length).toBe(new Set(found.map(u => u.slug)).size);
      } finally {
        await db.prepare("DELETE FROM legal_document_revisions WHERE slug = 'privacy-policy'").run();
        await db.prepare("DELETE FROM legal_acceptances WHERE user_id = ? AND document_slug = 'privacy-policy'")
          .run(studentId);
      }
    });

    it('withholds until the LAST owed acceptance is recorded', async () => {
      await publish('2.0.0');
      await db.prepare(`INSERT INTO legal_document_revisions
        (slug, version, body, content_hash, effective_at, created_at, created_by)
        VALUES ('community-guidelines', '2.0.0', ?, 'hash-cg-200', '2026-01-01', ?, NULL)`)
        .run('## Draft\nWe may now remove an account without warning.', new Date().toISOString());
      await db.prepare(`INSERT INTO legal_acceptances
        (id, user_id, document_slug, version, content_hash, accepted_at, method, context)
        VALUES (?, ?, 'community-guidelines', '1.0', 'hash-cg', ?, 'signup', 'test-fixture')`)
        .run(`acc-cg-${studentId}`, studentId, new Date().toISOString());

      try {
        expect((await me()).body.withheld).toContain('event.apply');

        await accept(SLUG, '2.0.0');
        expect(
          (await me()).body.withheld,
          'one of two accepted is still one owed'
        ).toContain('event.apply');

        await accept('community-guidelines', '2.0.0');
        expect((await me()).body.withheld).not.toContain('event.apply');
      } finally {
        await db.prepare("DELETE FROM legal_document_revisions WHERE slug = 'community-guidelines'").run();
        await db.prepare("DELETE FROM legal_acceptances WHERE user_id = ? AND document_slug = 'community-guidelines'")
          .run(studentId);
      }
    });
  });

  describe('accounts the gate must not catch', () => {
    /**
     * A seeded or legacy account has no consent row, so it was never shown a
     * previous version and cannot be asked to re-accept one. Treating absence
     * as "behind" would gate the entire existing population out of the product
     * on the first major revision.
     */
    it('an account that never accepted the document', async () => {
      await publish('2.0.0');
      await db.prepare('DELETE FROM legal_acceptances WHERE user_id = ? AND document_slug = ?')
        .run(studentId, SLUG);

      expect((await me()).body.withheld).not.toContain('event.apply');
      expect((await updates()).body.updates.find(u => u.slug === SLUG)).toBeUndefined();
    });

    it('an account already at the current version', async () => {
      await publish('2.0.0');
      await acceptedAt(studentId, '2.0.0');

      expect((await me()).body.withheld).not.toContain('event.apply');
      expect((await updates()).body.updates.find(u => u.slug === SLUG)).toBeUndefined();
    });

    /**
     * Version skips. Somebody away for a term comes back several versions
     * behind, all of them clarifications. §13's test is consequence, not
     * distance, so this is still notice only.
     */
    it('an account several clarifications behind', async () => {
      await publish('1.1.0');
      await publish('1.2.0');
      await publish('1.3.0');

      expect((await me()).body.withheld).not.toContain('event.apply');
      const found = (await updates()).body.updates.find(u => u.slug === SLUG);
      expect(found.version).toBe('1.3.0');
      expect(found.requiresAcceptance).toBe(false);
    });
  });

  describe('the version an account has been shown', () => {
    /**
     * `legal_change_notices` holds one row per version and the query that reads
     * it has no ORDER BY, so "whichever row came back last" could name the
     * older one — and the notice would return for ever.
     */
    it('is the newest of several acknowledgements, not an arbitrary one', async () => {
      await publish('1.1.0');
      await publish('1.2.0');

      for (const v of ['1.1.0', '1.2.0']) {
        await srv.call('POST', '/api/legal/updates/acknowledge', { slug: SLUG, version: v }, student);
      }

      expect(
        (await updates()).body.updates.find(u => u.slug === SLUG),
        'both versions were acknowledged, so there is nothing left to say'
      ).toBeUndefined();
    });

    /**
     * An acknowledgement of an older version must not outrank an acceptance of
     * a newer one — the previous implementation preferred acknowledgements
     * unconditionally, so the mandatory dialog reopened after it had been
     * answered.
     */
    it('prefers whichever record is newer, not whichever table it is in', async () => {
      await publish('2.0.0');
      await srv.call('POST', '/api/legal/updates/acknowledge', { slug: SLUG, version: '1.0' }, student);
      expect((await accept(SLUG, '2.0.0')).status).toBe(200);

      expect((await updates()).body.updates.find(u => u.slug === SLUG)).toBeUndefined();
      expect((await me()).body.withheld).not.toContain('event.apply');
    });
  });
  describe('the effective-date boundary', () => {
    /**
     * The day the obligation attaches, driven by the clock rather than argued
     * about.
     *
     * One revision, three readings of the same database at three moments. The
     * publication does not change between them — only `now` does — which is
     * the property that matters: an admin pressing Save is not what gates
     * anybody, the printed effective date is.
     *
     * `pendingNoticesFor` takes an injectable clock for exactly this. The
     * capability gate reads the same rule through `noticeChannelFor`, so
     * asserting the channel here asserts both.
     */
    const AT = '2026-09-25';
    const noticesAt = async (iso) => {
      const { pendingNoticesFor } = await import('./legalNotices.js');
      const list = await pendingNoticesFor(db, studentId, { now: new Date(`${iso}T12:00:00Z`) });
      return list.find(u => u.slug === SLUG);
    };

    beforeEach(() => publish('2.0.0', AT));

    it('the day before: announced, material, and not enforceable', async () => {
      const found = await noticesAt('2026-09-24');
      expect(found.severity).toBe('material');
      expect(found.channel).toBe('notice');
      expect(found.requiresAcceptance).toBe(false);
    });

    it('the day itself: mandatory', async () => {
      const found = await noticesAt(AT);
      expect(found.channel).toBe('acceptance');
      expect(found.requiresAcceptance).toBe(true);
    });

    it('the day after: still mandatory', async () => {
      const found = await noticesAt('2026-09-26');
      expect(found.requiresAcceptance).toBe(true);
    });

    it('and the version in effect never changes across the boundary', async () => {
      /* Resolution is by insertion order, not by date — `legalStore.js`'s
         EFFECTIVE_DATE_MODEL note. The TEXT is public from the moment it is
         saved; only the obligation waits. */
      for (const day of ['2026-09-24', AT, '2026-09-26']) {
        expect((await noticesAt(day)).version).toBe('2.0.0');
      }
      const served = await srv.call('GET', `/api/legal/documents/${SLUG}`);
      expect(served.body.version).toBe('2.0.0');
      expect(served.body.effectiveAt).toBe(AT);
    });

    it('and the document is readable throughout, signed in or not', async () => {
      /* A reader cannot be asked to accept something they cannot read, and the
         document route is public precisely so that holds before the account
         exists as well as while it is gated. */
      expect((await srv.call('GET', `/api/legal/documents/${SLUG}`)).status).toBe(200);
      expect((await srv.call('GET', `/api/legal/documents/${SLUG}`, undefined, student)).status)
        .toBe(200);
    });
  });

});
