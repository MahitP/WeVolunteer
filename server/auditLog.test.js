/**
 * The audit helper, driven against a throwaway in-memory database.
 *
 * Statically importing `auditLog.js` at the top of a server test file is safe —
 * and asserting that is part of the point. `db.js` opens its database at module
 * scope, so a static import that reaches it binds the suite to the repo-local
 * database (docs/ENGINEERING_GUIDE.md). This module imports `node:crypto` and nothing else,
 * which is exactly what lets `db.js` import it during its own initialisation
 * without a cycle, and what lets this file build its own schema in memory.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { recordAudit, recordAuditSync } from './auditLog.js';

let db;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  // The real schema, so a column the helper gets wrong fails here rather than
  // in production. `users` exists because admin_id carries a foreign key.
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE admin_audit_logs (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_user_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(admin_id) REFERENCES users(id) ON DELETE CASCADE
    );
    INSERT INTO users (id) VALUES ('admin-1'), ('user-7');
  `);
});

const rows = () => db.prepare('SELECT * FROM admin_audit_logs').all();

describe('recordAudit — writes a complete row', () => {
  it('stores every field it was given', async () => {
    const { id, createdAt } = await recordAudit(db, {
      adminId: 'admin-1',
      action: 'APPROVE_ORGANIZER',
      targetUserId: 'user-7',
      details: 'Approved after review'
    });

    const all = rows();
    expect(all.length).toBe(1);
    expect(all[0]).toMatchObject({
      id,
      admin_id: 'admin-1',
      action: 'APPROVE_ORGANIZER',
      target_user_id: 'user-7',
      details: 'Approved after review',
      created_at: createdAt
    });
  });

  it('accepts null for the two nullable columns, and only those', async () => {
    await recordAudit(db, { adminId: 'admin-1', action: 'SOMETHING_HAPPENED' });
    const [row] = rows();
    expect(row.target_user_id).toBeNull();
    expect(row.details).toBeNull();
  });

  /**
   * The id is a UUID because a timestamp id already caused an outage:
   * "two deletions in the same millisecond collided on this PRIMARY KEY, which
   * rolled the transaction back and failed the whole deletion with a 500 for
   * both people" (accountRoutes.js). Four of the eight converted call sites were
   * still generating `Date.now()` ids. Writing in a tight loop is the closest a
   * test gets to that millisecond.
   */
  it('does not collide when called repeatedly in the same millisecond', async () => {
    for (let i = 0; i < 200; i++) {
      await recordAudit(db, { adminId: 'admin-1', action: 'BULK' });
    }
    expect(rows().length).toBe(200);
    expect(new Set(rows().map(r => r.id)).size).toBe(200);
  });

  it('stamps an ISO-8601 UTC timestamp, not SQLite\'s space-separated form', async () => {
    const { createdAt } = await recordAudit(db, { adminId: 'admin-1', action: 'X' });
    // TD-10: `ORDER BY created_at` is a string comparison, and the two formats
    // do not sort together.
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(Number.isNaN(Date.parse(createdAt))).toBe(false);
  });
});

describe('recordAudit — refuses what would lose a record', () => {
  it('rejects when adminId is missing, blank, or not a string', async () => {
    for (const bad of [undefined, null, '', '   ', 42, {}, []]) {
      await expect(recordAudit(db, { adminId: bad, action: 'X' }),
        `adminId ${JSON.stringify(bad)} was accepted`
      ).rejects.toThrow(/adminId is required/);
    }
    expect(rows().length).toBe(0);
  });

  it('rejects when action is missing or blank', async () => {
    for (const bad of [undefined, null, '', '  ', 7]) {
      await expect(recordAudit(db, { adminId: 'admin-1', action: bad }))
        .rejects.toThrow(/action is required/);
    }
    expect(rows().length).toBe(0);
  });

  /**
   * The structural half of "no caller-controlled audit structure". The table has
   * six columns and no severity concept; a dropped field is discovered when
   * someone goes looking for data that was never stored.
   */
  it('rejects a field the table cannot hold, naming it', async () => {
    await expect(recordAudit(db, {
      adminId: 'admin-1', action: 'X', severity: 'high'
    })).rejects.toThrow(/unknown field\(s\) severity/);

    await expect(recordAudit(db, {
      adminId: 'admin-1', action: 'X', ip: '1.2.3.4', body: '{}'
    })).rejects.toThrow(/unknown field\(s\) ip, body/);

    expect(rows().length).toBe(0);
  });

  it('rejects a non-string targetUserId or details rather than coercing', async () => {
    await expect(recordAudit(db, { adminId: 'admin-1', action: 'X', targetUserId: 12 }))
      .rejects.toThrow(/targetUserId must be a string or null/);
    await expect(recordAudit(db, { adminId: 'admin-1', action: 'X', details: { a: 1 } }))
      .rejects.toThrow(/details must be a string or null/);
    expect(rows().length).toBe(0);
  });

  it('rejects without a usable database handle, and on a non-object entry', async () => {
    await expect(recordAudit(null, { adminId: 'a', action: 'X' })).rejects.toThrow(/database handle/);
    await expect(recordAudit({}, { adminId: 'a', action: 'X' })).rejects.toThrow(/database handle/);
    await expect(recordAudit(db, null)).rejects.toThrow(/entry object/);
    await expect(recordAudit(db, 'nope')).rejects.toThrow(/entry object/);
    await expect(recordAudit(db, [])).rejects.toThrow(/entry object/);
  });
});

