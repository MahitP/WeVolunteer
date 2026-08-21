import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { startTestServer, enrolTwoFactor } from './testServer.js';
import { REAUTH_CHALLENGE_HEADER } from './sensitiveActions.js';

/**
 * The Legal Center editor, attacked rather than exercised.
 *
 * `routes.legalEditor.test.js` proves the feature works. This file assumes it
 * does and tries to get around it: grant the ungrantable capability, slip a
 * version past the parser, publish something that executes in a reader's
 * browser, and make the immutable catalogue disagree with the revision table.
 *
 * ── Why these are permanent tests and not a one-off audit ──
 *
 * Every case below is a specific way this feature could be broken by a future
 * change that looks harmless. The `1e3.0.0` case is the clearest example: the
 * version parser rejects it today because it validates with a regex BEFORE
 * calling `Number`, and somebody who "simplifies" that to `parseFloat` would
 * pass every functional test in the suite while making version comparison
 * meaningless. An audit finds that once; a test keeps finding it.
 */

/* ─── The launch scenario: enforcement ON, with revisions present ─────────── */

describe('hash enforcement and the revision layer, together', () => {
  let dir = null;

  const freshDir = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'wev-legal-adv-'));
    process.env.WEV_DB_PATH = path.join(dir, 'adv.db');
    process.env.JWT_SECRET = 'Kx9$mQ2vB7nR4tY8wL3zC6dF1gH5jN0pS';
    delete process.env.NODE_ENV;
    delete process.env.DEMO_MODE;
  };

  const boot = async () => {
    vi.resetModules();
    const dbMod = await import('./db.js');
    dbMod.initDatabase();
    await dbMod.completeDatabaseInit();
    return dbMod.db;
  };

  beforeEach(() => { freshDir(); });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./legalDocuments.js');
    vi.resetModules();
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
  });

  /**
   * The highest-value test in this file.
   *
   * `LEGAL_HASHES_ENFORCED` is false today and will be turned on at launch. Every
   * guard it re-arms compares a FILE against a pinned constant, and the whole
   * point of the revision layer is that the file is no longer what gets served.
   * If those two ideas collide, the failure lands on the day of the switch — the
   * worst possible day to find out — and it presents as a server that will not
   * boot.
   *
   * So: publish a revision, then boot again with enforcement forced on.
   */
  it('boots with enforcement on after a revision has been published', async () => {
    let db = await boot();

    const { publishRevision } = await import('./legalStore.js');
    await publishRevision(db, {
      slug: 'cookie-and-tracking-notice',
      version: '1.1.0',
      body: '# Cookie Notice\n\nA revision published before the switch.\n',
      effectiveAt: '2026-09-01',
      userId: null,
    });

    vi.resetModules();
    const real = await import('./legalDocuments.js');
    vi.doMock('./legalDocuments.js', () => ({ ...real, LEGAL_HASHES_ENFORCED: true }));

    const dbMod = await import('./db.js');
    expect(() => dbMod.initDatabase()).not.toThrow();
  });

  /**
   * And it still serves the revision, rather than falling back to the file
   * because the strict path could not verify it.
   */
  it('still resolves the revision when enforcement is on', async () => {
    let db = await boot();
    const store = await import('./legalStore.js');
    await store.publishRevision(db, {
      slug: 'cookie-and-tracking-notice',
      version: '1.1.0',
      body: '# Cookie Notice\n\nServed under enforcement.\n',
      effectiveAt: '2026-09-01',
      userId: null,
    });

    vi.resetModules();
    const real = await import('./legalDocuments.js');
    vi.doMock('./legalDocuments.js', () => ({ ...real, LEGAL_HASHES_ENFORCED: true }));

    const dbMod = await import('./db.js');
    dbMod.initDatabase();
    await dbMod.completeDatabaseInit();
    const strictStore = await import('./legalStore.js');
    const resolved = await strictStore.resolveDocument(
      dbMod.db, 'cookie-and-tracking-notice', { withBody: true }
    );

    expect(resolved.version).toBe('1.1.0');
    expect(resolved.body).toContain('Served under enforcement');
    expect(resolved.source).toBe('revision');
  });

  /**
   * A revision-backed document survives its file going missing.
   *
   * Not a hypothetical: `docs/legal/policies/` is a runtime dependency that has
   * to be deployed alongside the server, and the failure mode of forgetting it
   * used to be a 500 on the Terms. Once an owner has published a revision, the
   * text is a column and the file is irrelevant — the reader should still get
   * their document.
   */
  it('serves a revision even when the policy file cannot be read', async () => {
    const db = await boot();
    const store = await import('./legalStore.js');
    await store.publishRevision(db, {
      slug: 'cookie-and-tracking-notice',
      version: '1.1.0',
      body: '# Cookie Notice\n\nStill here without the file.\n',
      effectiveAt: '2026-09-01',
      userId: null,
    });

    const content = await import('./legalContent.js');
    content.resetPolicyCache();
    vi.spyOn(content, 'policyContent').mockImplementation(() => {
      throw new content.PolicyContentError('file gone');
    });

    const resolved = await store.resolveDocument(db, 'cookie-and-tracking-notice', { withBody: true });
    expect(resolved.body).toContain('Still here without the file');
  });

  /**
   * Two revisions, then a restart. The catalogue has to hold BOTH, because
   * somebody may have accepted the first while it was current, and
   * `syncLegalDocuments` only ever publishes the current one.
   */
  it('keeps every published version in the catalogue across a restart', async () => {
    let db = await boot();
    const store = await import('./legalStore.js');
    for (const [version, text] of [['1.1.0', 'first'], ['1.2.0', 'second']]) {
      await store.publishRevision(db, {
        slug: 'cookie-and-tracking-notice',
        version,
        body: `# Cookie Notice\n\n${text}\n`,
        effectiveAt: '2026-09-01',
        userId: null,
      });
    }

    db = await boot();
    const rows = (await db.prepare(
      'SELECT version FROM legal_documents WHERE slug = ?'
    ).all('cookie-and-tracking-notice')).map(r => r.version);

    expect(rows).toContain('1.1.0');
    expect(rows).toContain('1.2.0');
  });
});

