import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RUNNING_ON_POSTGRES } from './testEngine.js';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { startTestServer } from './testServer.js';

let srv;
let backupDir;

beforeAll(async () => {
  srv = await startTestServer();
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wevolunteer-backup-test-'));
});

afterAll(async () => {
  await srv.close();
  fs.rmSync(backupDir, { recursive: true, force: true });
});

/**
 * SQLite file-level tooling — its subject does not exist on PostgreSQL.
 *
 * `bin/backup.sh` drives SQLite's ONLINE BACKUP API (`.backup`) against a `.db`
 * file and its `-wal`; `bin/reset-dev-db.mjs` deletes those files. Neither
 * operation has a PostgreSQL meaning: backing up a PostgreSQL deployment is
 * `pg_dump` against a server, which is a different program with a different
 * failure model.
 *
 * Recorded as a genuine gap rather than hidden: the PostgreSQL backup path has
 * NO equivalent coverage here, and `docs/operations/postgres-cutover-and-rollback.md`
 * is where that procedure lives.
 */
describe.skipIf(RUNNING_ON_POSTGRES)('Backup script verification', () => {
  it('successfully creates a verified backup archive', () => {
    // 1. Run the backup script
    const scriptPath = path.resolve(__dirname, '../bin/backup.sh');
    
    // We pass the active test database as the source and the tmp dir as the destination
    try {
      execSync(`bash "${scriptPath}"`, {
        env: {
          ...process.env,
          WEV_DB_PATH: process.env.WEV_DB_PATH,
          WEV_BACKUP_DIR: backupDir
        }
      });
    } catch (err) {
      console.error('Backup script failed.');
      console.error('stdout:', err.stdout ? err.stdout.toString() : '');
      console.error('stderr:', err.stderr ? err.stderr.toString() : '');
      throw err;
    }

    // 2. Assert a .gz file was created
    const files = fs.readdirSync(backupDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^wevolunteer-.*\.db\.gz$/);

    // 3. Unzip and verify it is a valid SQLite DB with identical data
    const backupGz = path.join(backupDir, files[0]);
    const unzipped = path.join(backupDir, 'unzipped.db');
    execSync(`gunzip -c "${backupGz}" > "${unzipped}"`);
    
    // Test environments use node:sqlite instead of better-sqlite3 in the app now! 
    // Wait, let's look at testServer.js and db.js to see what is used. 
    // db.js uses: import { DatabaseSync } from 'node:sqlite';
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(unzipped);
    try {
      const backupUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
      const { db: originalDb } = require('./db.js');
      const originalUsers = originalDb.prepare('SELECT COUNT(*) as c FROM users').get().c;
      expect(backupUsers).toBe(originalUsers);
      expect(backupUsers).toBeGreaterThan(0); // Make sure it's not empty
    } finally {
      db.close();
    }
  });
});