describe('recordAudit — a database failure reaches the caller', () => {
  /**
   * The single most important property here. Every call site but one runs inside
   * a transaction, and an audit row that fails must take the thing it was
   * recording down with it: a deletion that succeeds while its audit row
   * silently vanishes is invisible, where a failed deletion is a bug report.
   */
  it('propagates a throwing prepare instead of swallowing it', async () => {
    const hostile = { prepare: () => { throw new Error('database is locked'); } };
    await expect(recordAudit(hostile, { adminId: 'admin-1', action: 'X' }))
      .rejects.toThrow(/database is locked/);
  });

  it('propagates a throwing run', async () => {
    const hostile = { prepare: () => ({ run: () => { throw new Error('disk I/O error'); } }) };
    await expect(recordAudit(hostile, { adminId: 'admin-1', action: 'X' }))
      .rejects.toThrow(/disk I\/O error/);
  });

  /**
   * A rejected `.run()` — the PostgreSQL shape, where the failure arrives on the
   * promise rather than as a throw. Without awaiting the INSERT, `recordAudit`
   * would resolve and the caller's transaction would commit over a write that
   * never landed, which is the exact defect the await exists to prevent.
   */
  it('propagates a REJECTING run, which is how PostgreSQL fails', async () => {
    const hostile = {
      prepare: () => ({ run: () => Promise.reject(new Error('deadlock detected')) }),
    };
    await expect(recordAudit(hostile, { adminId: 'admin-1', action: 'X' }))
      .rejects.toThrow(/deadlock detected/);
  });

  it('propagates a real constraint violation — an actor who does not exist', async () => {
    db.exec('PRAGMA foreign_keys = ON');
    await expect(recordAudit(db, { adminId: 'nobody-at-all', action: 'X' })).rejects.toThrow();
    expect(rows().length).toBe(0);
  });
});

/**
 * The synchronous twin, which exists for exactly one caller.
 *
 * `db.js`'s username dedupe runs inside `initDatabase()` — synchronous, and
 * called synchronously from `server.js`, the `bin/` scripts and some forty test
 * files. It cannot await, and dropping an unawaited promise there would turn a
 * failed audit write into an unhandled rejection delivered after the dedupe had
 * already committed its renames.
 */
