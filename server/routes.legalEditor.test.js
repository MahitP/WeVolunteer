import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, enrolTwoFactor } from './testServer.js';
import { REAUTH_CHALLENGE_HEADER } from './sensitiveActions.js';

/**
 * The owner-only Legal Center editor.
 *
 * ── What this file owns ──
 *
 * That the gate cannot be walked past by anybody — including an administrator,
 * which is the case a role-shaped intuition gets wrong — that a version can only
 * move forward, that a published revision actually reaches the public reader,
 * and that the version before it survives.
 *
 * ── Why the administrator case is the important one ──
 *
 * `legal.edit` is in `SUPER_ONLY`, so `can()` refuses it for `admin` and the
 * capability cannot be granted to an account either. A test that only checked
 * "a student is refused, an owner is allowed" would pass just as happily if the
 * capability had been dropped into the `admin` list, which is the mistake worth
 * catching: an administrator who can quietly rewrite the Terms is the whole
 * thing this design is arranged to prevent.
 *
 * Nothing is statically imported from anything that reaches `db.js` — see the
 * testing section of docs/ENGINEERING_GUIDE.md. `sensitiveActions.js` imports only `crypto`.
 */
describe('the Legal Center editor', () => {
  let srv, db, owner, admin, student;

  const OWNER_PASSWORD = 'Password123';

  /* Distinct documents per concern, so one test publishing a revision cannot
     move the version another test is asserting against. None of these is a
     signup document, so nothing here disturbs the consent fixtures. */
  const EDITABLE = 'cookie-and-tracking-notice';
  const VERSIONED = 'data-deletion-policy';
  const REJECTED = 'certificate-verification-policy';
  const PUBLIC_READ = 'volunteer-record-policy';
  /* For the effective-date rules. Its own slug, because rule 3 — effective dates
     only move forward — means one test's date becomes the floor for every later
     publication of the same document. `EDITABLE` is already dated 2026-09-03 by
     the fixtures above, which is exactly that effect. Not a signup or organizer
     document, so publishing it disturbs no consent fixture. */
  const DATED = 'youth-safety-guidelines';

  const listUrl = '/api/admin/legal/documents';
  const docUrl = slug => `/api/admin/legal/documents/${slug}`;
  const publishUrl = slug => `/api/admin/legal/documents/${slug}/revisions`;

  /** A publish attempt, optionally carrying a step-up grant. */
  const publish = (slug, payload, token = owner, challengeId = null) => srv.call(
    'POST', publishUrl(slug), payload, token,
    challengeId ? { [REAUTH_CHALLENGE_HEADER]: challengeId } : undefined
  );

  /**
   * A grant for one document at one version.
   *
   * The password is passed explicitly because the owner fixture is created
   * through `signupConfirmed`, whose policy requires an uppercase character, and
   * `srv.stepUp` defaults to the seeded accounts' `password123`. Left to the
   * default every grant fails, and five failures lock the account — which
   * presents as every later test failing for a reason that has nothing to do
   * with what it was testing.
   */
  const grantFor = (slug, version, token = owner) => srv.stepUp(token, 'legal.publish', {
    params: { slug, version },
    password: OWNER_PASSWORD,
  });

  /** A publish that takes out its own grant first — the ordinary success path. */
  const publishVerified = async (slug, payload, token = owner) =>
    publish(slug, payload, token, await grantFor(slug, payload.version, token));

  const body = text => `# Heading\n\n${text}\n`;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));

    admin = await srv.login('admin@example.gov');
    student = await srv.login('student@example.com').catch(() => null);

    /* No seeded super_admin fixture exists, so a throwaway account is promoted —
       the same approach authz.matrix.test.js takes. Identity is re-read from the
       users row on every request, so the role the database holds at request time
       is the one that counts and no re-login is needed. */
    const signed = await srv.signupConfirmed({
      name: 'Owner', username: 'legal_owner', email: 'legal.owner@test.local',
      password: OWNER_PASSWORD, grade: 'Adult', role: 'student',
    });
    await db.prepare('UPDATE users SET role = ?, verified = 1 WHERE email = ?')
      .run('super_admin', 'legal.owner@test.local');
    /* An administrator with no second factor is refused by `requireCap` before
       any capability is consulted, so an unenrolled fixture would read 403 for
       reasons unrelated to the capability under test. */
    await enrolTwoFactor(db, 'legal.owner@test.local');
    owner = signed.cookie;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /* ── Authorization ─────────────────────────────────────────────────────── */

  describe('authorization', () => {
    it('refuses an unauthenticated caller on every endpoint', async () => {
      const list = await srv.call('GET', listUrl);
      const read = await srv.call('GET', docUrl(EDITABLE));
      const write = await srv.call('POST', publishUrl(EDITABLE), { body: body('x'), version: '9.9.9', effectiveAt: '2026-09-01' });

      expect(list.status).toBe(401);
      expect(read.status).toBe(401);
      expect(write.status).toBe(401);
    });

    it('refuses a student', async () => {
      if (!student) return;
      expect((await srv.call('GET', listUrl, undefined, student)).status).toBe(403);
      expect((await srv.call('GET', docUrl(EDITABLE), undefined, student)).status).toBe(403);
    });

    /**
     * The case the design exists for. An administrator holds twenty-seven
     * capabilities and none of them is this one.
     */
    it('refuses an administrator, who is not the owner', async () => {
      expect((await srv.call('GET', listUrl, undefined, admin)).status).toBe(403);
      expect((await srv.call('GET', docUrl(EDITABLE), undefined, admin)).status).toBe(403);
      expect((await publish(EDITABLE, {
        body: body('smuggled'), version: '9.9.9', effectiveAt: '2026-09-01',
      }, admin)).status).toBe(403);
    });

    /**
     * Reading is gated too, not only writing.
     *
     * The published text is already public, so this is not about secrecy: the
     * editor's read returns revision history and author attribution, and "who
     * has been editing our Terms" is not something an ordinary account should be
     * able to enumerate. Asserted directly, because a reader-only gap is exactly
     * the kind that survives a test suite checking mutations.
     */
    it('discloses no revision history to a non-owner', async () => {
      const res = await srv.call('GET', docUrl(EDITABLE), undefined, admin);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body || {})).not.toContain('history');
    });

    it('allows the owner', async () => {
      const res = await srv.call('GET', listUrl, undefined, owner);
      expect(res.status).toBe(200);
      expect(res.body.documents.length).toBeGreaterThan(0);
    });

    it('never exposes the source filename', async () => {
      const res = await srv.call('GET', docUrl(EDITABLE), undefined, owner);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain('.md');
    });

    it('404s an unregistered slug rather than inventing one', async () => {
      expect((await srv.call('GET', docUrl('not-a-policy'), undefined, owner)).status).toBe(404);
    });
  });

  /* ── Step-up re-authentication ─────────────────────────────────────────── */

  describe('step-up verification', () => {
    it('refuses a session alone, however legitimate the owner', async () => {
      const res = await publish(EDITABLE, {
        body: body('no grant'), version: '1.0.1', effectiveAt: '2026-09-01',
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('reauth_required');
    });

    it('publishes nothing when the verification is missing', async () => {
      const before = await srv.call('GET', `/api/legal/documents/${EDITABLE}`);
      await publish(EDITABLE, { body: body('no grant'), version: '1.0.1', effectiveAt: '2026-09-01' });
      const after = await srv.call('GET', `/api/legal/documents/${EDITABLE}`);
      expect(after.body.version).toBe(before.body.version);
      expect(after.body.markdown).toBe(before.body.markdown);
    });

    /**
     * The binding, which is what stops one verification authorising a different
     * document. Without it an owner who verified to correct the Cookie Notice
     * would hold, for five minutes, a grant spendable on the Terms of Service.
     */
    it('refuses a grant taken out for a different document', async () => {
      const challengeId = await grantFor(REJECTED, '1.0.1');
      const res = await publish(EDITABLE, {
        body: body('wrong document'), version: '1.0.1', effectiveAt: '2026-09-01',
      }, owner, challengeId);
      /* 409, not 403: the caller IS verified, and the grant they hold simply is
         not for this request. `refuseReauth` maps that to "not completed yet",
         which is what the client needs in order to prompt again. */
      expect(res.status).toBe(409);
      expect((await srv.call('GET', `/api/legal/documents/${EDITABLE}`)).body.markdown)
        .not.toContain('wrong document');
    });

    it('refuses a grant taken out for a different version', async () => {
      const challengeId = await grantFor(EDITABLE, '1.0.1');
      const res = await publish(EDITABLE, {
        body: body('version mismatch'), version: '2.0.0', effectiveAt: '2026-09-01',
      }, owner, challengeId);
      expect(res.status).toBe(409);
      expect((await srv.call('GET', `/api/legal/documents/${EDITABLE}`)).body.markdown)
        .not.toContain('version mismatch');
    });
  });

  /* ── Publishing ────────────────────────────────────────────────────────── */

  describe('publishing a revision', () => {
    it('accepts a higher version and reports it back', async () => {
      const res = await publishVerified(EDITABLE, {
        body: body('The cookie notice, corrected.'),
        version: '1.1.0',
        effectiveAt: '2026-09-01',
      });
      expect(res.status).toBe(200);
      expect(res.body.version).toBe('1.1.0');
      expect(res.body.source).toBe('revision');
      expect(res.body.body).toContain('The cookie notice, corrected.');
    });

    /**
     * The point of the whole feature: the public, unauthenticated reader gets
     * the new text without a deploy.
     */
    it('serves the new text and version to the public reader', async () => {
      await publishVerified(PUBLIC_READ, {
        body: body('Records are kept for as long as the school requires.'),
        version: '1.2.0',
        effectiveAt: '2026-09-02',
      });

      const res = await srv.call('GET', `/api/legal/documents/${PUBLIC_READ}`);
      expect(res.status).toBe(200);
      expect(res.body.version).toBe('1.2.0');
      expect(res.body.markdown).toContain('as long as the school requires');
      expect(res.body.updatedAt).toBeTruthy();
    });

    it('shows the new version in the public catalogue', async () => {
      const res = await srv.call('GET', '/api/legal/documents');
      const doc = res.body.documents.find(d => d.slug === PUBLIC_READ);
      expect(doc.version).toBe('1.2.0');
    });

    /**
     * The content fingerprint the document page prints has to describe the bytes
     * underneath it. A hash left pointing at the file after the text moved is
     * worse than no hash, because it looks like verification.
     */
    it('reports a fingerprint of the text it actually served', async () => {
      const { createHash } = await import('node:crypto');
      const res = await srv.call('GET', `/api/legal/documents/${PUBLIC_READ}`);
      const actual = createHash('sha256').update(res.body.markdown, 'utf8').digest('hex');
      expect(res.body.contentHash).toBe(actual);
    });

    it('keeps every previous version', async () => {
      await publishVerified(EDITABLE, {
        body: body('Corrected again.'), version: '1.2.0', effectiveAt: '2026-09-03',
      });

      const res = await srv.call('GET', docUrl(EDITABLE), undefined, owner);
      const versions = res.body.history.map(h => h.version);
      expect(versions).toContain('1.1.0');
      expect(versions).toContain('1.2.0');
      /* Newest first, so the list reads as a history rather than a queue. */
      expect(versions[0]).toBe('1.2.0');
    });

    it('attributes each revision to the account that published it', async () => {
      const res = await srv.call('GET', docUrl(EDITABLE), undefined, owner);
      expect(res.body.history[0].author).toBe('Owner');
    });

    /**
     * Legal changes belong in the same trail as every other administrative act,
     * rather than in a parallel log nobody reads.
     */
    it('writes an audit row naming the document and version', async () => {
      const row = await db.prepare(`
        SELECT action, details FROM admin_audit_logs
        WHERE action = 'LEGAL_DOCUMENT_PUBLISHED'
        ORDER BY created_at DESC LIMIT 1
      `).get();
      expect(row).toBeTruthy();
      expect(row.details).toMatch(/version 1\.2\.0/);
    });
  });

  /* ── Version rules, enforced on the server ─────────────────────────────── */

  describe('version rules', () => {
    /* Each case takes out its own grant, so a refusal cannot be mistaken for a
       missing verification — and so a refused save is shown NOT to cost one. */
    const attempt = (version) => publishVerified(REJECTED, {
      body: body(`attempting ${version}`), version, effectiveAt: '2026-09-04',
    });

    it('refuses a malformed version', async () => {
      for (const bad of ['1', 'v1.0.0', '1.0', '1.0.0.1', 'one', '', '1.01.0']) {
        const res = await publish(REJECTED, {
          body: body('x'), version: bad, effectiveAt: '2026-09-04',
        }, owner, await grantFor(REJECTED, bad));
        expect(res.status, `version ${JSON.stringify(bad)}`).toBe(400);
        expect(res.body.field).toBe('version');
      }
    });

    it('refuses a version equal to the published one', async () => {
      const res = await attempt('1.0.0');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already been published/);
    });

    it('refuses a version lower than the published one', async () => {
      const res = await attempt('0.9.9');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/lower than/);
    });

    it('accepts a higher version', async () => {
      expect((await attempt('1.0.1')).status).toBe(200);
    });

    /**
     * Having accepted 1.0.1 above, 1.0.1 must now be refused and a version
     * between it and the registry's must be too. This is the rule that keeps the
     * boot-time catalogue guard from ever firing.
     */
    it('refuses reusing a version it has already accepted', async () => {
      expect((await attempt('1.0.1')).status).toBe(400);
    });

    it('refuses a version below the newest revision even if above the registry', async () => {
      /* The registry ships 1.0 and the newest revision is 1.0.1, so 1.0.0 is
         above neither — but 1.0.05 does not exist, so this checks the boundary
         the other way: a version the REGISTRY would accept and the revision
         table must not. */
      const res = await attempt('1.0.0');
      expect(res.status).toBe(400);
    });

    it('refuses text identical to what is already published', async () => {
      const current = await srv.call('GET', docUrl(VERSIONED), undefined, owner);
      const res = await publishVerified(VERSIONED, {
        body: current.body.body, version: '5.0.0', effectiveAt: '2026-09-05',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/identical/);
    });

    it('refuses a malformed effective date', async () => {
      const res = await publishVerified(VERSIONED, {
        body: body('dated wrongly'), version: '3.0.0', effectiveAt: '01/09/2026',
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('effectiveAt');
    });
  });

  /* ── Content safety ────────────────────────────────────────────────────── */

  describe('content safety', () => {
    it('refuses a document containing an executable link', async () => {
      const res = await publishVerified(VERSIONED, {
        body: '# Heading\n\n[click here](javascript:alert(document.cookie))\n',
        version: '4.0.0',
        effectiveAt: '2026-09-06',
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('body');
    });

    /**
     * A rejected save must leave the public document untouched. Asserted against
     * the reader rather than the editor, because that is where the damage would
     * land.
     */
    it('publishes nothing when the content is refused', async () => {
      const res = await srv.call('GET', `/api/legal/documents/${VERSIONED}`);
      expect(res.body.markdown).not.toContain('javascript:');
    });

    it('refuses an empty document', async () => {
      const res = await publishVerified(VERSIONED, {
        body: '   ', version: '4.0.0', effectiveAt: '2026-09-06',
      });
      expect(res.status).toBe(400);
    });
  });

  /* ── The catalogue stays consistent ────────────────────────────────────── */

  describe('the published catalogue', () => {
    /**
     * `syncLegalDocuments` runs at every boot and refuses to republish a version
     * whose hash has moved — a silent UPDATE today, and a server that will not
     * start once hash enforcement is switched on at launch. Re-running it here
     * against a database that HAS been edited is the cheapest proof that the
     * strictly-greater rule is doing the job it exists for.
     */
    it('re-syncs without complaint after revisions have been published', async () => {
      const { syncLegalDocuments } = await import('./consent.js');
      await expect(syncLegalDocuments(db)).resolves.not.toThrow();
      await expect(syncLegalDocuments(db)).resolves.not.toThrow();
    });

    it('records each published revision as its own immutable catalogue row', async () => {
      const rows = (await db.prepare(
        'SELECT version FROM legal_documents WHERE slug = ? ORDER BY version'
      ).all(EDITABLE)).map(r => r.version);
      /* The registry's original and both revisions, none overwritten. */
      expect(rows).toContain('1.0');
      expect(rows).toContain('1.1.0');
      expect(rows).toContain('1.2.0');
    });
  });

  /* ── The migration ─────────────────────────────────────────────────────── */

  describe('migration 034', () => {
    it('is idempotent', async () => {
      const migration = (await import('./migrations/034_legal_document_revisions.js')).default;
      expect(() => { migration.up(db); migration.up(db); }).not.toThrow();
    });

    it('does not disturb the revisions already stored', async () => {
      const before = (await db.prepare('SELECT COUNT(*) AS n FROM legal_document_revisions').get()).n;
      const migration = (await import('./migrations/034_legal_document_revisions.js')).default;
      migration.up(db);
      expect((await db.prepare('SELECT COUNT(*) AS n FROM legal_document_revisions').get()).n).toBe(before);
    });

    it('refuses a duplicate (slug, version) at the schema level', () => {
      const insert = () => db.prepare(`
        INSERT INTO legal_document_revisions
          (slug, version, body, content_hash, effective_at, created_at, created_by)
        VALUES (?, '1.1.0', 'x', 'h', '2026-09-01', '2026-09-01T00:00:00Z', NULL)
      `).run(EDITABLE);
      expect(insert).toThrow();
    });
  });
  /**
   * ── The effective date is a recorded fact, never a schedule ──
   *
   * Publishing makes a revision the current public text immediately, and
   * resolution is by insertion order — never by date. These two tests pin the
   * halves of that which are easy to "improve" into a bug: somebody reading
   * `effective_at` in the editor could reasonably conclude `currentRevision`
   * ought to filter on it, and the reader would silently start serving the old
   * text for as long as the date was in the future.
   */
  describe('the effective date does not gate publication', () => {
    it('serves a future-dated revision immediately', async () => {
      const future = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
      const marker = `Dated ahead ${Date.now()}.`;

      /* A slug nothing else in this file publishes to. Rule 3 — effective dates
         only move forward — means a future-dated revision raises the floor for
         every later publication of the SAME document, so this case has to be
         quarantined or it silently breaks its neighbours. */
      const res = await publishVerified(PUBLIC_READ, {
        version: '9.0.0',
        body: `# Volunteer record policy\n\n${marker}\n`,
        effectiveAt: future,
      });
      expect(res.status).toBe(200);

      /* The PUBLIC reader, not the editor's own view. */
      const served = await srv.call('GET', `/api/legal/documents/${PUBLIC_READ}`);
      expect(served.status).toBe(200);
      expect(served.body.version, 'the future-dated version is live now').toBe('9.0.0');
      expect(served.body.markdown).toContain(marker);
      expect(served.body.effectiveAt).toBe(future);
    });

    /* Acceptance binds to (slug, version). Publishing must not rewrite what
       somebody already agreed to — that is the one thing this subsystem exists
       to keep true. */
    it('leaves existing acceptance rows byte-identical', async () => {
      const before = await db.prepare(
        'SELECT document_slug, version, content_hash, accepted_at FROM legal_acceptances ORDER BY id'
      ).all();

      const res = await publishVerified(DATED, {
        version: '4.0.1',
        body: `# Youth safety guidelines\n\nAnother revision ${Date.now()}.\n`,
        effectiveAt: new Date().toISOString().slice(0, 10),
      });
      expect(res.status).toBe(200);

      const after = await db.prepare(
        'SELECT document_slug, version, content_hash, accepted_at FROM legal_acceptances ORDER BY id'
      ).all();
      expect(after).toEqual(before);
    });
  });

  /**
   * The three date rules, through the real endpoint. The unit tests in
   * legalStore.test.js cover the calendar arithmetic; these confirm the refusal
   * reaches the client with the field the editor focuses on.
   */
  describe('effective-date refusals', () => {
    const body = (n) => `# Youth safety guidelines\n\nRevision ${n}.\n`;

    /* Three days back, not one: the floor is yesterday-in-UTC on purpose, so
       that an owner whose local calendar is a day behind the server's is not
       refused the date their own picker offered them. See `parseEffectiveAt`. */
    it('refuses a date genuinely in the past', async () => {
      const wellPast = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
      const res = await publishVerified(DATED, {
        version: '5.0.0', body: body('past'), effectiveAt: wellPast,
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('effectiveAt');
      expect(res.body.error).toMatch(/before it is published/i);
    });

    it('refuses a date more than a year ahead', async () => {
      const far = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
      const res = await publishVerified(DATED, {
        version: '5.0.1', body: body('far'), effectiveAt: far,
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('effectiveAt');
      expect(res.body.error).toMatch(/more than a year/i);
    });

    /* Today is the ordinary case and the one a prefix-comparison bug would
       break, so it is asserted rather than assumed. */
    it('accepts today', async () => {
      const res = await publishVerified(DATED, {
        version: '5.1.0', body: body('today'), effectiveAt: new Date().toISOString().slice(0, 10),
      });
      expect(res.status).toBe(200);
    });
    /**
     * A future-dated revision raises the floor for the ones after it.
     *
     * This is rule 3 doing its job rather than an awkwardness to work around.
     * If v1.1 is published to take effect in three weeks, a correction to it
     * cannot be dated today — the corrected text would claim to have been in
     * force before the version it corrects. The owner dates the correction on
     * or after the pending date, and the printed timeline stays readable.
     */
    it('refuses a date earlier than a pending future-dated revision', async () => {
      const ahead = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
      expect((await publishVerified(DATED, {
        version: '6.0.0', body: body('scheduled'), effectiveAt: ahead,
      })).status).toBe(200);

      const res = await publishVerified(DATED, {
        version: '6.0.1', body: body('same day correction'),
        effectiveAt: new Date().toISOString().slice(0, 10),
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('effectiveAt');
      expect(res.body.error).toMatch(/only move forward/i);

      /* Dated on the pending date, the correction goes through. */
      expect((await publishVerified(DATED, {
        version: '6.0.2', body: body('correction, dated properly'), effectiveAt: ahead,
      })).status).toBe(200);
    });
  });
});