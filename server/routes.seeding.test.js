import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Seeding is a demo affordance. A production database must come up empty, so
 * that no account exists with a password published in the README.
 */
describe('demo seeding is gated on DEMO_MODE', () => {
  it('does not seed when DEMO_MODE is off', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-seed-'));
    const dbFile = path.join(dir, 'prod.db');

    const { execFileSync } = await import('child_process');
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      process.env.WEV_DB_PATH = ${JSON.stringify(dbFile)};
      process.env.JWT_SECRET = 'test';
      delete process.env.DEMO_MODE;
      const { initDatabase } = await import('${process.cwd().replace(/\\/g, '/')}/server/db.js');
      initDatabase();
    `], { cwd: process.cwd(), stdio: 'pipe' });

    const db = new DatabaseSync(dbFile);
    /**
     * Excludes the reserved `system-cli` row.
     *
     * That account is seeded by migration 022 in EVERY environment, and
     * deliberately so: production is exactly where a privileged command-line
     * action happens and needs an actor to be recorded against. It is not demo
     * data — it cannot be signed into, holds no capabilities, and exists only to
     * be pointed at by an audit row.
     *
     * This test is about demo data not leaking into a non-demo database, so it
     * counts the rows that could be demo data. Asserting a bare zero made it a
     * statement about how many rows migrations create, which is a different
     * claim and one that fails for a correct reason.
     */
    const count = db.prepare(
      "SELECT COUNT(*) AS c FROM users WHERE id != 'system-cli'"
    ).get().c;
    db.close();
    rmSync(dir, { recursive: true, force: true });

    expect(count).toBe(0);
  });
});
