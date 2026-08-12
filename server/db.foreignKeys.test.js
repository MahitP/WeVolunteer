import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

/**
 * Foreign-key enforcement on the application's own connection.
 *
 * ── Why this test exists ──
 *
 * Enforcement was resting on a `node:sqlite` default that nobody had written
 * down. It is correct — every declared key in this schema is enforced — but the
 * failure mode if it ever changed was silent: no error, no failing test, forty-
 * four tables' cascades simply stop firing and orphans accumulate.
 *
 * `db.js` now passes `enableForeignKeyConstraints: true` explicitly. These
 * assert both halves of why that matters, so the line cannot be removed as
 * redundant.
 */

describe('foreign key enforcement', () => {
  it('is on for a connection built the way db.js builds one', async () => {
    const { db } = await import('./db.js');
    expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
  });

  it('is not merely inherited — the option genuinely controls it', () => {
    /**
     * The half that makes the explicit `true` meaningful rather than
     * decorative. If passing `false` did nothing, the declaration in db.js
     * would be a comment with a syntax, and this would pass for the wrong
     * reason.
     */
    const off = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
    expect(off.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(0);
    off.close();

    const on = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
    expect(on.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    on.close();
  });

  it('actually refuses an orphan, which is the behaviour being bought', () => {
    /* A pragma reading 1 is a claim; this is the claim being cashed. */
    const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
    database.exec(`
      CREATE TABLE parents (id TEXT PRIMARY KEY);
      CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT,
        FOREIGN KEY(parent_id) REFERENCES parents(id) ON DELETE CASCADE);
      INSERT INTO parents (id) VALUES ('p1');
    `);

    expect(() => database.prepare('INSERT INTO children VALUES (?, ?)').run('c1', 'ghost'))
      .toThrow(/FOREIGN KEY/i);

    database.prepare('INSERT INTO children VALUES (?, ?)').run('c1', 'p1');
    database.prepare('DELETE FROM parents WHERE id = ?').run('p1');
    expect(database.prepare('SELECT COUNT(*) AS c FROM children').get().c, 'the cascade should have fired').toBe(0);

    database.close();
  });
});
