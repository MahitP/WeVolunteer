/**
 * Booting twice — the case the whole suite was blind to.
 *
 * ── Why this file exists ──
 *
 * The v1.0 launch renumbering crashed `initDatabase()` on every database that had
 * booted before:
 *
 *     legal_documents: organizer-agreement@1.0 is already published with a
 *     different content hash.
 *
 * `server.js` calls `initDatabase()` with no catch, so the process died at startup,
 * and every reported symptom — OAuth failing, the Legal Center not loading, routes
 * regressing — was that single crash. Nothing was individually broken; the server
 * was not running.
 *
 * **The suite could not see it, and that is the interesting part.**
 * `server/testServer.js` builds a throwaway database per run, so every server test
 * exercises a FIRST boot. `syncLegalDocuments` only compares against rows a
 * previous boot left behind, so a first boot can never collide. Three thousand
 * tests passed against a codebase whose server could not start.
 *
 * So the regression these tests pin is not "the hash is right" — `legalContent.test.js`
 * already does that. It is **boot, change a document, boot again**, which is the
 * shape of every real deployment and of every developer's own database.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
/* Read rather than assumed: the case below is only true while enforcement is
   off, and hardcoding either answer here is how a mode switch stops working. */
import { LEGAL_HASHES_ENFORCED } from './legalDocuments.js';

let dir;

/**
 * A database directory that survives across module resets, so the same file can be
 * opened by two separate `initDatabase()` calls — which is what makes this a
 * second-boot test rather than another first-boot test.
 */
function freshDir() {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-republish-'));
  process.env.WEV_DB_PATH = path.join(dir, 'republish.db');
  process.env.JWT_SECRET = 'Kx9$mQ2vB7nR4tY8wL3zC6dF1gH5jN0pS';
  delete process.env.NODE_ENV;
  delete process.env.DEMO_MODE;
}

/** Boots the app's data layer against the current WEV_DB_PATH, fresh module state. */
async function boot() {
  vi.resetModules();
  const dbMod = await import('./db.js');
  dbMod.initDatabase();
  await dbMod.completeDatabaseInit();
  return dbMod.db;
}

beforeEach(() => { freshDir(); });
afterEach(() => {
  vi.restoreAllMocks();
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
});

