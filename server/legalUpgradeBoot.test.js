import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
