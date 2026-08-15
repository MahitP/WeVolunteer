import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startTestServer } from './testServer.js';
import { ipPrefix, uaFamily, assertConsent, ConsentMissing, slugToKey } from './consent.js';
import { LEGAL_DOCUMENTS, SIGNUP_DOCUMENTS, CONSENT_CONTROLS, hashPolicyFile, requiredConsentKeys, publishedHash, LEGAL_HASHES_ENFORCED } from './legalDocuments.js';

/**
 * Consent: recorded, enforced server-side, and pinned to document content.
 *
 * The failure this whole subsystem exists to close: `Signup.jsx` validated a
 * privacy checkbox and then `baseFields()` dropped it before the request was
 * sent. The server never saw it and nothing stored it, so the platform held no
 * evidence that any user had accepted any policy.
 *
 * The tests that matter most here are the two atomicity ones. A signup that
 * creates an account without its acceptance rows would pass every functional
 * test in this repo — the user can sign in, the profile renders, nothing errors
 * — and only surfaces when somebody asks what that person agreed to.
 */

/* ── Pure units: no server, no database ──────────────────────────────────── */

describe('ipPrefix — truncation, not collection', () => {
  it('keeps only the /24 of an IPv4 address', () => {
    expect(ipPrefix('203.0.113.42')).toBe('203.0.113.0/24');
  });

  it('unwraps IPv4-mapped IPv6 that Express hands back on a v6 socket', () => {
    expect(ipPrefix('::ffff:198.51.100.7')).toBe('198.51.100.0/24');
  });

  it('keeps only the /48 of an IPv6 address', () => {
    expect(ipPrefix('2001:db8:1234:5678::1')).toBe('2001:db8:1234::/48');
  });

  it('returns null rather than guessing at junk', () => {
    // A wrong prefix is worse than no prefix: it looks like evidence.
    for (const bad of ['', null, undefined, 'not-an-ip', '999.1', '1.2.3']) {
      expect(ipPrefix(bad)).toBeNull();
    }
  });

  it('NEVER returns a full address', () => {
    // The guarantee the privacy policy makes, asserted rather than assumed.
    for (const addr of ['203.0.113.42', '::ffff:198.51.100.7', '2001:db8:1234:5678::1']) {
      expect(ipPrefix(addr)).not.toContain(addr);
    }
  });
});

describe('uaFamily — a family string, never the raw header', () => {
  const RAW_CHROME_ANDROID =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

  it('reduces a real header to browser and OS only', () => {
    expect(uaFamily(RAW_CHROME_ANDROID)).toBe('Chrome on Android');
  });

  it('does not leak any version or device detail', () => {
    const out = uaFamily(RAW_CHROME_ANDROID);
    expect(out).not.toMatch(/537\.36|Pixel|120\.0/);
    expect(out.length).toBeLessThan(40);
  });

  it('tests specific brands before the strings they embed', () => {
    // Every Chromium browser also says "Safari"; Edge also says "Chrome". A
    // naive ordering labels everything Safari.
    expect(uaFamily('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36 Edg/120')).toBe('Edge on Windows');
    expect(uaFamily('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/120 Safari/537.36 OPR/106')).toBe('Opera on macOS');
    expect(uaFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Safari/604.1')).toBe('Safari on iOS');
    expect(uaFamily('Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0')).toBe('Firefox on Linux');
  });

  it('returns null for a missing header', () => {
    expect(uaFamily('')).toBeNull();
    expect(uaFamily(undefined)).toBeNull();
  });
});

describe('assertConsent', () => {
  const allTrue = () =>
    Object.fromEntries(requiredConsentKeys().map(k => [slugToKey(k), true]));

  it('passes when every control is true', () => {
    expect(() => assertConsent({ consent: allTrue() })).not.toThrow();
  });

  it('names every missing control, not just the first', () => {
    try {
      assertConsent({ consent: {} });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConsentMissing);
      expect(err.missing.sort()).toEqual(requiredConsentKeys().sort());
    }
  });

  it('rejects truthy-but-not-true values', () => {
    // `=== true`, not truthiness: the string "false" is truthy, and a consent
    // field arriving as a string is a client bug or a probe. Either way,
    // treating it as agreement is the wrong answer.
    for (const sneaky of ['false', 'true', 1, {}, [], 'yes']) {
      const consent = Object.fromEntries(requiredConsentKeys().map(k => [slugToKey(k), sneaky]));
      expect(() => assertConsent({ consent }), `value ${JSON.stringify(sneaky)} must not count as consent`)
        .toThrow(ConsentMissing);
    }
  });

  it('rejects a missing consent block entirely', () => {
    expect(() => assertConsent({})).toThrow(ConsentMissing);
    expect(() => assertConsent(null)).toThrow(ConsentMissing);
  });
});