describe('booting a second time against the same database', () => {
  it('succeeds when nothing changed', async () => {
    await boot();
    // The plain idempotency case. It passed before the regression too, which is
    // exactly why it was not enough on its own.
    await expect(boot()).resolves.toBeTruthy();
  });

  it('publishes each registered document exactly once across two boots', async () => {
    await boot();
    const db = await boot();
    const rows = db.prepare('SELECT slug, version, COUNT(*) AS c FROM legal_documents GROUP BY slug, version').all();
    expect(rows.every(r => r.c === 1), 'a boot duplicated a publication row').toBe(true);
  });

  /**
   * The reconciliation itself, on a database that predates migration 016.
   *
   * `schema_migrations` is what makes 016 a ONE-TIME launch fixup rather than an
   * ongoing licence to edit published documents, so reproducing the original
   * situation means putting the database back where it was: stale rows present, 016
   * not yet applied. That is precisely the state the operator's database was in.
   *
   * Simulated by rewriting the stored hash rather than by editing a file on disk.
   * The file is the fixture for every other test in the suite; mutating it would
   * make this test's failure mode "you broke ten other files". The stored row is
   * what `syncLegalDocuments` compares against, so this reproduces the same
   * collision from the same direction.
   */
  it('reconciles stale unaccepted publications on the boot that first applies 016', async () => {
    let db = await boot();

    const target = db.prepare('SELECT slug, version FROM legal_documents LIMIT 1').get();
    db.prepare('UPDATE legal_documents SET content_hash = ? WHERE slug = ? AND version = ?')
      .run('0'.repeat(64), target.slug, target.version);
    db.prepare('DELETE FROM schema_migrations WHERE version = 16').run();
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM legal_acceptances WHERE document_slug = ?')
        .get(target.slug).c,
      'fixture assumption: nobody has accepted this document'
    ).toBe(0);

    // Before 016 existed this threw here and the process died at startup.
    db = await boot();

    const row = db.prepare('SELECT content_hash FROM legal_documents WHERE slug = ? AND version = ?')
      .get(target.slug, target.version);
    expect(row, 'the document was not republished').toBeTruthy();
    expect(row.content_hash, 'the stale hash survived the reconciliation').not.toBe('0'.repeat(64));
  });

  /**
   * The safety property, and the reason the reconciliation is allowed to delete at
   * all: it must refuse the moment a real acceptance points at the row.
   *
   * This is the branch that runs on a launched database. Deleting here would rewrite
   * what a user is recorded as having agreed to, so stopping the boot is the correct
   * outcome — loudly, not quietly.
   */
  it('REFUSES to reconcile a row that a recorded acceptance points at', async () => {
    let db = await boot();
    const target = db.prepare('SELECT slug, version, content_hash FROM legal_documents LIMIT 1').get();

    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, grade, username,
                         email_verified, account_status, created_at)
      VALUES ('republish-user', 'republish@example.com', 'h', 'Republish Tester', 'student',
              '11', 'republish_user', 1, 'active', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO legal_acceptances
        (id, user_id, document_slug, version, content_hash, accepted_at, method)
      VALUES ('acc-republish', 'republish-user', ?, ?, ?, datetime('now'), 'signup')
    `).run(target.slug, target.version, target.content_hash);

    db.prepare('UPDATE legal_documents SET content_hash = ? WHERE slug = ? AND version = ?')
      .run('f'.repeat(64), target.slug, target.version);
    db.prepare('DELETE FROM schema_migrations WHERE version = 16').run();

    await expect(boot()).rejects.toThrow(/referenced by recorded acceptances|never delete these rows/i);

    // A refusal must not have destroyed anything.
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(process.env.WEV_DB_PATH);
    expect(raw.prepare('SELECT COUNT(*) AS c FROM legal_acceptances WHERE id = ?')
      .get('acc-republish').c).toBe(1);
    expect(raw.prepare('SELECT COUNT(*) AS c FROM legal_documents WHERE slug = ? AND version = ?')
      .get(target.slug, target.version).c).toBe(1);
    raw.close();
  });

  /**
   * 016 is a launch fixup, NOT a standing bypass — the property that matters most.
   *
   * Once it has run, editing a published version's content without bumping the
   * version must still refuse, because that is the guard which stops a deployment
   * serving policy text nobody agreed to. If this test ever passes by booting
   * cleanly, the immutability rule has been quietly removed.
   */
  /**
   * Before launch the same edit is absorbed rather than refused, and the recorded
   * hash moves forward.
   *
   * This is the owner's decision recorded at `LEGAL_HASHES_ENFORCED` — the
   * documents are still being drafted and there are no acceptance records to
   * protect. The property being asserted is not "it no longer checks"; it is that
   * the row is UPDATED. Leaving it stale would make `legal_documents` describe
   * text that no longer exists, every later acceptance would copy that stale
   * hash, and flipping enforcement on at launch would then fail against a
   * database nobody could reconcile.
   */
  /* `runIf`, not deletion — enforcement is now on, and this documents the other
     mode. See the same idiom in consent.test.js. */
  it.runIf(!LEGAL_HASHES_ENFORCED)('absorbs an edited published version before launch, moving the recorded hash', async () => {
    let db = await boot();
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM schema_migrations WHERE version = 16').get().c,
      'fixture assumption: 016 has been applied'
    ).toBe(1);

    const target = db.prepare('SELECT slug, version FROM legal_documents LIMIT 1').get();
    db.prepare('UPDATE legal_documents SET content_hash = ? WHERE slug = ? AND version = ?')
      .run('a'.repeat(64), target.slug, target.version);

    db = await boot();

    const after = db.prepare('SELECT content_hash FROM legal_documents WHERE slug = ? AND version = ?')
      .get(target.slug, target.version);
    expect(after.content_hash).not.toBe('a'.repeat(64));
    expect(after.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * And with enforcement ON — which is what ships at launch — it still refuses.
   *
   * The behaviour above is a pre-launch convenience, not a decision that this
   * guard was unnecessary. Once real people have accepted real documents, editing
   * a published version's text without bumping its version rewrites what they are
   * recorded as having agreed to, and that must stay impossible.
   *
   * Asserted by re-importing the module graph with the constant forced true,
   * rather than by trusting that flipping it will work. A switch nobody has
   * pulled is a switch that does not work.
   */
  it('still refuses an edited published version when enforcement is on', async () => {
    let db = await boot();
    const target = db.prepare('SELECT slug, version FROM legal_documents LIMIT 1').get();
    db.prepare('UPDATE legal_documents SET content_hash = ? WHERE slug = ? AND version = ?')
      .run('a'.repeat(64), target.slug, target.version);

    vi.resetModules();
    const real = await import('./legalDocuments.js');
    vi.doMock('./legalDocuments.js', () => ({ ...real, LEGAL_HASHES_ENFORCED: true }));

    try {
      const dbMod = await import('./db.js');
      /**
       * The refusal moved, and the property did not.
       *
       * `syncLegalDocuments` is what raises this, and it reads and writes rows
       * through `legalStore` — so it is async, and it now runs in
       * `completeDatabaseInit()` rather than inside the synchronous
       * `initDatabase()`. Boot still dies on a changed hash, because
       * `server.js` awaits that call at module top level with no catch, which
       * is the same "process does not start" this test was written to pin.
       */
      dbMod.initDatabase();
      await expect(dbMod.completeDatabaseInit())
        .rejects.toThrow(/already published with a different content hash/i);
    } finally {
      vi.doUnmock('./legalDocuments.js');
      vi.resetModules();
    }
  });
});

describe('a production boot verifies the published documents', () => {
  /**
   * `server.js` treats a hash mismatch as fatal in production. That guard is what
   * turns "a deployment shipped edited policy text" into a refusal instead of a
   * user reading terms nobody agreed to, so it is asserted rather than trusted.
   */
  it('verifies every registered document against its pinned hash', async () => {
    vi.resetModules();
    const { verifyPolicyFiles } = await import('./legalContent.js');
    const { LEGAL_DOCUMENTS } = await import('./legalDocuments.js');
    expect(verifyPolicyFiles()).toBe(LEGAL_DOCUMENTS.length);
  });
});
