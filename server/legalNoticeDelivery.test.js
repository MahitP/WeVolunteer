import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { startTestServer } from './testServer.js';
import { dispatchLegalChangeNotices, recordNotified } from './legalNotices.js';

/**
 * Telling people by email and in the notification centre, exactly once.
 *
 * ── What this covers that the in-app tests do not ──
 *
 * `routes.legalUpdates.test.js` and `routes.legalReconsent.test.js` cover the
 * banner and the dialog — the channels that only reach somebody who is already
 * looking at the application. §13 of the Terms promises more than that, and the
 * ICO's guidance on the right to be informed says the same in the general case:
 * a change has to be communicated actively, before the new processing begins,
 * rather than by editing a page and waiting to be visited.
 *
 * The properties that make an active channel safe are all failure properties,
 * which is why most of this file is about things NOT happening: not twice, not
 * to the wrong person, not the wrong one of the two messages, and not in a way
 * that lets a mail server decide whether somebody is bound by a contract.
 */

const STUDENT = 'leo.chen@example.com';
const OTHER = 'priya.patel@example.com';
const SLUG = 'terms-of-service';
const MINOR_SLUG = 'privacy-policy';

describe('legal change delivery', () => {
  let srv;
  let db;
  let studentId;
  let otherId;

  /** Records an acceptance at `version`, as signup would have. */
  const acceptedAt = async (userId, slug, version) => {
    await db.prepare('DELETE FROM legal_acceptances WHERE user_id = ? AND document_slug = ?')
      .run(userId, slug);
    await db.prepare(`INSERT INTO legal_acceptances
      (id, user_id, document_slug, version, content_hash, accepted_at, method, context)
      VALUES (?, ?, ?, ?, ?, ?, 'signup', 'delivery-fixture')`)
      .run(`acc-d-${userId}-${slug}`, userId, slug, version, `hash-${slug}`,
        new Date().toISOString());
  };

  const publish = async (slug, version, effectiveAt, body) => {
    await db.prepare(`INSERT INTO legal_document_revisions
      (slug, version, body, content_hash, effective_at, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, NULL)`)
      .run(slug, version, body ?? 'We may now share your attendance record with your school district.',
        `hash-${slug}-${version}`, effectiveAt, new Date().toISOString());
  };

  /** A dispatcher that records rather than enqueues, so the decision is visible. */
  const spy = () => {
    const calls = [];
    return {
      calls,
      fn: async (event, payload, userId, dedupeKey) => {
        calls.push({ event, payload, userId, dedupeKey });
        return true;
      },
    };
  };

  const sweep = (dispatch, now) =>
    dispatchLegalChangeNotices(db, { dispatch, ...(now ? { now } : {}) });

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    const student = await srv.login(STUDENT);
    studentId = (await srv.call('GET', '/api/auth/me', undefined, student)).body.id;
    const other = await srv.login(OTHER);
    otherId = (await srv.call('GET', '/api/auth/me', undefined, other)).body.id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    await db.prepare('DELETE FROM legal_document_revisions').run();
    await db.prepare('DELETE FROM legal_change_notices').run();
    await db.prepare("DELETE FROM legal_acceptances WHERE context = 'delivery-fixture'").run();
    /* The queue too. The outbox tests below drive the real worker, and a job
       left behind by one of them is a job the next one's `processNotificationJobs`
       picks up first — which presents as "the provider was never attempted"
       for a reason that has nothing to do with the case under test. */
    await db.prepare('DELETE FROM notification_jobs').run();
    await db.prepare("DELETE FROM notifications WHERE dedupe_key LIKE 'legal:%'").run();
  });

  describe('when nothing has been published', () => {
    it('sends nothing, and does not even look for an audience', async () => {
      /* The fast path. With no revision row the version in effect is the
         registry's, which is the version every acceptance was written at, so
         nobody can be behind and there is nothing to query. */
      await acceptedAt(studentId, SLUG, '1.0');
      const s = spy();
      expect(await sweep(s.fn)).toEqual({ notified: 0, documents: [] });
      expect(s.calls).toHaveLength(0);
    });
  });

  describe('a clarification', () => {
    beforeEach(async () => {
      await acceptedAt(studentId, MINOR_SLUG, '1.0');
      await publish(MINOR_SLUG, '1.1.0', '2026-01-01',
        'We have clarified how long diagnostic records are kept.');
    });

    it('sends the ordinary update notice', async () => {
      const s = spy();
      const result = await sweep(s.fn);

      expect(result.notified).toBe(1);
      expect(s.calls).toHaveLength(1);
      expect(s.calls[0].event).toBe('LEGAL_DOCUMENT_UPDATED');
      expect(s.calls[0].userId).toBe(studentId);
      expect(s.calls[0].payload).toMatchObject({
        slug: MINOR_SLUG, version: '1.1.0', previousVersion: '1.0', severity: 'minor',
      });
    });

    it('keys the dedupe on the document and the version', async () => {
      const s = spy();
      await sweep(s.fn);
      expect(s.calls[0].dedupeKey).toBe(`legal:${MINOR_SLUG}:1.1.0`);
    });

    it('carries an excerpt of what is genuinely new', async () => {
      const s = spy();
      await sweep(s.fn);
      expect(s.calls[0].payload.excerpt).toMatch(/diagnostic records/);
    });
  });

  describe('a material change', () => {
    beforeEach(() => acceptedAt(studentId, SLUG, '1.0'));

    /**
     * The pair is mutually exclusive by SEVERITY, not by which surface owns the
     * change today. A major revision dated a month out is an advance notice
     * now and a blocking dialog later, and it is one change: the reader is
     * told once, at publication, that it is significant and that they will be
     * asked to accept it.
     */
    it('sends the acceptance-required notice, never the ordinary one', async () => {
      await publish(SLUG, '2.0.0', '2099-01-01');
      const s = spy();
      await sweep(s.fn);

      expect(s.calls.map(c => c.event)).toEqual(['LEGAL_ACCEPTANCE_REQUIRED']);
      expect(s.calls[0].payload.severity).toBe('material');
    });

    it('says so during the notice period, in the future tense', async () => {
      await publish(SLUG, '2.0.0', '2099-01-01');
      const s = spy();
      await sweep(s.fn);

      expect(s.calls[0].payload.alreadyInEffect).toBe(false);
      expect(s.calls[0].payload.effectiveDateLabel).toMatch(/2099/);
    });

    it('and in the present tense once it is in effect', async () => {
      await publish(SLUG, '2.0.0', '2026-01-01');
      const s = spy();
      await sweep(s.fn);
      expect(s.calls[0].payload.alreadyInEffect).toBe(true);
    });

    /* One message per change, so the effective date arriving is not a second
       email. The in-app dialog is the second touch, and it is unavoidable. */
    it('does not send again when the effective date arrives', async () => {
      await publish(SLUG, '2.0.0', '2026-06-01');

      const first = spy();
      await sweep(first.fn, new Date('2026-05-01T12:00:00Z'));
      expect(first.calls).toHaveLength(1);

      const second = spy();
      await sweep(second.fn, new Date('2026-07-01T12:00:00Z'));
      expect(second.calls).toHaveLength(0);
    });
  });

  describe('exactly once', () => {
    beforeEach(async () => {
      await acceptedAt(studentId, MINOR_SLUG, '1.0');
      await publish(MINOR_SLUG, '1.1.0', '2026-01-01');
    });

    it('does not send again on the next pass', async () => {
      const first = spy();
      await sweep(first.fn);
      expect(first.calls).toHaveLength(1);

      const second = spy();
      await sweep(second.fn);
      expect(second.calls).toHaveLength(0);
    });

    /**
     * Concurrency, driven rather than reasoned about.
     *
     * Two passes overlapping is not hypothetical: the sweep runs at boot AND on
     * an interval, so a slow first pass and a restart produce exactly this. The
     * lease is a conditional UPDATE, so the database decides and one of them
     * gets nothing.
     */
    it('survives two passes running at the same time', async () => {
      const a = spy();
      const b = spy();
      await Promise.all([sweep(a.fn), sweep(b.fn)]);

      expect(a.calls.length + b.calls.length, 'one of the two passes must lose').toBe(1);

      const rows = (await db.prepare(
        'SELECT COUNT(*) AS c FROM legal_change_notices WHERE slug = ? AND notified_at IS NOT NULL'
      ).get(MINOR_SLUG)).c;
      expect(rows).toBe(1);
    });

    /**
     * The classic outbox failure: the lease is taken and the enqueue then
     * fails. Both are in one transaction, so the rollback releases the lease
     * and the next pass tries again — rather than recording a notification
     * nobody was sent.
     */
    it('releases the claim when the enqueue fails, so a retry still delivers', async () => {
      const failing = vi.fn().mockRejectedValue(new Error('outbox unavailable'));
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

      await sweep(failing);
      expect(failing).toHaveBeenCalledTimes(1);

      const stranded = (await db.prepare(
        'SELECT COUNT(*) AS c FROM legal_change_notices WHERE slug = ? AND notified_at IS NOT NULL'
      ).get(MINOR_SLUG)).c;
      expect(stranded, 'a rolled-back transaction must leave no lease behind').toBe(0);

      const retry = spy();
      await sweep(retry.fn);
      expect(retry.calls).toHaveLength(1);
      quiet.mockRestore();
    });

    it('is not defeated by having already dismissed the in-app banner', async () => {
      /* Acknowledgement is what the reader did; notification is what the
         platform did. A row carrying one must still be claimable for the
         other. */
      await db.prepare(`INSERT INTO legal_change_notices (user_id, slug, version, acknowledged_at)
        VALUES (?, ?, '1.1.0', ?)`).run(studentId, MINOR_SLUG, new Date().toISOString());

      const s = spy();
      await sweep(s.fn);
      expect(s.calls).toHaveLength(1);

      const row = await db.prepare(
        'SELECT notified_at, acknowledged_at FROM legal_change_notices WHERE user_id = ? AND slug = ?'
      ).get(studentId, MINOR_SLUG);
      expect(row.notified_at, 'the claim must fill in the column it owns').toBeTruthy();
      expect(row.acknowledged_at, 'and must not touch the other one').toBeTruthy();
    });
  });

  describe('who is told', () => {
    it('not an account that never accepted the document', async () => {
      /* Same rule as the banner: no previous version they were shown, so there
         is no change to announce to them. */
      await publish(MINOR_SLUG, '1.1.0', '2026-01-01');
      const s = spy();
      await sweep(s.fn);
      expect(s.calls).toHaveLength(0);
    });

    it('not an account already at the current version', async () => {
      await acceptedAt(studentId, MINOR_SLUG, '1.1.0');
      await publish(MINOR_SLUG, '1.1.0', '2026-01-01');
      const s = spy();
      await sweep(s.fn);
      expect(s.calls).toHaveLength(0);
    });

    it('everybody who is behind, and only them', async () => {
      await acceptedAt(studentId, MINOR_SLUG, '1.0');
      await acceptedAt(otherId, MINOR_SLUG, '1.1.0');
      await publish(MINOR_SLUG, '1.1.0', '2026-01-01');

      const s = spy();
      await sweep(s.fn);
      expect(s.calls.map(c => c.userId)).toEqual([studentId]);
    });

    it('somebody whose only record is an acknowledgement', async () => {
      /**
       * Keeps the mail audience identical to the banner's. `pendingNoticesFor`
       * treats an acknowledgement as a record of having been shown a version,
       * so a reader whose only record is one is still owed notice of the next
       * change — and the two must not disagree about who is behind.
       */
      await db.prepare(`INSERT INTO legal_change_notices (user_id, slug, version, acknowledged_at)
        VALUES (?, 'accessibility-statement', '1.0', ?)`)
        .run(studentId, new Date().toISOString());
      await publish('accessibility-statement', '1.1.0', '2026-01-01');

      const s = spy();
      await sweep(s.fn);
      expect(s.calls.map(c => c.userId)).toEqual([studentId]);
    });

    it('not a deleted account', async () => {
      /* The outbox worker drops their jobs anyway — the address is a reserved
         placeholder — but writing an in-app row for an account nobody can sign
         into is pointless, and the alert channel pays for the bounce. */
      await acceptedAt(studentId, MINOR_SLUG, '1.0');
      await publish(MINOR_SLUG, '1.1.0', '2026-01-01');
      const before = await db.prepare('SELECT account_status FROM users WHERE id = ?').get(studentId);

      await db.prepare("UPDATE users SET account_status = 'deleted' WHERE id = ?").run(studentId);
      try {
        const s = spy();
        await sweep(s.fn);
        expect(s.calls).toHaveLength(0);
      } finally {
        await db.prepare('UPDATE users SET account_status = ? WHERE id = ?')
          .run(before.account_status, studentId);
      }
    });

    it('a suspended account, because email is the only channel that reaches them', async () => {
      await acceptedAt(studentId, MINOR_SLUG, '1.0');
      await publish(MINOR_SLUG, '1.1.0', '2026-01-01');
      const before = await db.prepare('SELECT account_status FROM users WHERE id = ?').get(studentId);

      await db.prepare("UPDATE users SET account_status = 'suspended' WHERE id = ?").run(studentId);
      try {
        const s = spy();
        await sweep(s.fn);
        expect(s.calls.map(c => c.userId)).toEqual([studentId]);
      } finally {
        await db.prepare('UPDATE users SET account_status = ? WHERE id = ?')
          .run(before.account_status, studentId);
      }
    });

    it('nobody, for a document with its own re-acceptance screen', async () => {
      /* The Organizer Agreement withholds capabilities on ANY version change
         and renders the whole document with its seven checkboxes. A notice
         about a change that is about to be put in front of somebody in full is
         the same news twice. */
      await acceptedAt(studentId, 'organizer-agreement', '1.0');
      await publish('organizer-agreement', '2.0.0', '2026-01-01');

      const s = spy();
      await sweep(s.fn);
      expect(s.calls).toHaveLength(0);
    });
  });

  describe('delivery is not enforcement', () => {
    /**
     * The property that keeps a mail server out of the consent model.
     *
     * `signupConsentWithholdingsFor` reads acceptance rows and the effective
     * date. It never reads `notified_at`, so neither a delivered email nor a
     * failed one can move a capability in either direction.
     */
    it('a sent notification does not release a withheld capability', async () => {
      await acceptedAt(studentId, SLUG, '1.0');
      await publish(SLUG, '2.0.0', '2026-01-01');

      const s = spy();
      await sweep(s.fn);
      expect(s.calls).toHaveLength(1);

      const session = await srv.login(STUDENT);
      const me = await srv.call('GET', '/api/auth/me', undefined, session);
      expect(me.body.withheld).toContain('event.apply');
    });

    it('a failed notification does not release one either, or break the app', async () => {
      await acceptedAt(studentId, SLUG, '1.0');
      await publish(SLUG, '2.0.0', '2026-01-01');

      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(sweep(vi.fn().mockRejectedValue(new Error('smtp down'))))
        .resolves.toMatchObject({ notified: 0 });
      quiet.mockRestore();

      const session = await srv.login(STUDENT);
      expect((await srv.call('GET', '/api/auth/me', undefined, session)).status).toBe(200);
      const updates = await srv.call('GET', '/api/legal/updates', undefined, session);
      expect(updates.status).toBe(200);
      expect(updates.body.updates.find(u => u.slug === SLUG).requiresAcceptance).toBe(true);
    });

    it('one recipient failing does not stop the rest being told', async () => {
      await acceptedAt(studentId, MINOR_SLUG, '1.0');
      await acceptedAt(otherId, MINOR_SLUG, '1.0');
      await publish(MINOR_SLUG, '1.1.0', '2026-01-01');

      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      const seen = [];
      let first = true;
      await sweep(async (event, payload, userId) => {
        if (first) { first = false; throw new Error('one bad row'); }
        seen.push(userId);
      });
      quiet.mockRestore();

      expect(seen).toHaveLength(1);
    });
  });

  describe('the notification claim', () => {
    it('is true once and false afterwards', async () => {
      expect(await recordNotified(db, studentId, MINOR_SLUG, '1.1.0')).toBe(true);
      expect(await recordNotified(db, studentId, MINOR_SLUG, '1.1.0')).toBe(false);
    });

    it('keeps the first timestamp rather than moving it', async () => {
      await recordNotified(db, studentId, MINOR_SLUG, '1.1.0',
        { now: new Date('2026-01-01T00:00:00Z') });
      await recordNotified(db, studentId, MINOR_SLUG, '1.1.0',
        { now: new Date('2026-02-01T00:00:00Z') });

      const row = await db.prepare(
        'SELECT notified_at FROM legal_change_notices WHERE user_id = ? AND slug = ? AND version = ?'
      ).get(studentId, MINOR_SLUG, '1.1.0');
      expect(row.notified_at).toBe('2026-01-01T00:00:00.000Z');
    });

    it('is per version, so a later change is claimable again', async () => {
      expect(await recordNotified(db, studentId, MINOR_SLUG, '1.1.0')).toBe(true);
      expect(await recordNotified(db, studentId, MINOR_SLUG, '1.2.0')).toBe(true);
    });

    it('is claimable on a row that already records an acknowledgement', async () => {
      /* The two columns record two facts about two different actors. A reader
         who dismissed the banner has not been emailed, and the row they
         created must not block the claim for the column they do not own. */
      await db.prepare(`INSERT INTO legal_change_notices (user_id, slug, version, acknowledged_at)
        VALUES (?, ?, '1.4.0', ?)`).run(studentId, MINOR_SLUG, new Date().toISOString());

      expect(await recordNotified(db, studentId, MINOR_SLUG, '1.4.0')).toBe(true);

      const row = await db.prepare(`SELECT notified_at, acknowledged_at
        FROM legal_change_notices WHERE user_id = ? AND slug = ? AND version = '1.4.0'`)
        .get(studentId, MINOR_SLUG);
      expect(row.notified_at).toBeTruthy();
      expect(row.acknowledged_at, 'the claim must not overwrite the other column').toBeTruthy();
    });

    it('never writes a consent record', async () => {
      const before = (await db.prepare(
        'SELECT COUNT(*) AS c FROM legal_acceptances WHERE user_id = ?'
      ).get(studentId)).c;
      await recordNotified(db, studentId, MINOR_SLUG, '1.1.0');
      const after = (await db.prepare(
        'SELECT COUNT(*) AS c FROM legal_acceptances WHERE user_id = ?'
      ).get(studentId)).c;
      expect(after).toBe(before);
    });
  });

  describe('several documents changing together', () => {
    it('sends one message per document, each on its own channel', async () => {
      await acceptedAt(studentId, SLUG, '1.0');
      await acceptedAt(studentId, MINOR_SLUG, '1.0');
      await publish(SLUG, '2.0.0', '2026-01-01');
      await publish(MINOR_SLUG, '1.1.0', '2026-01-01');

      const s = spy();
      await sweep(s.fn);

      const bySlug = Object.fromEntries(s.calls.map(c => [c.payload.slug, c.event]));
      expect(bySlug).toEqual({
        [SLUG]: 'LEGAL_ACCEPTANCE_REQUIRED',
        [MINOR_SLUG]: 'LEGAL_DOCUMENT_UPDATED',
      });
      /* One per document, not one per document per pass. */
      expect(s.calls).toHaveLength(2);
    });
  });
  /**
   * ── Through the REAL outbox, all the way to the transport ──
   *
   * Everything above injects a dispatcher, which is the right seam for testing
   * the DECISION. These two go through `notificationService.dispatch`, the
   * `notification_jobs` table and `processNotificationJobs` to a stubbed
   * transport, because the properties that matter here belong to the pipeline
   * rather than to the rule: that a legal notice really does become a queued
   * job, that a provider failure retries it rather than losing it, and that a
   * retry does not deliver twice.
   *
   * The queue's own reliability — backoff, the attempt ceiling, reclaiming a
   * job stranded in `processing` by a restart, the health summary — is covered
   * by `notificationWorker.reliability.test.js` against the same code path.
   * Reusing that queue rather than building a second one is what makes those
   * tests apply to this feature.
   */
  describe('through the real outbox', () => {
    it('becomes a queued email job that reaches the transport', async () => {
      const mail = await import('./email.js');
      const { processNotificationJobs } = await import('./workers/notificationWorker.js');

      await acceptedAt(studentId, MINOR_SLUG, '1.0');
      await publish(MINOR_SLUG, '1.1.0', '2026-01-01',
        'We have clarified how long diagnostic records are kept.');

      /* The real dispatcher this time — no `dispatch` override. */
      const result = await dispatchLegalChangeNotices(db);
      expect(result.notified).toBe(1);

      const queued = await db.prepare(
        "SELECT COUNT(*) AS c FROM notification_jobs WHERE channel = 'email'"
      ).get();
      expect(queued.c, 'the sweep must enqueue rather than send inline').toBe(1);

      const sent = [];
      mail.setMailTransportForTests({
        sendMail: async (m) => { sent.push(m); return { messageId: 'test-1' }; },
      });
      try {
        await processNotificationJobs();
      } finally {
        mail.setMailTransportForTests(null);
      }

      expect(sent, 'the queued job must reach the transport').toHaveLength(1);
      expect(sent[0].to).toContain('@');
      expect(sent[0].subject).toMatch(/Privacy Policy has been updated/);
      /* The canonical route, and the plain-text part carries it too. */
      expect(sent[0].text).toMatch(/\/legal\/privacy-policy/);
      expect(sent[0].html).toMatch(/\/legal\/privacy-policy/);
      /* And it does not claim anything was accepted. */
      expect(sent[0].text).toMatch(/nothing has been recorded as accepted/i);
    });

    it('retries a provider failure on the notification job, delivering exactly once', async () => {
      /**
       * ── Which layer holds the retry, read rather than guessed ──
       *
       * Two drafts of this test asserted the wrong thing before the code said
       * so. `email.js` has a durable mail outbox that re-queues a message a
       * provider could not take — but `sendMail`, the function the notification
       * worker calls, passes `queueOnFailure: false` and THROWS instead, and
       * its comment says why: *"Throwing is the contract the callers were
       * written against: the worker catches this and schedules its own next
       * attempt."*
       *
       * So for a notification there is one queue, not two: the notification job
       * itself, with the worker's exponential backoff and its five-attempt
       * ceiling. That is the layer this asserts against.
       *
       * The provider chain is driven through `setProvidersForTests` — the seam
       * `emailFailureMatrix.test.js` uses — rather than through the transport,
       * because whether a transport error counts as transient is that file's
       * subject and not this one's.
       */
      const svc = await import('./emailService.js');
      const { EmailSendError, FAILURE } = await import('./emailProviders.js');
      const { processNotificationJobs } = await import('./workers/notificationWorker.js');

      await acceptedAt(studentId, MINOR_SLUG, '1.0');
      await publish(MINOR_SLUG, '1.1.0', '2026-01-01');
      await dispatchLegalChangeNotices(db);

      const probe = (fail) => {
        const sent = [];
        return {
          name: 'probe', sent,
          isConfigured: () => true,
          describe: () => ({ provider: 'probe', configured: true }),
          async send(message) {
            sent.push(message);
            if (fail) {
              throw new EmailSendError('probe is down',
                { category: FAILURE.TRANSIENT, provider: 'probe' });
            }
            return { messageId: `probe-${sent.length}`, provider: 'probe' };
          },
        };
      };

      const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const quietErr = vi.spyOn(console, 'error').mockImplementation(() => {});

      const down = probe(true);
      let restore = svc.setProvidersForTests({ resend: down, smtp: null });
      try {
        await processNotificationJobs();
      } finally {
        restore();
      }

      expect(down.sent.length, 'the provider was actually attempted').toBeGreaterThan(0);

      /* Kept, not lost: still queued, an attempt recorded, and a later retry
         time set by the worker's backoff. */
      const afterFailure = await db.prepare(
        "SELECT status, attempts FROM notification_jobs WHERE channel = 'email'"
      ).get();
      expect(afterFailure, 'a failed notification must not be deleted').toBeTruthy();
      expect(afterFailure.status).toBe('pending');
      expect(afterFailure.attempts).toBe(1);

      /* The lease is still held, so the sweep does not enqueue a SECOND notice
         beside the one waiting to retry. This is the property that stops an
         outage turning into a mailstorm when it ends. */
      const again = await dispatchLegalChangeNotices(db);
      expect(again.notified).toBe(0);
      expect((await db.prepare(
        "SELECT COUNT(*) AS c FROM notification_jobs WHERE channel = 'email'"
      ).get()).c).toBe(1);

      /* Let the retry come due and the provider recover. */
      await db.prepare("UPDATE notification_jobs SET next_attempt_at = ? WHERE channel = 'email'")
        .run(new Date(Date.now() - 1000).toISOString());

      const up = probe(false);
      restore = svc.setProvidersForTests({ resend: up, smtp: null });
      try {
        await processNotificationJobs();
      } finally {
        restore();
        quiet.mockRestore();
        quietErr.mockRestore();
      }

      expect(up.sent, 'exactly one delivery after the retry').toHaveLength(1);
      expect(up.sent[0].subject).toMatch(/Privacy Policy has been updated/);
      expect((await db.prepare(
        "SELECT COUNT(*) AS c FROM notification_jobs WHERE channel = 'email'"
      ).get()).c, 'a delivered job is cleared').toBe(0);
    });

    it('does not write a consent row anywhere along the way', async () => {
      /* The whole pipeline — sweep, queue, worker, transport — must leave
         `legal_acceptances` untouched. Email sent is not acceptance. */
      const mail = await import('./email.js');
      const { processNotificationJobs } = await import('./workers/notificationWorker.js');

      await acceptedAt(studentId, SLUG, '1.0');
      await publish(SLUG, '2.0.0', '2026-01-01');

      const before = (await db.prepare(
        'SELECT COUNT(*) AS c FROM legal_acceptances WHERE user_id = ?'
      ).get(studentId)).c;

      await dispatchLegalChangeNotices(db);
      mail.setMailTransportForTests({ sendMail: async () => ({ messageId: 'x' }) });
      try {
        await processNotificationJobs();
      } finally {
        mail.setMailTransportForTests(null);
      }

      const after = (await db.prepare(
        'SELECT COUNT(*) AS c FROM legal_acceptances WHERE user_id = ?'
      ).get(studentId)).c;
      expect(after).toBe(before);

      /* And the gate is still closed. */
      const session = await srv.login(STUDENT);
      const me = await srv.call('GET', '/api/auth/me', undefined, session);
      expect(me.body.withheld).toContain('event.apply');
    });
  });

});