describe('the document registry', () => {
  /**
   * The pinned constant is authoritative only once enforcement is on.
   *
   * The evidentiary value of an acceptance is the CONTENT it points at, so after
   * launch a published document changing without a version bump means every
   * acceptance row for that version describes text nobody agreed to — a build
   * failure, correctly.
   *
   * Before launch the documents are still being drafted and there are no
   * acceptance rows to protect, so this is skipped rather than deleted: the owner
   * decided (see LEGAL_HASHES_ENFORCED) not to pay the edit-rehash-repaste ritual
   * until it buys something. Deleting the case would mean nothing re-arms it.
   */
  it.skipIf(!LEGAL_HASHES_ENFORCED)('pins a content hash that matches the published file', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      expect(
        hashPolicyFile(doc.file),
        `${doc.slug} v${doc.version}: the published file no longer matches its pinned hash. `
        + 'If the change is intentional, bump the version in server/legalDocuments.js and '
        + 'refresh the hash with `node bin/legal-hashes.mjs`.'
      ).toBe(doc.contentHash);
    }
  });

  /**
   * What is true in BOTH modes: every pinned value is a real sha256.
   *
   * Cheap, and it catches the thing skipping the case above could otherwise let
   * through — a constant left as a placeholder, `''` or `'TODO'`, which would
   * then be pasted into `legal_documents` and quietly become the recorded hash of
   * a real published document.
   */
  it('gives every document a well-formed pinned hash', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      expect(doc.contentHash, `${doc.slug} has no usable pinned hash`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('gives every signup document a control, directly or by bundling', () => {
    /**
     * Scoped to SIGNUP_DOCUMENTS, not to "everything that is not a notice".
     *
     * Those two sets were identical until the Organizer Agreement was registered.
     * It is `consentType: 'agree'` — a real contract — but `scope: 'organizer'`,
     * so it is collected when somebody becomes an organizer and must NOT have a
     * signup control. Under the old filter this test would have demanded one,
     * and satisfying it would have put undertakings about handling other
     * students' contact details in front of every fourteen-year-old.
     */
    for (const doc of SIGNUP_DOCUMENTS) {
      const covered = CONSENT_CONTROLS.some(c => c.covers.includes(doc.slug));
      expect(covered, `${doc.slug} has no consent control and would never be presented`).toBe(true);
    }
  });

  it('keeps every consent-bearing document reachable by some scope', () => {
    // The reverse guard, and the reason narrowing the test above is safe: a
    // document that needs acceptance must be collected SOMEWHERE. A contract
    // registered with `scope: 'notice'` would be published, never accepted, and
    // silently unenforceable — which is the failure the registry exists to stop.
    for (const doc of LEGAL_DOCUMENTS.filter(d => d.consentType !== 'notice')) {
      expect(
        ['signup', 'organizer-onboarding', 'student-organizer-onboarding'].includes(doc.scope),
        `${doc.slug} needs acceptance but its scope (${doc.scope}) collects none`
      ).toBe(true);
    }
  });

  it('uses the honest verb for each document type', () => {
    // You cannot "agree" to a privacy notice — it is a disclosure, and asking a
    // fourteen-year-old to agree implies they could disagree and still sign up.
    const privacy = LEGAL_DOCUMENTS.find(d => d.slug === 'privacy-policy');
    expect(privacy.consentType).toBe('acknowledge');
    const terms = LEGAL_DOCUMENTS.find(d => d.slug === 'terms-of-service');
    expect(terms.consentType).toBe('agree');
  });
});

/* ── Integration: the signup paths ───────────────────────────────────────── */

