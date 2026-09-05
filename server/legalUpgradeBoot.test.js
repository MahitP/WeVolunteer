import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { daysAhead } from './testing/dates.js';

/* Computed, not written down: these were `2027-01-01` and `2027-02-01`, which
   pass today and become past dates in four months — at which point
   `parseEffectiveAt` refuses them. Found by the guard in `legalStore.test.js`,
   which exists because the same bug had already cost 28 tests in the two
   editor suites. Both stay comfortably inside `MAX_EFFECTIVE_DAYS_AHEAD`.

/**
 * An EXISTING database can still boot the current registry.
 *
 * ── The failure this exists for ──
 *
 * Every other check on the legal set compares the registry against the FILES:
 * `consent.test.js` pins that each hash matches the published body,
 * `bin/legal-hashes.mjs` reports drift, and the whole test suite builds its
 * databases from nothing so every document publishes for the first time. All of
 * them were green while the application could not start against any database
 * that already existed.
 *
 * Editing a published policy moves its pinned hash, and `syncLegalDocuments`
 * refuses a `(slug, version)` whose stored hash differs — correctly, because a
 * published version's hash is what an acceptance record points at. So the boot
 * dies with "…is already published with a different content hash" on the pilot
 * database and on every developer's, while a fresh one starts perfectly.
 *
 * Found by starting the dev server during the release-gate audit, which is a
 * poor substitute for a test, hence this file. Migration 054 repaired the first
 * occurrence and 061 the second; what neither of them could do is NOTICE the
 * third. This can: it is the only case in the suite that runs the real
 * initialisation twice — once to publish, once to upgrade.
 *
 * ── What it must not do ──
 *
 * Pass by weakening the invariant. The second case asserts the other half: a
 * version somebody has ACCEPTED still stops the boot, because there the remedy
 * is a deliberate version bump and never a migration.
 */

let dir;
const dbs = [];

/** A database initialised by the real code path, at `file`. */
async function boot(file) {
  const previous = process.env.WEV_DB_PATH;
  process.env.WEV_DB_PATH = file;
  /* A fresh module registry per boot: `db.js` holds the handle in module state,
     so a second `initDatabase()` in the same graph would reuse the first
     connection and never open `file` at all. `resetModules` rather than a query
     string on the specifier, because the bundler refuses a dynamic import whose
     path is not statically analysable. */
  vi.resetModules();
  const mod = await import('./db.js');
  try {
    mod.initDatabase();
    await mod.completeDatabaseInit();
  } finally {
    process.env.WEV_DB_PATH = previous;
  }
  return mod;
}

/**
 * Rewinds `file` to look like a deployment that predates the current registry:
 * the documents are published at some OTHER text, and the migrations that would
 * repair that have not run yet.
 *
 * `content_hash` is set to a value no policy file can produce, which is exactly
 * the situation an edited policy creates and is stronger than replaying one
 * specific historical hash — this stays true the next time a document changes.
 */
