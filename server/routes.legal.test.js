import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * The Legal Center endpoints.
 *
 * The property under test that matters most is the unauthenticated one: the
 * signup form asks somebody with no account to agree to the Terms, so if these
 * routes ever acquire `authenticateToken` the consent flow links become
 * unfollowable by the only person who needs to follow them. That is asserted
 * directly rather than left implied by the other tests passing.
 *
 * Nothing is statically imported from anything that reaches `db.js` — see the
 * testing section of CLAUDE.md. `legalDocuments.js` imports only node builtins,
 * so it is safe, but it is loaded through the harness anyway for consistency.
 */
describe('legal document endpoints', () => {
  let srv;
  let LEGAL_DOCUMENTS;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ LEGAL_DOCUMENTS } = await import('./legalDocuments.js'));
  });
  afterAll(async () => { await srv.close(); });

  describe('GET /api/legal/documents', () => {
    it('is served without a session', async () => {
      const res = await srv.call('GET', '/api/legal/documents');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.documents)).toBe(true);
    });

    it('publishes every registered document', async () => {
      const res = await srv.call('GET', '/api/legal/documents');
      const slugs = res.body.documents.map(d => d.slug).sort();
      expect(slugs).toEqual(LEGAL_DOCUMENTS.map(d => d.slug).sort());
    });

    it('includes the version and effective date of each document', async () => {
      // A catalogue that cannot say which version it is offering is not much of
      // a catalogue — the whole point of an acceptance record is that it names a
      // version, and the reader has to be able to see the same one.
      const res = await srv.call('GET', '/api/legal/documents');
      for (const doc of res.body.documents) {
        expect(doc.version, `${doc.slug} has no version`).toMatch(/^\d+\.\d+$/);
        expect(doc.effectiveAt, `${doc.slug} has no effective date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(doc.title).toBeTruthy();
      }
    });

    it('never leaks the on-disk filename', async () => {
      // `file` is an implementation detail of where the repo keeps its Markdown.
      // Publishing it invites path-shaped requests against a static mount.
      const res = await srv.call('GET', '/api/legal/documents');
      for (const doc of res.body.documents) {
        expect(doc.file).toBeUndefined();
        expect(JSON.stringify(doc)).not.toContain('.md');
      }
    });

    it('marks exactly the documents that are collected at signup', async () => {
      const res = await srv.call('GET', '/api/legal/documents');
      const signup = res.body.documents.filter(d => d.scope === 'signup').map(d => d.slug).sort();
      expect(signup).toEqual(['community-guidelines', 'privacy-policy', 'terms-of-service']);
    });

    it('does not scope the Organizer Agreement to signup', async () => {
      /**
       * The Organizer Agreement is `consentType: 'agree'` — a real contract —
       * but it binds organizers. If it were scoped to signup it would become a
       * fourth mandatory checkbox demanding that every fourteen-year-old accept
       * undertakings about handling other students' contact details.
       *
       * This is the exact failure the `scope` field was introduced to prevent,
       * so it is pinned here rather than left to the filter in legalDocuments.js.
       */
      const res = await srv.call('GET', '/api/legal/documents');
      const organizer = res.body.documents.find(d => d.slug === 'organizer-agreement');
      expect(organizer).toBeTruthy();
      expect(organizer.consentType).toBe('agree');
      expect(organizer.scope).toBe('organizer-onboarding');
    });
  });

  describe('GET /api/legal/documents/:slug', () => {
    it('is served without a session', async () => {
      const res = await srv.call('GET', '/api/legal/documents/terms-of-service');
      expect(res.status).toBe(200);
    });

    it('returns the document text with its version and hash', async () => {
      const res = await srv.call('GET', '/api/legal/documents/privacy-policy');
      expect(res.status).toBe(200);
      expect(res.body.slug).toBe('privacy-policy');
      expect(res.body.markdown).toContain('#');
      expect(res.body.markdown.length).toBeGreaterThan(500);
      expect(res.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('serves text matching the hash pinned in the registry', async () => {
      /**
       * The one property the Legal Center exists to hold. An acceptance row says
       * "agreed to v2.0, hash e6b3…"; if this endpoint can serve different bytes
       * under that version, the record proves nothing.
       */
      const { createHash } = await import('node:crypto');
      for (const doc of LEGAL_DOCUMENTS) {
        const res = await srv.call('GET', `/api/legal/documents/${doc.slug}`);
        expect(res.status, `${doc.slug} did not serve`).toBe(200);
        const served = createHash('sha256').update(res.body.markdown).digest('hex');
        expect(served, `${doc.slug}: served text does not match its pinned hash`)
          .toBe(doc.contentHash);
      }
    });

    it('serves every registered document', async () => {
      // A document registered but unreadable is worse than one not registered:
      // the catalogue advertises it and the link 404s.
      for (const doc of LEGAL_DOCUMENTS) {
        const res = await srv.call('GET', `/api/legal/documents/${doc.slug}`);
        expect(res.status, `${doc.slug} is in the catalogue but does not serve`).toBe(200);
      }
    });

    it('404s an unknown slug', async () => {
      const res = await srv.call('GET', '/api/legal/documents/no-such-policy');
      expect(res.status).toBe(404);
    });

    it('does not traverse out of the policy directory', async () => {
      // The slug is looked up in the registry rather than joined onto a path, so
      // there is no traversal to defend against. Asserted anyway: this is the
      // shape that would appear the moment someone "simplified" the lookup into
      // a path.join, and the test is what would notice.
      for (const probe of ['../../package.json', '..%2F..%2Fpackage.json', '....//package.json']) {
        const res = await srv.call('GET', `/api/legal/documents/${probe}`);
        expect(res.status).not.toBe(200);
      }
    });
  });

  describe('the routes stay public', () => {
    it('accepts a request carrying no cookie and no Authorization header', async () => {
      // Pinned deliberately. `authenticateToken` appearing on these routes would
      // pass every other test in this file — the harness has a session available
      // — and would silently make the signup Terms link unfollowable.
      for (const path of ['/api/legal/documents', '/api/legal/documents/terms-of-service']) {
        const res = await srv.call('GET', path, undefined, null);
        expect(res.status, `${path} requires a session`).toBe(200);
      }
    });

    it('is not gated behind email verification', async () => {
      const res = await srv.call('GET', '/api/legal/documents/community-guidelines', undefined, null);
      expect(res.status).toBe(200);
      expect(res.body.code).not.toBe('email_unverified');
    });
  });
});