describe('signup enforces and records consent', () => {
  let srv;
  let db;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
  });
  afterAll(async () => { await srv.close(); });

  const consentAll = () =>
    Object.fromEntries(requiredConsentKeys().map(k => [slugToKey(k), true]));

  let n = 0;
  const account = (extra = {}) => {
    n += 1;
    return {
      name: `Consent Tester ${n}`,
      email: `consent.tester.${n}@example.com`,
      username: `consenttester${n}`,
      password: 'Str0ng!Passphrase9',
      grade: '11',
      role: 'student',
      // Valid DOB: the age gate runs before the consent gate, so a suite
      // about consent must clear it or it never reaches its own subject.
      dateOfBirth: '2007-06-15',
      ...extra,
    };
  };

  it('refuses signup with no consent block at all', async () => {
    const res = await srv.call('POST', '/api/auth/signup', account());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('consent_required');
    expect(res.body.missing).toEqual(expect.arrayContaining(requiredConsentKeys()));
  });

  it('CREATES NO ACCOUNT when consent is refused', async () => {
    const payload = account();
    await srv.call('POST', '/api/auth/signup', payload);

    const row = db.prepare('SELECT id FROM users WHERE email = ?').get(payload.email);
    expect(row, 'a refused signup must not leave a half-made account behind').toBeFalsy();
  });

  it('refuses when only some controls are accepted', async () => {
    const keys = requiredConsentKeys();
    if (keys.length < 2) return; // nothing to partially accept

    const partial = { [slugToKey(keys[0])]: true };
    const res = await srv.call('POST', '/api/auth/signup', account({ consent: partial }));

    expect(res.status).toBe(400);
    expect(res.body.missing).toContain(keys[1]);
    expect(res.body.missing).not.toContain(keys[0]);
  });

  it('accepts signup with full consent and records one row per document', async () => {
    const payload = account({ consent: consentAll() });
    const res = await srv.call('POST', '/api/auth/signup', payload);
    expect(res.status).toBe(201);

    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(payload.email);
    expect(user).toBeTruthy();

    const rows = db.prepare('SELECT * FROM legal_acceptances WHERE user_id = ?').all(user.id);
    const expected = SIGNUP_DOCUMENTS;

    expect(
      rows.length,
      'one row per signup document, including the ones bundled onto another checkbox — the '
      + 'record must name every document accepted, not just the one the box was labelled with'
    ).toBe(expected.length);

    // And nothing outside that scope. A student must not leave signup holding an
    // acceptance row for the Organizer Agreement: it was never shown to them, and
    // a row claiming otherwise is a false record rather than a harmless extra.
    const outOfScope = rows.filter(r => !expected.some(d => d.slug === r.document_slug));
    expect(
      outOfScope.map(r => r.document_slug),
      'signup recorded acceptance of a document it never presented'
    ).toEqual([]);

    for (const doc of expected) {
      const row = rows.find(r => r.document_slug === doc.slug);
      expect(row, `no acceptance recorded for ${doc.slug}`).toBeTruthy();
      expect(row.version).toBe(doc.version);
      /* What was actually published — the pinned constant while enforced, the live
   file hash before launch. See publishedHash(). */
      expect(row.content_hash).toBe(publishedHash(doc));
      expect(row.method).toBe('signup');
      expect(row.context).toBe('password');
      expect(row.accepted_at).toBeTruthy();
    }
  });

  it('stores a truncated address and a UA family, never the raw values', async () => {
    const payload = account({ consent: consentAll() });
    await srv.call('POST', '/api/auth/signup', payload);

    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(payload.email);
    const row = db.prepare('SELECT ip_prefix, ua_family FROM legal_acceptances WHERE user_id = ?').get(user.id);

    if (row.ip_prefix !== null) {
      expect(row.ip_prefix, 'a stored address must be a network prefix').toMatch(/\/(24|48)$/);
    }
    if (row.ua_family !== null) {
      expect(row.ua_family.length, 'a raw User-Agent string must never be stored').toBeLessThan(40);
      expect(row.ua_family).not.toMatch(/AppleWebKit|Mozilla/);
    }
  });

  it('records consent on the OAuth signup path too', async () => {
    // The hole most likely to be missed: OAuth commits at a different step in
    // the UI, and a provider signup that is never asked would make the whole
    // record worthless. Both paths run through this one endpoint, so the gate
    // covers them — asserted rather than assumed.
    const jwt = (await import('jsonwebtoken')).default;
    const { JWT_SECRET } = await import('./config.js');

    const email = `oauth.consent.${Date.now()}@example.com`;
    const signupToken = jwt.sign(
      {
        action: 'signup',
        provider: 'google',
        providerUserId: `google-${Date.now()}`,
        providerEmail: email,
        providerEmailVerified: true,
      },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    const base = account({ email });

    // Without consent: refused.
    const refused = await srv.call('POST', '/api/auth/signup', { ...base, signupToken, password: undefined });
    expect(refused.status, 'the provider path must be gated exactly like the password path').toBe(400);
    expect(refused.body.code).toBe('consent_required');
    expect(db.prepare('SELECT id FROM users WHERE email = ?').get(email)).toBeFalsy();

    // With consent: accepted, and recorded as an OAuth signup.
    const ok = await srv.call('POST', '/api/auth/signup', {
      ...base, signupToken, password: undefined, consent: consentAll(),
    });
    expect(ok.status).toBe(201);

    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    const rows = db.prepare('SELECT * FROM legal_acceptances WHERE user_id = ?').all(user.id);
    expect(rows.length).toBe(SIGNUP_DOCUMENTS.length);
    expect(rows[0].method).toBe('oauth_signup');
    expect(rows[0].context).toBe('oauth:google');
  });

  it('leaves no acceptance rows behind when the account insert fails', async () => {
    // Atomicity, from the other direction: a duplicate username fails inside
    // the transaction, so neither the user nor the acceptances may survive.
    const first = account({ consent: consentAll() });
    await srv.call('POST', '/api/auth/signup', first);

    const before = db.prepare('SELECT COUNT(*) AS c FROM legal_acceptances').get().c;

    const clash = account({ consent: consentAll(), username: first.username });
    const res = await srv.call('POST', '/api/auth/signup', clash);
    expect(res.status).toBe(409);

    const after = db.prepare('SELECT COUNT(*) AS c FROM legal_acceptances').get().c;
    expect(after, 'a failed signup must not leave orphan acceptance rows').toBe(before);
  });

  it('publishes the catalogue at boot', async () => {
    for (const doc of LEGAL_DOCUMENTS) {
      const row = db.prepare('SELECT * FROM legal_documents WHERE slug = ? AND version = ?')
        .get(doc.slug, doc.version);
      expect(row, `${doc.slug} v${doc.version} was not published`).toBeTruthy();
      /* What was actually published — the pinned constant while enforced, the live
   file hash before launch. See publishedHash(). */
      expect(row.content_hash).toBe(publishedHash(doc));
      expect(row.consent_type).toBe(doc.consentType);
    }
  });

  /**
   * Before launch: the row is brought back into line rather than refused.
   *
   * See `LEGAL_HASHES_ENFORCED` in legalDocuments.js for the owner's reasoning.
   * The assertion that matters is that the hash MOVES — a mode that stopped
   * checking and also stopped recording would leave the table describing text
   * that no longer exists, which is worse than either enforcing or ignoring.
   */
  /**
   * Advisory mode only, and it is now off.
   *
   * `runIf` rather than deletion, mirroring the `skipIf` on the pinned-hash case
   * above: the two are the same switch read from opposite sides. Deleting this
   * would mean that turning enforcement back off — which is legitimate if the
   * documents ever genuinely re-enter drafting — left the absorbing behaviour
   * with no coverage at all, and it is the more dangerous of the two modes.
   */
  it.runIf(!LEGAL_HASHES_ENFORCED)('brings a drifted published version back into line before launch', async () => {
    const { syncLegalDocuments } = await import('./consent.js');
    const doc = LEGAL_DOCUMENTS[0];

    db.prepare('UPDATE legal_documents SET content_hash = ? WHERE slug = ? AND version = ?')
      .run('deadbeef', doc.slug, doc.version);

    expect(() => syncLegalDocuments(db)).not.toThrow();

    expect(db.prepare('SELECT content_hash FROM legal_documents WHERE slug = ? AND version = ?')
      .get(doc.slug, doc.version).content_hash).not.toBe('deadbeef');
  });

  /**
   * With enforcement on — what ships at launch — it still refuses.
   *
   * A published version is immutable once anybody has accepted it: its hash is
   * what the acceptance rows point at, so silently updating it rewrites what
   * users are recorded as having agreed to. Exercised through a forced-true
   * re-import rather than assumed, because a switch nobody has pulled is a switch
   * that does not work.
   */
  it('refuses to republish a version whose content changed, once enforced', async () => {
    const doc = LEGAL_DOCUMENTS[0];

    vi.resetModules();
    const real = await import('./legalDocuments.js');
    vi.doMock('./legalDocuments.js', () => ({ ...real, LEGAL_HASHES_ENFORCED: true }));

    try {
      const { syncLegalDocuments } = await import('./consent.js');

      db.prepare('UPDATE legal_documents SET content_hash = ? WHERE slug = ? AND version = ?')
        .run('deadbeef', doc.slug, doc.version);

      expect(() => syncLegalDocuments(db)).toThrow(/immutable|different content hash/i);
    } finally {
      vi.doUnmock('./legalDocuments.js');
      vi.resetModules();
    }

    db.prepare('UPDATE legal_documents SET content_hash = ? WHERE slug = ? AND version = ?')
      .run(doc.contentHash, doc.slug, doc.version);
  });
});