function rewind(file, { keepAccepted = null } = {}) {
  const db = new DatabaseSync(file);
  const stale = 'f'.repeat(64);
  for (const row of db.prepare('SELECT slug, version FROM legal_documents').all()) {
    if (keepAccepted && row.slug === keepAccepted.slug && row.version === keepAccepted.version) continue;
    db.prepare('UPDATE legal_documents SET content_hash = ? WHERE slug = ? AND version = ?')
      .run(stale, row.slug, row.version);
  }
  if (keepAccepted) {
    db.prepare('UPDATE legal_documents SET content_hash = ? WHERE slug = ? AND version = ?')
      .run(stale, keepAccepted.slug, keepAccepted.version);
    /* A real user row, because `legal_acceptances.user_id` is a RESTRICT
       foreign key — and an acceptance belonging to nobody would not be the
       thing the invariant protects anyway. */
    const now = new Date().toISOString();
    let userId = db.prepare('SELECT id FROM users LIMIT 1').get()?.id;
    if (!userId) {
      userId = 'user-upgrade-1';
      db.prepare(`
        INSERT INTO users (id, username, email, password_hash, name, grade, role, created_at)
        VALUES (?, 'upgrade1', 'upgrade1@example.invalid', 'x', 'Upgrade One', '11', 'student', ?)
      `).run(userId, now);
    }
    db.prepare(`
      INSERT INTO legal_acceptances
        (id, user_id, document_slug, version, content_hash, accepted_at, method)
      VALUES ('acc-upgrade-1', ?, ?, ?, ?, ?, 'checkbox')
    `).run(userId, keepAccepted.slug, keepAccepted.version, stale, now);
  }
  /**
   * Un-apply only the NEWEST repair migration.
   *
   * This is the real shape of the problem and the test is worthless without it.
   * The pilot database has already run 054 — that is why it broke a second
   * time: a migration runs once, so the one that repaired the first round of
   * edits was never going to see the second. Rewinding 054 as well would let it
   * re-run and repair everything, and the case would pass with no new migration
   * registered at all, which is exactly what it did on the first attempt.
   */
  db.prepare('DELETE FROM schema_migrations WHERE version = 61').run();
  db.close();
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-upgrade-'));
  process.env.JWT_SECRET = 'x'.repeat(48);
  delete process.env.NODE_ENV;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.WEV_DB_PATH;
});

describe('booting the current registry against a database that already published', () => {
  it('starts, and republishes every document at its current hash', async () => {
    const file = path.join(dir, 'upgrade.db');
    dbs.push(file);

    await boot(file);                 // first boot: publishes the whole set
    rewind(file);                     // now it holds different text, unaccepted

    /* The assertion is that this RESOLVES. Before migration 061 it rejected
       with "terms-of-service@1.0 is already published with a different content
       hash", which is precisely the boot failure this file exists to catch. */
    await expect(boot(file)).resolves.toBeTruthy();

    const db = new DatabaseSync(file);
    const rows = db.prepare('SELECT slug, version, content_hash FROM legal_documents').all();
    db.close();

    const { LEGAL_DOCUMENTS } = await import('./legalDocuments.js');
    expect(rows.length, 'every registered document is published').toBe(LEGAL_DOCUMENTS.length);
    for (const doc of LEGAL_DOCUMENTS) {
      const row = rows.find(r => r.slug === doc.slug && r.version === doc.version);
      expect(row, `${doc.slug}@${doc.version} is missing after the upgrade`).toBeTruthy();
      expect(row.content_hash, `${doc.slug}@${doc.version} kept a stale hash`).toBe(doc.contentHash);
    }
  });

  it('still refuses when somebody has accepted the version that changed', async () => {
    const file = path.join(dir, 'accepted.db');
    dbs.push(file);

    await boot(file);

    const { LEGAL_DOCUMENTS } = await import('./legalDocuments.js');
    const target = LEGAL_DOCUMENTS[0];
    rewind(file, { keepAccepted: { slug: target.slug, version: target.version } });

    /* The invariant, and the reason the migration is a repair rather than a
       loophole: an accepted version keeps its hash and keeps stopping the boot.
       The remedy there is a deliberate version bump. */
    await expect(boot(file)).rejects.toThrow(/already published with a different content hash/);
  });
});

