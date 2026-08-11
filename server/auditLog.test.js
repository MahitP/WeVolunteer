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
import { recordAudit } from './auditLog.js';

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
  it('stores every field it was given', () => {
    const { id, createdAt } = recordAudit(db, {
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

  it('accepts null for the two nullable columns, and only those', () => {
    recordAudit(db, { adminId: 'admin-1', action: 'SOMETHING_HAPPENED' });
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
  it('does not collide when called repeatedly in the same millisecond', () => {
    for (let i = 0; i < 200; i++) {
      recordAudit(db, { adminId: 'admin-1', action: 'BULK' });
    }
    expect(rows().length).toBe(200);
    expect(new Set(rows().map(r => r.id)).size).toBe(200);
  });

  it('stamps an ISO-8601 UTC timestamp, not SQLite\'s space-separated form', () => {
    const { createdAt } = recordAudit(db, { adminId: 'admin-1', action: 'X' });
    // TD-10: `ORDER BY created_at` is a string comparison, and the two formats
    // do not sort together.
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(Number.isNaN(Date.parse(createdAt))).toBe(false);
  });
});

describe('recordAudit — refuses what would lose a record', () => {
  it('throws when adminId is missing, blank, or not a string', () => {
    for (const bad of [undefined, null, '', '   ', 42, {}, []]) {
      expect(
        () => recordAudit(db, { adminId: bad, action: 'X' }),
        `adminId ${JSON.stringify(bad)} was accepted`
      ).toThrow(/adminId is required/);
    }
    expect(rows().length).toBe(0);
  });

  it('throws when action is missing or blank', () => {
    for (const bad of [undefined, null, '', '  ', 7]) {
      expect(() => recordAudit(db, { adminId: 'admin-1', action: bad })).toThrow(/action is required/);
    }
    expect(rows().length).toBe(0);
  });

  /**
   * The structural half of "no caller-controlled audit structure". The table has
   * six columns and no severity concept; a dropped field is discovered when
   * someone goes looking for data that was never stored.
   */
  it('throws on a field the table cannot hold, naming it', () => {
    expect(() => recordAudit(db, {
      adminId: 'admin-1', action: 'X', severity: 'high'
    })).toThrow(/unknown field\(s\) severity/);

    expect(() => recordAudit(db, {
      adminId: 'admin-1', action: 'X', ip: '1.2.3.4', body: '{}'
    })).toThrow(/unknown field\(s\) ip, body/);

    expect(rows().length).toBe(0);
  });

  it('throws on a non-string targetUserId or details rather than coercing', () => {
    expect(() => recordAudit(db, { adminId: 'admin-1', action: 'X', targetUserId: 12 }))
      .toThrow(/targetUserId must be a string or null/);
    expect(() => recordAudit(db, { adminId: 'admin-1', action: 'X', details: { a: 1 } }))
      .toThrow(/details must be a string or null/);
    expect(rows().length).toBe(0);
  });

  it('throws without a usable database handle, and on a non-object entry', () => {
    expect(() => recordAudit(null, { adminId: 'a', action: 'X' })).toThrow(/database handle/);
    expect(() => recordAudit({}, { adminId: 'a', action: 'X' })).toThrow(/database handle/);
    expect(() => recordAudit(db, null)).toThrow(/entry object/);
    expect(() => recordAudit(db, 'nope')).toThrow(/entry object/);
    expect(() => recordAudit(db, [])).toThrow(/entry object/);
  });
});

describe('recordAudit — a database failure reaches the caller', () => {
  /**
   * The single most important property here. Every call site but one runs inside
   * a transaction, and an audit row that fails must take the thing it was
   * recording down with it: a deletion that succeeds while its audit row
   * silently vanishes is invisible, where a failed deletion is a bug report.
   */
  it('propagates a throwing prepare instead of swallowing it', () => {
    const hostile = { prepare: () => { throw new Error('database is locked'); } };
    expect(() => recordAudit(hostile, { adminId: 'admin-1', action: 'X' }))
      .toThrow(/database is locked/);
  });

  it('propagates a throwing run', () => {
    const hostile = { prepare: () => ({ run: () => { throw new Error('disk I/O error'); } }) };
    expect(() => recordAudit(hostile, { adminId: 'admin-1', action: 'X' }))
      .toThrow(/disk I\/O error/);
  });

  it('propagates a real constraint violation — an actor who does not exist', () => {
    db.exec('PRAGMA foreign_keys = ON');
    expect(() => recordAudit(db, { adminId: 'nobody-at-all', action: 'X' })).toThrow();
    expect(rows().length).toBe(0);
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

    const offenders = [];
    for (const file of [...scan(root), ...scan(path.join(repo, 'bin'))]) {
      if (file === helper || file === self) continue;
      const src = readFileSync(file, 'utf8');
      if (src.includes('INSERT INTO admin_audit_logs')) {
        offenders.push(path.relative(repo, file));
      }
    }

    expect(
      offenders,
      'raw admin_audit_logs INSERT(s) outside the helper — use recordAudit() so the '
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