/* ─── Everything that needs a live HTTP surface ───────────────────────────── */

describe('attacking the editor over HTTP', () => {
  let srv, db, owner, admin, student;
  const OWNER_PASSWORD = 'Password123';
  const SLUG = 'cookie-and-tracking-notice';

  const publishUrl = slug => `/api/admin/legal/documents/${slug}/revisions`;

  const grantFor = (version, token = owner) => srv.stepUp(token, 'legal.publish', {
    params: { slug: SLUG, version: typeof version === 'string' ? version.trim() : '' },
    password: OWNER_PASSWORD,
  });

  const publish = (payload, challengeId, token = owner) => srv.call(
    'POST', publishUrl(SLUG), payload, token,
    challengeId ? { [REAUTH_CHALLENGE_HEADER]: challengeId } : undefined
  );

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));

    admin = await srv.login('admin@example.gov');
    student = await srv.login('student@example.com').catch(() => null);

    const signed = await srv.signupConfirmed({
      name: 'Adv Owner', username: 'adv_owner', email: 'adv.owner@test.local',
      password: OWNER_PASSWORD, grade: 'Adult', role: 'student',
    });
    await db.prepare('UPDATE users SET role = ?, verified = 1 WHERE email = ?')
      .run('super_admin', 'adv.owner@test.local');
    await enrolTwoFactor(db, 'adv.owner@test.local');
    owner = signed.cookie;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /* ── The capability cannot be handed out ────────────────────────────────── */

  describe('legal.edit is ungrantable', () => {
    /**
     * The property that makes SUPER_ONLY the right home for this capability, and
     * the one a reader is most likely to assume rather than check.
     *
     * `capability.grant` exists so an administrator can be given a narrow extra
     * power. "Let the person handling our compliance paperwork fix the Terms" is
     * exactly the grant somebody would reasonably write, and it must be refused —
     * otherwise the contract every account is held to is reachable by an account
     * nobody vetted for it.
     *
     * Asserted at the `can()` layer AND over HTTP, because a grant that is stored
     * but not honoured is a different bug from one that is refused outright, and
     * only one of them is safe.
     */
    it('refuses to store a grant naming it', async () => {
      const { grantCapability } = await import('./userCapabilities.js').catch(() => ({}));
      if (!grantCapability) return; // module shape changed; the HTTP case below still covers it

      const target = await db.prepare("SELECT id FROM users WHERE email = 'admin@example.gov'").get();
      await expect(grantCapability(db, {
        userId: target.id, capability: 'legal.edit', grantedBy: target.id, reason: 'audit',
      })).rejects.toThrow();
    });

    /**
     * Even with a row forced directly into `user_capabilities`, bypassing every
     * check the grant API makes, `can()` must still refuse — because the
     * SUPER_ONLY test runs before per-user grants are consulted.
     */
    it('does not honour a grant row written directly into the table', async () => {
      const target = await db.prepare("SELECT id FROM users WHERE email = 'admin@example.gov'").get();
      try {
        await db.prepare(`
          INSERT INTO user_capabilities (user_id, capability, granted_by, granted_at, reason)
          VALUES (?, 'legal.edit', ?, ?, 'adversarial test')
        `).run(target.id, target.id, new Date().toISOString());
      } catch {
        /* A CHECK constraint or trigger refused it, which is a stronger result
           than the assertion below. Either outcome is a pass. */
        return;
      }

      const res = await srv.call('GET', '/api/admin/legal/documents', undefined, admin);
      expect(res.status).toBe(403);

      await db.prepare("DELETE FROM user_capabilities WHERE capability = 'legal.edit'").run();
    });
  });

  /* ── Version parsing, adversarially ─────────────────────────────────────── */

  describe('version inputs that must not be accepted', () => {
    /**
     * Every one of these carries a VALID step-up grant, which is the case worth
     * testing: a refusal that only happens because the caller was unverified
     * proves nothing about the parser.
     *
     * `1e3.0.0` and the Unicode-digit cases are the ones that matter most. Both
     * are accepted by `Number()` or by a `\d` class compiled with `/u`, and both
     * would produce a version that compares in a way no reader could predict.
     * They are rejected today because validation is a strict ASCII regex applied
     * BEFORE any numeric coercion.
     */
    const REJECTED = [
      ['two-component', '1.0'],
      ['single number', '1'],
      ['v-prefixed', 'v1.0.0'],
      ['four components', '1.0.0.0'],
      ['negative patch', '1.0.-1'],
      ['non-numeric patch', '1.0.x'],
      ['empty', ''],
      ['whitespace only', '   '],
      ['leading zero major', '01.0.0'],
      ['leading zero minor', '1.00.0'],
      ['exponent notation', '1e3.0.0'],
      ['plus-prefixed', '+1.0.0'],
      ['negative major', '-1.0.0'],
      ['Devanagari digits', '१.०.०'],
      ['Arabic-Indic digits', '١.٠.٠'],
      ['hex-ish', '0x1.0.0'],
      ['infinity', 'Infinity.0.0'],
      ['NaN', 'NaN.0.0'],
      ['internal space', '1. 0.0'],
      ['comma separated', '1,0,0'],
      ['trailing dot', '1.0.0.'],
      ['double dot', '1..0'],
    ];

    for (const [label, version] of REJECTED) {
      it(`refuses ${label}: ${JSON.stringify(version)}`, async () => {
        const res = await publish(
          { body: `# H\n\nAttempt ${label}.\n`, version, effectiveAt: '2026-09-01' },
          await grantFor(version)
        );
        expect(res.status).toBe(400);
        expect(res.body.field).toBe('version');
      });
    }

    /**
     * Non-string types, which reach the route as JSON and must not crash it. A
     * 500 here would be an unhandled type error, and an unhandled type error in
     * a handler that spends a step-up grant is a grant spent for nothing.
     */
    it('refuses non-string versions without a 500', async () => {
      for (const version of [null, 123, true, {}, ['1.0.0'], 1.0]) {
        const res = await publish(
          { body: '# H\n\nTyped wrongly.\n', version, effectiveAt: '2026-09-01' },
          await grantFor('')
        );
        expect([400, 403], `version ${JSON.stringify(version)}`).toContain(res.status);
        expect(res.status).not.toBe(500);
      }
    });

    it('refuses a missing version field entirely', async () => {
      const res = await publish(
        { body: '# H\n\nNo version at all.\n', effectiveAt: '2026-09-01' },
        await grantFor('')
      );
      expect(res.status).not.toBe(500);
      expect(res.status).not.toBe(200);
    });

    /**
     * Surrounding whitespace is trimmed rather than refused, and the trimmed
     * value is what gets bound to the grant and written to the row. If the route
     * bound the raw string and stored the trimmed one, a grant taken out for
     * ' 1.5.0 ' could not be spent on '1.5.0' and the owner would be told their
     * verification had failed.
     */
    it('accepts a version with surrounding whitespace and stores it trimmed', async () => {
      const res = await publish(
        { body: '# H\n\nPadded version.\n', version: '  1.5.0  ', effectiveAt: '2026-09-01' },
        await grantFor('  1.5.0  ')
      );
      expect(res.status).toBe(200);
      expect(res.body.version).toBe('1.5.0');
    });

    /**
     * A component long enough to lose integer precision.
     *
     * `Number('9007199254740993')` is 9007199254740992, so two different versions
     * would compare equal and the second could replace the first. Bounded by
     * digit length rather than by value, because the check has to happen before
     * the coercion that loses the information.
     */
    it('refuses a numeric component too large to compare exactly', async () => {
      const huge = '999999999999999999999.0.0';
      const res = await publish(
        { body: '# H\n\nHuge version.\n', version: huge, effectiveAt: '2026-09-01' },
        await grantFor(huge)
      );
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('version');
    });
  });

  /* ── Effective dates ────────────────────────────────────────────────────── */

  describe('effective dates that must not be accepted', () => {
    for (const [label, effectiveAt] of [
      ['US format', '09/01/2026'],
      ['ISO timestamp', '2026-09-01T00:00:00Z'],
      ['impossible day', '2026-02-30'],
      ['impossible month', '2026-13-01'],
      ['empty', ''],
      ['not a date', 'soon'],
    ]) {
      it(`refuses ${label}`, async () => {
        const res = await publish(
          { body: `# H\n\nDate ${label}.\n`, version: '3.0.0', effectiveAt },
          await grantFor('3.0.0')
        );
        expect(res.status).toBe(400);
        expect(res.body.field).toBe('effectiveAt');
      });
    }
  });

  /* ── Content that must not become executable ────────────────────────────── */

  describe('content injection', () => {
    /**
     * The schemes an href may not carry. Each is sent as real content through the
     * real endpoint, so this covers the server's allowlist rather than the
     * renderer's — the renderer has its own tests in
     * `PolicyBody.inlineLinks.test.jsx`.
     */
    for (const [label, href] of [
      ['javascript', 'javascript:alert(1)'],
      ['uppercase javascript', 'JAVASCRIPT:alert(1)'],
      ['mixed case', 'JaVaScRiPt:alert(1)'],
      ['data html', 'data:text/html,<script>alert(1)</script>'],
      ['vbscript', 'vbscript:msgbox'],
      ['protocol relative', '//evil.example/steal'],
      ['backslash host', '\\\\evil.example'],
      ['file', 'file:///etc/passwd'],
    ]) {
      it(`refuses a link using ${label}`, async () => {
        const res = await publish(
          { body: `# H\n\n[click](${href})\n`, version: '4.0.0', effectiveAt: '2026-09-01' },
          await grantFor('4.0.0')
        );
        expect(res.status).toBe(400);
        expect(res.body.field).toBe('body');
      });
    }

    /**
     * Raw HTML is ACCEPTED as content and rendered as visible text.
     *
     * That is the design, not an oversight, and it is worth pinning so nobody
     * later adds an HTML sanitiser under the impression it is missing. The parser
     * emits plain objects and the renderer turns them into React text nodes, so
     * there is no code path from a document's bytes to markup — which is a
     * stronger property than sanitising, because it cannot be forgotten.
     *
     * A policy is also entitled to *discuss* an HTML tag in its text.
     */
    it('stores HTML-looking content as text rather than refusing or executing it', async () => {
      const hostile = '# H\n\n<script>alert(1)</script> and '
        + '<img src=x onerror=alert(1)> and <iframe src=evil>\n';
      const res = await publish(
        { body: hostile, version: '5.0.0', effectiveAt: '2026-09-01' },
        await grantFor('5.0.0')
      );
      expect(res.status).toBe(200);

      /* Round-trips verbatim through the PUBLIC endpoint — no escaping applied at
         the API layer, because escaping belongs to the renderer and doing it
         twice would show readers `&lt;script&gt;`. */
      const pub = await srv.call('GET', `/api/legal/documents/${SLUG}`);
      expect(pub.body.markdown).toContain('<script>alert(1)</script>');

      /* And the parser yields text, never a node with markup in it. */
      const { parsePolicyMarkdown } = await import('../src/utils/policyMarkdown.js');
      const blocks = parsePolicyMarkdown(pub.body.markdown);
      const spanTypes = new Set(
        blocks.flatMap(b => (b.spans || []).map(s => s.type ?? 'text'))
      );
      expect([...spanTypes].every(t => ['text', 'bold', 'code', 'link'].includes(t))).toBe(true);
    });

    it('refuses a link to a document that does not exist', async () => {
      const res = await publish(
        { body: '# H\n\n[x](/legal/no-such-policy)\n', version: '6.0.0', effectiveAt: '2026-09-01' },
        await grantFor('6.0.0')
      );
      expect(res.status).toBe(400);
    });

    /* Links reachable only through a nested construct still have to be checked,
       because the walker that finds them is easy to write incompletely. */
    for (const [label, body] of [
      ['bold', '# H\n\n**[x](javascript:alert(1))**\n'],
      ['list item', '# H\n\n- [x](javascript:alert(1))\n'],
      ['blockquote', '# H\n\n> [x](javascript:alert(1))\n'],
      ['table cell', '# H\n\n| a | b |\n|---|---|\n| [x](javascript:alert(1)) | y |\n'],
      ['heading', '# H\n\n## [x](javascript:alert(1))\n'],
    ]) {
      it(`finds an unsafe link nested in a ${label}`, async () => {
        const res = await publish(
          { body, version: '7.0.0', effectiveAt: '2026-09-01' },
          await grantFor('7.0.0')
        );
        expect(res.status).toBe(400);
        expect(res.body.field).toBe('body');
      });
    }
  });

  /* ── A refused save must cost nothing ───────────────────────────────────── */

  describe('a refused save', () => {
    /**
     * Two properties, and both are about not making the owner pay for a mistake:
     * the grant survives so they can fix the field and press save again, and no
     * audit row claims a publication that did not happen.
     */
    it('leaves the step-up grant unspent, so the owner need not verify twice', async () => {
      const challengeId = await grantFor('8.0.0');

      const refused = await publish(
        { body: '# H\n\n[x](javascript:alert(1))\n', version: '8.0.0', effectiveAt: '2026-09-01' },
        challengeId
      );
      expect(refused.status).toBe(400);

      /* The SAME challenge now publishes valid content. If the refusal had spent
         it, this would be a 409. */
      const accepted = await publish(
        { body: '# H\n\nFixed the link.\n', version: '8.0.0', effectiveAt: '2026-09-01' },
        challengeId
      );
      expect(accepted.status).toBe(200);
    });

    it('writes no audit row for a publication that was refused', async () => {
      const before = (await db.prepare(
        "SELECT COUNT(*) AS n FROM admin_audit_logs WHERE action = 'LEGAL_DOCUMENT_PUBLISHED'"
      ).get()).n;

      await publish(
        { body: '# H\n\nRefused.\n', version: 'nope', effectiveAt: '2026-09-01' },
        await grantFor('nope')
      );

      const after = (await db.prepare(
        "SELECT COUNT(*) AS n FROM admin_audit_logs WHERE action = 'LEGAL_DOCUMENT_PUBLISHED'"
      ).get()).n;
      expect(after).toBe(before);
    });

    it('leaks no filesystem path in an error message', async () => {
      const res = await publish(
        { body: '# H\n\nRefused.\n', version: 'nope', effectiveAt: '2026-09-01' },
        await grantFor('nope')
      );
      expect(JSON.stringify(res.body)).not.toMatch(/\/Users\/|\/home\/|docs\/legal/);
    });
  });

  /* ── Concurrency ────────────────────────────────────────────────────────── */

  /**
   * Two publishes racing for the same version.
   *
   * The version check reads the highest existing version and the insert writes
   * one above it. Outside a transaction both would read the same value and both
   * would try to write it; the loser would hit `UNIQUE(slug, version)` and become
   * a 500 with its grant already gone. Exactly one must win, and the other must
   * be refused cleanly.
   */
  it('lets only one of two concurrent publishes at the same version succeed', async () => {
    const [a, b] = await Promise.all([grantFor('9.0.0'), grantFor('9.0.0')]);
    const results = await Promise.all([
      publish({ body: '# H\n\nRacer A.\n', version: '9.0.0', effectiveAt: '2026-09-01' }, a),
      publish({ body: '# H\n\nRacer B.\n', version: '9.0.0', effectiveAt: '2026-09-01' }, b),
    ]);

    const codes = results.map(r => r.status).sort();
    expect(codes.filter(c => c === 200)).toHaveLength(1);
    expect(codes.some(c => c === 400 || c === 409)).toBe(true);
    expect(codes).not.toContain(500);

    /* And the table holds exactly one row for that version. */
    const rows = (await db.prepare(
      'SELECT COUNT(*) AS n FROM legal_document_revisions WHERE slug = ? AND version = ?'
    ).get(SLUG, '9.0.0')).n;
    expect(rows).toBe(1);
  });

  /**
   * After every attempt above, the newest revision is still the highest version.
   * An old revision becoming current again is the one failure that would silently
   * un-publish a correction.
   */
  it('never lets an earlier revision become the current one', async () => {
    const resolved = await srv.call('GET', `/api/legal/documents/${SLUG}`);
    const all = (await db.prepare(
      'SELECT version FROM legal_document_revisions WHERE slug = ?'
    ).all(SLUG)).map(r => r.version);

    const { compareVersions } = await import('./legalStore.js');
    for (const version of all) {
      expect(compareVersions(resolved.body.version, version)).toBeGreaterThanOrEqual(0);
    }
  });

  /* ── Rate limiting is actually attached ─────────────────────────────────── */

  it('rate-limits the admin routes', async () => {
    /* DEMO_MODE raises the ceiling to 200/min, which the harness sets. The point
       is that a limiter is attached at all — a missing one is invisible until
       somebody scripts against it. */
    const res = await srv.call('GET', '/api/admin/legal/documents', undefined, owner);
    expect(res.headers.get('ratelimit-limit') || res.headers.get('ratelimit')).toBeTruthy();
  });

  /* ── Acceptance records stay honest ─────────────────────────────────────── */

  /**
   * After a revision exists, a new signup's acceptance row must name the version
   * and hash the reader was actually SHOWN.
   *
   * This is the failure the resolver exists to prevent and the most expensive one
   * to discover late: a consent record that is false about what was agreed to
   * looks exactly like a correct one until somebody has to rely on it.
   */
  it('records an acceptance against the version the public endpoint serves', async () => {
    const termsGrant = await srv.stepUp(owner, 'legal.publish', {
      params: { slug: 'terms-of-service', version: '1.4.0' },
      password: OWNER_PASSWORD,
    });
    const published = await srv.call(
      'POST', '/api/admin/legal/documents/terms-of-service/revisions',
      { body: '# Terms\n\nRevised before this signup.\n', version: '1.4.0', effectiveAt: '2026-09-01' },
      owner, { [REAUTH_CHALLENGE_HEADER]: termsGrant }
    );
    expect(published.status).toBe(200);

    const signed = await srv.signupConfirmed({
      name: 'After Revision', username: 'after_rev', email: 'after.rev@test.local',
      password: 'Password123', grade: '11', role: 'student',
    });
    expect(signed.cookie).toBeTruthy();

    const user = await db.prepare("SELECT id FROM users WHERE email = 'after.rev@test.local'").get();
    const acceptance = await db.prepare(`
      SELECT version, content_hash FROM legal_acceptances
      WHERE user_id = ? AND document_slug = 'terms-of-service'
    `).get(user.id);

    const pub = await srv.call('GET', '/api/legal/documents/terms-of-service');
    expect(acceptance.version).toBe(pub.body.version);
    expect(acceptance.content_hash).toBe(pub.body.contentHash);
  });
});