/**
 * A catalogue row for a version the registry no longer declares.
 *
 * ── Why this is not cosmetic ──
 *
 * The Privacy Policy was briefly at 1.1 and was returned to 1.0, because before
 * launch every document stays at 1.0. A database that booted while it was 1.1
 * has a `legal_documents` row for a `(slug, version)` the registry no longer
 * knows about, and the first instinct is that it is inert: `syncLegalDocuments`
 * never compares it, so it cannot stop a boot, and the API serves 1.0.
 *
 * It is not inert. `highestVersion()` in `legalStore.js` reads
 * `legal_documents` BY SLUG with no version filter, and the Legal Center editor
 * uses it as the floor a new revision must clear. Measured against a database
 * carrying the row: publishing 1.0.1 is refused with "Version 1.0.1 is lower
 * than 1.1, which is already published", and the first accepted version is
 * 1.1.1. So the next real revision of the Privacy Policy would be numbered as a
 * revision of a 1.1 no reader was ever shown — the exact misleading answer the
 * collapse to 1.0 was performed to avoid, arrived at from the other direction.
 *
 * ── Why there is no new migration ──
 *
 * 061 already removes it. It clears every `(slug, version)` nobody has accepted
 * and lets `syncLegalDocuments` republish what the registry declares — and an
 * unregistered version is not republished, so it simply goes. 061 has never
 * shipped (origin/main predates it), so no database anywhere has run it, and
 * every real upgrade therefore runs it once against the final registry and
 * lands clean.
 *
 * That makes the correct behaviour an accident of 061's breadth rather than
 * something anybody asserted, which is what this case fixes. A future 062 that
 * repairs only named slugs, or a narrowing of 061, would reintroduce the version
 * floor silently and no other test would notice.
 */
describe('a catalogue row the registry no longer declares', () => {
  it('is removed by the upgrade, not merely ignored', async () => {
    const file = path.join(dir, 'orphan.db');

    const first = await boot(file);
    /* A database that published privacy-policy@1.1, as one booted between
       386c9e9 and the revert would have. Columns are read off the row the
       registry did publish so this cannot drift from the schema. */
    const seed = new DatabaseSync(file);
    const row = seed.prepare("SELECT * FROM legal_documents WHERE slug = 'privacy-policy'").get();
    expect(row, 'fixture: the registry version is published').toBeTruthy();
    seed.prepare(`
      INSERT INTO legal_documents (slug, version, title, consent_type, content_hash, effective_at, published_at)
      VALUES ('privacy-policy', '1.1', ?, ?, 'orphaned-hash', ?, ?)
    `).run(row.title, row.consent_type, row.effective_at, new Date().toISOString());
    /* Un-apply only the newest repair, so this is a database that has not seen
       it — the same rewind the cases above use, and the same reason. */
    seed.prepare('DELETE FROM schema_migrations WHERE version = 61').run();
    seed.close();
    expect(first).toBeTruthy();

    await boot(file);

    const after = new DatabaseSync(file);
    const versions = after.prepare(
      "SELECT version FROM legal_documents WHERE slug = 'privacy-policy' ORDER BY version"
    ).all().map(r => r.version);
    after.close();

    const { LEGAL_DOCUMENTS } = await import('./legalDocuments.js');
    const registered = LEGAL_DOCUMENTS.find(d => d.slug === 'privacy-policy').version;

    expect(
      versions,
      'an unregistered catalogue row survived the upgrade. It is not harmless: '
      + 'highestVersion() reads legal_documents by slug, so it raises the floor '
      + 'the Legal Center editor makes the next revision clear.',
    ).toEqual([registered]);
  });

  it('leaves the editor free to publish the next ordinary revision', async () => {
    /**
     * The consequence, asserted directly rather than inferred from the row
     * being gone. This is the thing a reader would eventually see, and it is
     * what makes the case above worth having.
     */
    const file = path.join(dir, 'orphan-editor.db');
    await boot(file);
    const mod = await import('./db.js');
    const store = await import('./legalStore.js');

    await expect(
      store.publishRevision(mod.db, {
        slug: 'privacy-policy',
        version: '1.0.1',
        body: '# Privacy Policy\n\nA revision published by the editor.',
        effectiveAt: daysAhead(120),
        actorId: 'system-cli',
      }),
      'the next ordinary revision of the Privacy Policy is 1.0.1; a database '
      + 'still carrying a 1.1 catalogue row refuses it and demands 1.1.1',
    ).resolves.toBeTruthy();
  });
});