describe('recordAuditSync — the same write, for the boot path that cannot await', () => {
  it('writes the same row the async writer does', () => {
    const { id, createdAt } = recordAuditSync(db, {
      adminId: 'admin-1',
      action: 'USERNAME_DEDUPED',
      targetUserId: 'user-7',
      details: 'renamed',
    });

    expect(rows()).toEqual([{
      id,
      admin_id: 'admin-1',
      action: 'USERNAME_DEDUPED',
      target_user_id: 'user-7',
      details: 'renamed',
      created_at: createdAt,
    }]);
  });

  /**
   * The property the boot path depends on. If this ever returns a promise
   * instead of throwing, the dedupe commits renames whose audit rows failed.
   */
  it('throws SYNCHRONOUSLY rather than returning a rejected promise', () => {
    db.exec('PRAGMA foreign_keys = ON');
    expect(() => recordAuditSync(db, { adminId: 'nobody-at-all', action: 'X' })).toThrow();
    expect(() => recordAuditSync(db, { adminId: 'admin-1', action: '' })).toThrow(/action is required/);
    expect(rows().length).toBe(0);
  });

  it('does not return a thenable, so a caller cannot accidentally await work that already happened', () => {
    const result = recordAuditSync(db, { adminId: 'admin-1', action: 'X' });
    expect(typeof result.then).toBe('undefined');
  });

  it('shares its validation with recordAudit rather than reimplementing it', async () => {
    /* Same message from both writers for the same mistake. A divergence here is
       the drift the shared core exists to make impossible. */
    const bad = { adminId: 'admin-1', action: 'X', severity: 'high' };
    const sync = (() => { try { recordAuditSync(db, bad); } catch (e) { return e.message; } })();
    const async_ = await recordAudit(db, bad).catch(e => e.message);
    expect(sync).toBe(async_);
    expect(sync).toMatch(/unknown field\(s\) severity/);
  });

  /**
   * Held to its one caller by name.
   *
   * The sync writer drops the promise a PostgreSQL `.run()` returns, so a second
   * caller would write nothing at all against the pooled engine and pass every
   * SQLite test while doing it. It is exported only because `db.js` cannot reach
   * a module-private function, not because it is available.
   */
  it('is called from db.js and nowhere else', () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const repo = path.dirname(root);
    const helper = path.join(root, 'auditLog.js');
    const self = fileURLToPath(import.meta.url);

    const scan = (dir, out = []) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'scratch') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) scan(full, out);
        else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
      }
      return out;
    };

    const callers = [];
    for (const file of [...scan(root), ...scan(path.join(repo, 'bin'))]) {
      if (file === helper || file === self) continue;
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/\brecordAuditSync\s*\(/.test(src)) callers.push(path.relative(repo, file));
    }

    expect(
      callers,
      'recordAuditSync drops the promise a PostgreSQL .run() returns, so anything '
      + 'but the SQLite boot path must call the async recordAudit instead.'
    ).toEqual([path.join('server', 'db.js')]);
  });
});

describe('the helper is the only writer', () => {
  /**
   * The acceptance criterion from the plan, asserted rather than run by hand:
   * `grep -rn "INSERT INTO admin_audit_logs" server bin` must return only this
   * module. A ninth raw INSERT added later is the exact regression this task
   * exists to prevent, and it would otherwise pass every other test in the repo.
   */
  it('has no raw INSERT INTO admin_audit_logs left anywhere in server/ or bin/', () => {
    // Walked with fs rather than shelled out to grep: this repository's path
    // contains spaces, and the three src/ guards read files directly for the
    // same reason. A guard that depends on a shell is a guard that can fail for
    // reasons unrelated to what it checks.
    const scan = (dir, out = []) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'scratch') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) scan(full, out);
        else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
      }
      return out;
    };

    const root = path.dirname(fileURLToPath(import.meta.url));
    const repo = path.dirname(root);
    const helper = path.join(root, 'auditLog.js');
    const self = fileURLToPath(import.meta.url);

    /**
     * Comments are stripped before the scan, so PROSE about this rule cannot
     * trip it.
     *
     * The check was a raw `includes()` over the whole file, which meant a
     * comment explaining why a module does not write audit rows directly was
     * counted as a module that does. That is not hypothetical — it fired on a
     * fixture generator whose comment quoted the rule in order to explain
     * obeying it, and the tempting "fix" is to reword the comment, which
     * degrades the explanation to satisfy the measurement.
     *
     * Stripping comments creates no hole: a real INSERT is code, and code
     * survives. String literals are deliberately NOT stripped — the statement
     * this looks for lives inside one.
     */
    const withoutComments = (src) => src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => p1);

    const offenders = [];
    for (const file of [...scan(root), ...scan(path.join(repo, 'bin'))]) {
      if (file === helper || file === self) continue;
      const src = withoutComments(readFileSync(file, 'utf8'));
      if (src.includes('INSERT INTO admin_audit_logs')) {
        offenders.push(path.relative(repo, file));
      }
    }

    expect(
      offenders,
      'raw admin_audit_logs INSERT(s) outside the helper — use await recordAudit() so the '
      + 'actor check, the UUID id and the error propagation apply'
    ).toEqual([]);
  });

  it('imports nothing that could reach db.js', () => {
    const src = readFileSync(new URL('./auditLog.js', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map(m => m[1]);
    // A relative import would let this module reach db.js and destroy the
    // property that lets db.js import IT during initialisation.
    expect(imports.filter(s => s.startsWith('.'))).toEqual([]);
    expect(imports).toEqual(['crypto']);
  });
});
