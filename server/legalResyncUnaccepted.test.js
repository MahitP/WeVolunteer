import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { up as resync } from './migrations/054_resync_unaccepted_legal_hashes.js';

/**
 * Starting hash enforcement on a database that predates it.
 *
 * ── Why this migration exists ──
 *
 * `LEGAL_HASHES_ENFORCED` was false for the whole pre-launch period, and in that
 * mode `syncLegalDocuments` rewrote `legal_documents.content_hash` to match the
 * file on every boot. Turning enforcement on makes the same comparison fatal, so
 * any database that ran before the flip holds rows pinned to whatever the text
 * was on its last boot — and a policy edited since then refuses the boot.
 *
 * Confirmed against a copy of the real pilot database, which would not start
 * after the audit rewrote six policies.
 *
 * ── The line this must not cross ──
 *
 * The refusal protects ACCEPTANCE RECORDS: a published version's hash is what
 * an acceptance points at, so moving it rewrites what somebody is recorded as
 * having agreed to. Where nobody has accepted, there is no such reader and the
 * stored hash is a stale note about text nobody was ever shown.
 *
 * So the whole value of this migration is in what it REFUSES to touch, and that
 * is what most of these cases assert.
 */

let db;

function seed() {
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE legal_documents (
      slug TEXT, version TEXT, content_hash TEXT, PRIMARY KEY (slug, version)
    );
    CREATE TABLE legal_acceptances (
      id TEXT PRIMARY KEY, user_id TEXT, document_slug TEXT, version TEXT, content_hash TEXT
    );
  `);
}

const doc = (slug, version, hash) =>
  db.prepare('INSERT INTO legal_documents VALUES (?, ?, ?)').run(slug, version, hash);

const accept = (slug, version, hash) =>
  db.prepare('INSERT INTO legal_acceptances VALUES (?, ?, ?, ?, ?)')
    .run(`acc-${slug}-${version}`, 'u1', slug, version, hash);

const remaining = () =>
  db.prepare('SELECT slug, version FROM legal_documents ORDER BY slug').all();

beforeEach(seed);

describe('versions nobody has accepted', () => {
  it('are cleared so the next sync republishes them at the current hash', () => {
    doc('privacy-policy', '1.0', 'stale');
    doc('cookie-and-tracking-notice', '1.0', 'stale');

    resync(db);

    expect(remaining()).toEqual([]);
  });

  it('are cleared rather than rewritten to a recomputed hash', () => {
    /**
     * Deliberate: this migration never reads a policy file. Recomputing a hash
     * here would be a second implementation of "what is this document's hash",
     * living in the schema layer where it could disagree with `hashPolicyFile` —
     * and a migration that silently disagrees about a legal hash is a worse
     * failure than the one being repaired.
     *
     * `syncLegalDocuments` runs on the same boot, straight after the migration
     * runner, and republishes from the one implementation that owns the question.
     */
    doc('privacy-policy', '1.0', 'stale');
    resync(db);
    expect(db.prepare('SELECT * FROM legal_documents').all()).toEqual([]);
  });
});

describe('versions somebody has accepted', () => {
  it('are left exactly as they are', () => {
    /* THE case. This is the invariant the flag exists to enforce, and a
       migration that swept these up would quietly defeat it. */
    doc('organizer-agreement', '1.0', 'pinned-at-acceptance');
    accept('organizer-agreement', '1.0', 'pinned-at-acceptance');

    resync(db);

    expect(remaining()).toEqual([{ slug: 'organizer-agreement', version: '1.0' }]);
    expect(
      db.prepare('SELECT content_hash AS h FROM legal_documents').get().h,
      'an accepted version had its hash moved'
    ).toBe('pinned-at-acceptance');
  });

  it('keep blocking the boot, which is the remedy working', () => {
    /**
     * Stated as a case because it is easy to read this migration as "unblock the
     * boot" and then extend it to do that unconditionally. It is not. For an
     * accepted version the correct remedy is a version bump, taken deliberately.
     */
    doc('organizer-agreement', '1.0', 'stale-but-accepted');
    accept('organizer-agreement', '1.0', 'what-they-actually-saw');

    resync(db);

    expect(remaining()).toHaveLength(1);
  });

  it('protects only the exact version accepted, not the whole document', () => {
    /**
     * Keyed on (slug, version). v1.0 being accepted says nothing about v1.1, and
     * treating the slug as the unit would leave an unaccepted revision stuck.
     */
    doc('privacy-policy', '1.0', 'a');
    doc('privacy-policy', '1.1', 'b');
    accept('privacy-policy', '1.0', 'a');

    resync(db);

    expect(remaining()).toEqual([{ slug: 'privacy-policy', version: '1.0' }]);
  });
});

describe('databases it must not disturb', () => {
  it('does nothing when every version has been accepted', () => {
    doc('terms-of-service', '1.0', 'x');
    accept('terms-of-service', '1.0', 'x');
    resync(db);
    expect(remaining()).toHaveLength(1);
  });

  it('does nothing on an empty catalogue', () => {
    expect(() => resync(db)).not.toThrow();
    expect(remaining()).toEqual([]);
  });

  it('skips a database too early to have the tables', () => {
    /* Migration 007 creates both; anything before it has nothing to reconcile
       and must not throw the boot. */
    const bare = new DatabaseSync(':memory:');
    expect(() => resync(bare)).not.toThrow();
  });
});
