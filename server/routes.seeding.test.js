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
    const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    db.close();
    rmSync(dir, { recursive: true, force: true });

    expect(count).toBe(0);
  });
});