/**
 * The workflow an owner actually uses to change a published document.
 *
 * ── Why this needed auditing ──
 *
 * Everything else in this file is about the FILE-edit path: change the markdown,
 * re-pin the hash, and — when a published version's hash moves — write a
 * migration, because `syncLegalDocuments` refuses the boot otherwise. That
 * friction is deliberate, and it reads like a production hazard: a policy change
 * that needs a schema migration and a deploy is a policy change nobody makes in
 * a hurry.
 *
 * It is not the production workflow. `/admin/legal` is, owner-only, and it
 * publishes into `legal_document_revisions` with a version the server requires
 * to be strictly greater. Measured against a copy of the pilot database:
 * publishing 1.1.0 of the Organizer Agreement took no migration, no deploy and
 * no restart, and a subsequent boot came up clean and served the new revision.
 *
 * So there is no gap to close, and this is the invariant that makes that true
 * rather than an architecture change nobody needs.
 *
 * ── What must never happen ──
 *
 * The Organizer Agreement is the one document with a real acceptance behind it
 * on the pilot database. Publishing a NEW version must leave the OLD one exactly
 * as it was — same row, same hash — because that row is what the acceptance
 * record points at. A `publishRevision` that ever "tidied up" superseded rows
 * would rewrite what somebody is recorded as having agreed to, silently, with no
 * boot failure to notice it.
 */
describe('publishing a revision through the editor', () => {
  it('adds a version without disturbing the one somebody accepted', async () => {
    const file = path.join(dir, 'editor.db');
    const mod = await boot(file);
    const store = await import('./legalStore.js');
    const { LEGAL_DOCUMENTS } = await import('./legalDocuments.js');

    const target = LEGAL_DOCUMENTS.find(d => d.slug === 'organizer-agreement');
    const seed = new DatabaseSync(file);
    const now = new Date().toISOString();
    seed.prepare(`
      INSERT INTO users (id, username, email, password_hash, name, grade, role, created_at)
      VALUES ('user-accepted-1','accepted1','accepted1@example.invalid','x','Accepted One','Adult','organizer',?)
    `).run(now);
    seed.prepare(`
      INSERT INTO legal_acceptances (id, user_id, document_slug, version, content_hash, accepted_at, method)
      VALUES ('acc-editor-1','user-accepted-1',?,?,?,?,'organizer_agreement')
    `).run(target.slug, target.version, target.contentHash, now);
    seed.close();

    await store.publishRevision(mod.db, {
      slug: target.slug,
      version: '1.1.0',
      body: '# Organizer Agreement\n\nA revision published through the editor.',
      effectiveAt: daysAhead(150),
      userId: 'system-cli',
    });

    const after = new DatabaseSync(file);
    const original = after.prepare(
      'SELECT content_hash FROM legal_documents WHERE slug = ? AND version = ?'
    ).get(target.slug, target.version);
    const acceptance = after.prepare(
      "SELECT version, content_hash FROM legal_acceptances WHERE id = 'acc-editor-1'"
    ).get();
    const versions = after.prepare(
      'SELECT version FROM legal_documents WHERE slug = ? ORDER BY version'
    ).all(target.slug).map(r => r.version);
    after.close();

    expect(original?.content_hash, 'the accepted version was rewritten by a new revision')
      .toBe(target.contentHash);
    expect(acceptance.version).toBe(target.version);
    expect(acceptance.content_hash, 'the acceptance no longer points at what it agreed to')
      .toBe(target.contentHash);
    expect(versions, 'the new version is added alongside, not over the top')
      .toEqual([target.version, '1.1.0']);
  });

  it('still boots cleanly afterwards, with no migration in between', async () => {
    /* The half that makes "no deploy needed" true rather than merely likely:
       hash enforcement runs on every boot and must not object to a document
       whose live text now comes from a revision. */
    const file = path.join(dir, 'editor.db');
    await expect(boot(file)).resolves.toBeTruthy();

    const store = await import('./legalStore.js');
    const mod = await import('./db.js');
    const current = await store.currentRevision(mod.db, 'organizer-agreement', { withBody: false });
    expect(current?.version, 'the reboot did not serve the published revision').toBe('1.1.0');
  });
});
