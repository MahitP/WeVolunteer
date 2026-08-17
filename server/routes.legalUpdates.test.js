import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Telling somebody a legal document changed, exactly once.
 *
 * ── What this guards ──
 *
 * The Terms of Service promise: "If a change matters, we will tell you in the
 * app at least 30 days before it takes effect… We will not change them
 * quietly." That is an obligation the product published about itself, and these
 * tests are what make it true rather than aspirational.
 *
 * The second property is that it happens ONCE. A notice that reappears every
 * time somebody opens the app is not notice, it is an obstacle, and the fastest
 * way to teach people to dismiss legal text unread.
 */

const STUDENT = 'leo.chen@example.com';

describe('legal change notices', () => {
  let srv;
  let db;
  let student;
  let studentId;
  let slug;

  const updates = (session = student) => srv.call('GET', '/api/legal/updates', undefined, session);
  const ack = (s, v, session = student) =>
    srv.call('POST', '/api/legal/updates/acknowledge', { slug: s, version: v }, session);

  /** Moves the account's acceptance back a version, so it is behind. */
  const setAcceptedVersion = async (version) => {
    await db.prepare('UPDATE legal_acceptances SET version = ? WHERE user_id = ? AND document_slug = ?')
      .run(version, studentId, slug);
  };

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    student = await srv.login(STUDENT);
    studentId = (await srv.call('GET', '/api/auth/me', undefined, student)).body.id;

    /**
     * The seed creates accounts but no consent rows — only the signup flow
     * writes those — so the fixture supplies one. Without it every assertion
     * below is vacuous: a user who has accepted nothing can be behind on
     * nothing, and the suite would skip rather than fail.
     */
    const doc = await db.prepare(
      'SELECT slug, version, content_hash FROM legal_documents ORDER BY slug LIMIT 1'
    ).get();
    expect(doc, 'no legal documents are published').toBeTruthy();
    slug = doc.slug;

    await db.prepare(`INSERT INTO legal_acceptances
      (id, user_id, document_slug, version, content_hash, accepted_at, method, context)
      VALUES (?, ?, ?, ?, ?, ?, 'signup', 'test-fixture')
    ON CONFLICT DO NOTHING`)
      .run(`acc-fixture-${studentId}`, studentId, doc.slug, doc.version, doc.content_hash, new Date().toISOString());
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    await db.prepare('DELETE FROM legal_change_notices WHERE user_id = ?').run(studentId);
    const live = await db.prepare('SELECT version FROM legal_documents WHERE slug = ? ORDER BY published_at DESC LIMIT 1').get(slug);
    await db.prepare('UPDATE legal_acceptances SET version = ? WHERE user_id = ? AND document_slug = ?')
      .run(live.version, studentId, slug);
  });

  describe('when nothing has changed', () => {
    it('says nothing', async () => {
      const res = await updates();
      expect(res.status).toBe(200);
      expect(res.body.updates.map(u => u.slug)).not.toContain(slug);
    });
  });

  describe('when a document has moved on', () => {
    it('reports it', async () => {
      await setAcceptedVersion('0.9');
      const res = await updates();

      const found = res.body.updates.find(u => u.slug === slug);
      expect(found, JSON.stringify(res.body)).toBeTruthy();
      expect(found.previousVersion).toBe('0.9');
      expect(found.title).toBeTruthy();
    });

    it('carries a version the client can show', async () => {
      await setAcceptedVersion('0.9');
      const found = (await updates()).body.updates.find(u => u.slug === slug);
      expect(found.version).toBeTruthy();
      expect(found.version).not.toBe('0.9');
    });

    it('never returns the whole document body', async () => {
      /**
       * The payload carries an excerpt, not the text. A modal that shipped an
       * entire privacy policy would be a wall nobody reads and a needless
       * payload on every app open — the link is what discharges the obligation.
       */
      await setAcceptedVersion('0.9');
      const found = (await updates()).body.updates.find(u => u.slug === slug);

      expect(found).not.toHaveProperty('body');
      if (found.excerpt) expect(found.excerpt.length).toBeLessThanOrEqual(281);
    });
  });

  describe('acknowledgement', () => {
    it('stops the notice coming back', async () => {
      await setAcceptedVersion('0.9');
      const before = (await updates()).body.updates.find(u => u.slug === slug);
      expect(before).toBeTruthy();

      const res = await ack(slug, before.version);
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      expect((await updates()).body.updates.find(u => u.slug === slug)).toBeUndefined();
    });

    it('is idempotent — acknowledging twice is one row', async () => {
      /* A double-click, a retry and a second tab must converge, not race to a
         constraint error the client has to interpret. */
      await setAcceptedVersion('0.9');
      const v = (await updates()).body.updates.find(u => u.slug === slug).version;

      expect((await ack(slug, v)).status).toBe(200);
      expect((await ack(slug, v)).status).toBe(200);

      const rows = (await db.prepare(
        'SELECT COUNT(*) AS c FROM legal_change_notices WHERE user_id = ? AND slug = ? AND version = ?'
      ).get(studentId, slug, v)).c;
      expect(rows).toBe(1);
    });

    it('keeps the first acknowledgement timestamp', async () => {
      /* The record is "when did they first see this", not "when did they last
         click". Overwriting would quietly move the date the product would cite. */
      await setAcceptedVersion('0.9');
      const v = (await updates()).body.updates.find(u => u.slug === slug).version;

      await ack(slug, v);
      const first = (await db.prepare(
        'SELECT acknowledged_at FROM legal_change_notices WHERE user_id = ? AND slug = ? AND version = ?'
      ).get(studentId, slug, v)).acknowledged_at;

      await ack(slug, v);
      const second = (await db.prepare(
        'SELECT acknowledged_at FROM legal_change_notices WHERE user_id = ? AND slug = ? AND version = ?'
      ).get(studentId, slug, v)).acknowledged_at;

      expect(second).toBe(first);
    });

    it('does NOT create a consent record', async () => {
      /**
       * The property that matters most in this file.
       *
       * Dismissing a popup is not agreeing to anything. If acknowledgement ever
       * wrote to `legal_acceptances`, every future reader of that table — the
       * one the product would produce if asked to prove somebody agreed — would
       * be reading dismissals as consent.
       */
      await setAcceptedVersion('0.9');
      const v = (await updates()).body.updates.find(u => u.slug === slug).version;

      const before = (await db.prepare('SELECT COUNT(*) AS c FROM legal_acceptances WHERE user_id = ?').get(studentId)).c;
      await ack(slug, v);
      const after = (await db.prepare('SELECT COUNT(*) AS c FROM legal_acceptances WHERE user_id = ?').get(studentId)).c;

      expect(after).toBe(before);
    });

    it('re-notifies when the document moves AGAIN', async () => {
      /**
       * Acknowledging 1.1 must not silence 1.2. The row is keyed on version
       * precisely so a later change is a fresh notice.
       *
       * Published through `legal_document_revisions`, which is where the
       * effective version actually comes from — a first draft edited the
       * `legal_documents` catalogue row instead and changed nothing, because
       * `effectiveDocuments` resolves the registry against revisions and never
       * reads that column for the version.
       */
      await setAcceptedVersion('0.9');
      const v = (await updates()).body.updates.find(u => u.slug === slug).version;
      await ack(slug, v);
      expect((await updates()).body.updates.find(u => u.slug === slug)).toBeUndefined();

      await db.prepare(`INSERT INTO legal_document_revisions
        (slug, version, body, content_hash, effective_at, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, NULL)`)
        .run(slug, '99.0', '## Draft\nA newly added sentence that nobody has seen before today.',
          'hash-99', new Date().toISOString(), new Date().toISOString());

      try {
        const again = (await updates()).body.updates.find(u => u.slug === slug);
        expect(again, 'a later version must produce a fresh notice').toBeTruthy();
        expect(again.version).toBe('99.0');
        expect(again.previousVersion).toBe(v);
      } finally {
        await db.prepare('DELETE FROM legal_document_revisions WHERE slug = ? AND version = ?').run(slug, '99.0');
      }
    });

    it('quotes a sentence that is genuinely new', async () => {
      /* End to end: the excerpt the modal shows comes from comparing the new
         body against the previous one, not from a canned string. */
      await setAcceptedVersion('0.9');
      const v = (await updates()).body.updates.find(u => u.slug === slug).version;
      await ack(slug, v);

      await db.prepare(`INSERT INTO legal_document_revisions
        (slug, version, body, content_hash, effective_at, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, NULL)`)
        .run(slug, '99.1',
          '## Draft\nWe now keep volunteer attendance records for three school years rather than one.',
          'hash-991', new Date().toISOString(), new Date().toISOString());

      try {
        const again = (await updates()).body.updates.find(u => u.slug === slug);
        expect(again.excerpt).toContain('three school years');
      } finally {
        await db.prepare('DELETE FROM legal_document_revisions WHERE slug = ? AND version = ?').run(slug, '99.1');
      }
    });
  });

  describe('refusals', () => {
    it('rejects an unauthenticated caller', async () => {
      expect((await srv.call('GET', '/api/legal/updates')).status).toBe(401);
    });

    it('rejects acknowledging without a session', async () => {
      const res = await srv.call('POST', '/api/legal/updates/acknowledge', { slug, version: '1.0' });
      expect(res.status).toBe(401);
    });

    it('rejects a missing slug', async () => {
      const res = await ack(undefined, '1.0');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('slug_required');
    });

    it('rejects a document that does not exist', async () => {
      expect((await ack('not-a-real-policy', '1.0')).status).toBe(404);
    });

    it('never acknowledges on somebody else\'s behalf', async () => {
      /* The route takes no user id — it is scoped to the session — so the only
         way to write another account's row is to be that account. Asserted
         because "there is no parameter for it" is a property that a future edge
         could quietly add. */
      await setAcceptedVersion('0.9');
      const v = (await updates()).body.updates.find(u => u.slug === slug).version;
      await ack(slug, v);

      const others = (await db.prepare(
        'SELECT COUNT(*) AS c FROM legal_change_notices WHERE user_id != ?'
      ).get(studentId)).c;
      expect(others).toBe(0);
    });
  });
});
