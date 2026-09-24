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

/**
 * Migration 061 — the same repair, for the documents edited after 054 ran.
 *
 * 054 is self-limiting but not self-repeating: a migration runs once, so it
 * reconciled the drift that existed the day it ran and nothing after it. Three
 * published policies were corrected by 16a7a1d and the Privacy Policy was
 * returned to 1.0 during the hardening pass, so an existing database needs the
 * repair again.
 *
 * The behaviour is deliberately identical and the cases above already pin it in
 * detail. What is asserted here is what DIFFERS: the guard.
 */
describe('migration 061', () => {
  let resync61;

  beforeEach(async () => {
    ({ up: resync61 } = await import('./migrations/061_resync_unaccepted_legal_hashes_again.js'));
  });

  it('clears an unaccepted version, exactly as 054 does', () => {
    seed();
    doc('privacy-policy', '1.0', 'stale-hash');
    resync61(db);
    expect(db.prepare('SELECT COUNT(*) c FROM legal_documents').get().c).toBe(0);
  });

  it('leaves an accepted version alone, exactly as 054 does', () => {
    seed();
    doc('terms-of-service', '1.0', 'stale-hash');
    db.prepare('INSERT INTO legal_acceptances VALUES (?,?,?,?,?)')
      .run('acc-1', 'user-1', 'terms-of-service', '1.0', 'stale-hash');

    resync61(db);

    const row = db.prepare("SELECT content_hash FROM legal_documents WHERE slug = 'terms-of-service'").get();
    expect(row?.content_hash, 'an accepted version was rewritten').toBe('stale-hash');
  });

  /**
   * The guard, which 061 nearly shipped without.
   *
   * It was left out on the reasoning that migrations apply in ascending order,
   * so 007 has always created the tables by the time this runs. True of the
   * RUNNER; not true of `up()`, which this very file calls directly against 054
   * for the same case — and an adversarial probe during the hardening pass got
   * `no such table: legal_documents` straight out of it.
   *
   * The guard is `SELECT 1 FROM <table> LIMIT 0` rather than a `sqlite_master`
   * lookup because `sqliteDialect.test.js` holds the count of SQLite-only
   * constructs and fails when it rises. The portable form costs that ratchet
   * nothing and works on both engines.
   */
  it('skips a database too early to have the tables', () => {
    db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');

    expect(() => resync61(db)).not.toThrow();
  });

  it('skips a database that has only one of the two tables', () => {
    db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE legal_documents (slug TEXT, version TEXT, content_hash TEXT)');

    expect(() => resync61(db)).not.toThrow();
  });
});

/**
 * Migration 068 — the two documents the 2026-09-21 audit corrected.
 *
 * Structurally 054's repair with one addition: it names the two slugs as well
 * as requiring zero acceptances, so it cannot become the general "rewrite any
 * legal document" mechanism if a later hash moves for a reason nobody
 * reviewed. Both conditions are asserted independently below, because either
 * alone would be weaker than the pair.
 */
describe('migration 068', () => {
  let resync068;

  beforeEach(async () => {
    ({ up: resync068 } = await import('./migrations/068_resync_audit_corrected_legal_hashes.js'));
  });

  it('clears the two corrected documents when nobody has accepted them', () => {
    doc('certificate-verification-policy', '1.0', 'old-cert-hash');
    doc('volunteer-record-policy', '1.0', 'old-record-hash');

    resync068(db);

    expect(remaining()).toEqual([]);
  });

  it('leaves either one alone the moment somebody has accepted it', () => {
    doc('certificate-verification-policy', '1.0', 'old-cert-hash');
    doc('volunteer-record-policy', '1.0', 'old-record-hash');
    accept('volunteer-record-policy', '1.0', 'old-record-hash');

    resync068(db);

    /* The accepted one keeps its row AND its hash — it would keep blocking the
       boot, which is the invariant working rather than failing. */
    expect(remaining()).toEqual([{ slug: 'volunteer-record-policy', version: '1.0' }]);
    expect(
      db.prepare('SELECT content_hash FROM legal_documents WHERE slug = ?')
        .get('volunteer-record-policy').content_hash,
    ).toBe('old-record-hash');
  });

  it('touches no other document, however drifted or unaccepted', () => {
    /* The live database carries eleven others. None of them is this migration's
       business, and the slug list is what guarantees that. */
    doc('terms-of-service', '1.0', 'tos-hash');
    doc('privacy-policy', '1.0', 'privacy-hash');
    doc('youth-safety-guidelines', '1.0', 'ysg-hash');
    doc('certificate-verification-policy', '1.0', 'old-cert-hash');

    resync068(db);

    expect(remaining()).toEqual([
      { slug: 'privacy-policy', version: '1.0' },
      { slug: 'terms-of-service', version: '1.0' },
      { slug: 'youth-safety-guidelines', version: '1.0' },
    ]);
  });

  it('protects only the exact version, so a later unaccepted one still clears', () => {
    doc('volunteer-record-policy', '1.0', 'old-record-hash');
    accept('volunteer-record-policy', '1.0', 'old-record-hash');
    doc('volunteer-record-policy', '1.1', 'newer-hash');

    resync068(db);

    /* 1.1 is not in the slug/version list, so it survives too — this migration
       is scoped to the two v1.0 rows and nothing else. */
    expect(remaining()).toEqual([
      { slug: 'volunteer-record-policy', version: '1.0' },
      { slug: 'volunteer-record-policy', version: '1.1' },
    ]);
  });

  it('does nothing on an empty catalogue', () => {
    expect(() => resync068(db)).not.toThrow();
    expect(remaining()).toEqual([]);
  });

  it('skips a database too early to have the tables', () => {
    const early = new DatabaseSync(':memory:');
    expect(() => resync068(early)).not.toThrow();
  });
});
