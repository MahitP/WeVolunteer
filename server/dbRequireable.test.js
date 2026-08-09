import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `server/db.js` must stay SYNCHRONOUSLY requirable.
 *
 * ── The incident ──
 *
 * `db.js` gained an import of `scripts/seed_badges.js`, so that the badge
 * catalogue is reconciled at init rather than by a script somebody has to
 * remember to run. That file's CLI guard used a top-level `await` to defer its
 * own `db.js` import — and a module graph containing top-level await is an
 * ASYNCHRONOUS module, which `require()` refuses outright with
 * `ERR_REQUIRE_ASYNC_MODULE`.
 *
 * Nothing in the application uses `require`. What does is tooling: several tests
 * initialise a throwaway database by spawning
 * `node -e "require('./server/db.js').initDatabase()"`, which is the cheapest way
 * to get a real schema into a temp file without binding the parent process's
 * connection to it. Every one of those children died before creating a table,
 * and the failure surfaced as `no such table: users` in nine unrelated
 * assertions — a message that points at the fixture rather than at the import
 * three lines above it.
 *
 * ── Why a guard and not just a fixed comment ──
 *
 * The constraint is invisible at the point where it breaks. `db.js` is imported
 * by nearly everything, so ANY module it reaches can reintroduce a top-level
 * await — a lazy `await import()` at module scope is a normal thing to write, and
 * the file that does it may be several hops away and have no idea it is in this
 * graph. Nothing else in the repository states the requirement, and the symptom
 * does not name it.
 *
 * If this test fails: find the top-level `await` in `db.js`'s import graph and
 * wrap it in an async IIFE. Do not "fix" it by converting the callers to
 * `import()` — that hides the constraint rather than keeping it.
 */
describe('server/db.js', () => {
  it('can be loaded with require(), so tooling can initialise a schema in a child', () => {
    const dbFile = path.join(mkdtempSync(path.join(tmpdir(), 'wev-require-')), 'test.db');

    /* Run from the repo root, matching how the tests that depend on this invoke
       it — `require('./server/db.js')` is resolved relative to cwd. */
    const out = execFileSync(process.execPath, ['-e', `
      process.env.WEV_DB_PATH = ${JSON.stringify(dbFile)};
      process.env.DEMO_MODE = '';
      const { initDatabase } = require('./server/db.js');
      initDatabase();
      console.log('REQUIRED_OK');
    `], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });

    expect(out).toContain('REQUIRED_OK');
  });

  /**
   * And the schema it produces is real, not an empty file.
   *
   * The assertion above would pass on a `db.js` that loaded and did nothing,
   * which is the other half of what the original failure looked like. `users` is
   * the table whose absence every affected test reported.
   */
  it('creates the schema when required this way', () => {
    const dbFile = path.join(mkdtempSync(path.join(tmpdir(), 'wev-require-')), 'test.db');

    const out = execFileSync(process.execPath, ['-e', `
      process.env.WEV_DB_PATH = ${JSON.stringify(dbFile)};
      process.env.DEMO_MODE = '';
      const { initDatabase } = require('./server/db.js');
      initDatabase();
      const { DatabaseSync } = require('node:sqlite');
      const probe = new DatabaseSync(${JSON.stringify(dbFile)});
      const names = probe.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users','badges')"
      ).all().map(r => r.name).sort();
      console.log('TABLES:' + names.join(','));
    `], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });

    /* `badges` as well as `users`: it is the table the init-time reconciliation
       writes to, so its presence is what makes that call safe where it sits. */
    expect(out).toContain('TABLES:badges,users');
  });
});
