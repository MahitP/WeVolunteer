/**
 * Durability cover for the data-export worker.
 *
 * Two defects, both of which surface as "the student cannot get their data":
 *
 * 1. EXPORTS WERE WRITTEN TO `os.tmpdir()`.
 *    `deploy/wevolunteer.service` sets `PrivateTmp=true`, which gives the unit a
 *    private `/tmp` on a tmpfs that systemd destroys and recreates on restart. The
 *    job row meanwhile keeps `status = 'completed'` and a `file_location` for a
 *    seven-day expiry window. So after any restart the record insists the export is
 *    ready while the file is gone, and the student gets
 *    "Export file is missing from server".
 *
 *    Even without PrivateTmp this is wrong: `/tmp` is cleaned on reboot on most
 *    distributions, and a seven-day promise cannot be kept from a directory with
 *    no such guarantee.
 *
 * 2. A JOB STRANDED IN `processing` LOCKED THE FEATURE OUT PERMANENTLY.
 *    `POST /api/privacy/export` refuses when a job exists with
 *    `status IN ('pending','processing')`. Nothing reclaimed a `processing` row, so
 *    a restart mid-export left that student 409-ing forever with no expiry and no
 *    way to clear it from the UI.
 *
 * This is a data-protection feature — a district's answer to "how does a family
 * get a copy of their child's record" — so a silent permanent failure is not a
 * cosmetic problem.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let dir;

async function freshExportWorker({ exportDir } = {}) {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-export-'));
  process.env.WEV_DB_PATH = path.join(dir, 'export.db');
  process.env.JWT_SECRET = 'x'.repeat(48);
  if (exportDir) process.env.WEV_EXPORT_DIR = exportDir;
  else delete process.env.WEV_EXPORT_DIR;
  delete process.env.NODE_ENV;

  vi.resetModules();
  const dbMod = await import('./db.js');
  dbMod.initDatabase();
  const worker = await import('./workers/exportWorker.js');
  return { db: dbMod.db, worker, root: dir };
}

/**
 * A user to own the export, since data_export_jobs has an FK to users.
 *
 * `grade` is NOT NULL in the schema, which the first version of this helper
 * omitted — the resulting "NOT NULL constraint failed: users.grade" surfaced as
 * seven unrelated-looking failures.
 */
function makeUser(db, id = 'u-export') {
  db.prepare(`
    INSERT INTO users (id, username, email, password_hash, name, grade, role, created_at)
    VALUES (?, ?, ?, 'x', 'Export Tester', '11', 'student', ?)
  `).run(id, id, `${id}@example.org`, new Date().toISOString());
  return id;
}

function queueExport(db, { id, userId, status = 'pending', createdAt = null }) {
  db.prepare(`
    INSERT INTO data_export_jobs (id, user_id, status, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, userId, status, createdAt ?? new Date().toISOString());
}

beforeEach(() => { dir = null; });
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env.WEV_EXPORT_DIR;
  vi.restoreAllMocks();
});

describe('exports are written to durable storage, not tmpdir', () => {
  it('does not resolve to the OS temp directory itself', async () => {
    const { worker, root } = await freshExportWorker();

    const resolved = worker.resolveExportDir();

    /**
     * The precise defect: `path.join(os.tmpdir(), …)`, which systemd's
     * `PrivateTmp=true` destroys on restart while the job row still claims the
     * file exists for seven days.
     *
     * The assertion is "not tmpdir itself, and derived from the database location"
     * rather than "not anywhere under tmpdir" — an earlier version asserted the
     * latter and was simply wrong, because this test's own database is created in
     * a temp directory, so deriving from it correctly yields a path under tmpdir.
     * What matters is that the location follows the database (which the deployment
     * puts on durable storage at /var/lib/wevolunteer), not the temp root.
     */
    expect(resolved).not.toBe(tmpdir());
    expect(resolved.startsWith(root), 'export dir is not derived from the database location').toBe(true);
  });

  it('defaults to a directory beside the database, which the service unit can write', async () => {
    const { worker, root } = await freshExportWorker();

    // deploy/wevolunteer.service grants ReadWritePaths=/var/lib/wevolunteer, and
    // WEV_DB_PATH lives there, so co-locating needs no new systemd permission.
    expect(worker.resolveExportDir()).toBe(path.join(root, 'exports'));
  });

  it('honours an explicit WEV_EXPORT_DIR override', async () => {
    const override = mkdtempSync(path.join(tmpdir(), 'wev-export-override-'));
    const { worker } = await freshExportWorker({ exportDir: override });

    expect(worker.resolveExportDir()).toBe(override);
    rmSync(override, { recursive: true, force: true });
  });

  it('writes a completed export into that directory and records the path', async () => {
    const { db, worker, root } = await freshExportWorker();
    const userId = makeUser(db);
    queueExport(db, { id: 'exp-1', userId });

    await worker.processPendingExports();

    const row = db.prepare('SELECT status, file_location FROM data_export_jobs WHERE id = ?').get('exp-1');
    expect(row.status).toBe('completed');
    expect(row.file_location).toContain(path.join(root, 'exports'));
    expect(existsSync(row.file_location), 'export file was not written').toBe(true);
  });

  it('a completed export survives a simulated restart', async () => {
    const { db, worker, root } = await freshExportWorker();
    const userId = makeUser(db);
    queueExport(db, { id: 'exp-restart', userId });

    await worker.processPendingExports();
    const before = db.prepare('SELECT file_location FROM data_export_jobs WHERE id = ?').get('exp-restart');

    // A restart wipes PrivateTmp but not the database directory. The file has to
    // still be there, because the row still promises it for seven days.
    expect(existsSync(before.file_location)).toBe(true);

    // Co-located with the database, which is on durable storage in the deployment
    // (/var/lib/wevolunteer) rather than on the tmpfs PrivateTmp provides.
    expect(before.file_location.startsWith(root)).toBe(true);

    // Re-importing the worker is the closest in-process stand-in for a restart:
    // module state is rebuilt from scratch and must still find the same file.
    vi.resetModules();
    const reborn = await import('./workers/exportWorker.js');
    const stillThere = db.prepare('SELECT file_location FROM data_export_jobs WHERE id = ?').get('exp-restart');
    expect(reborn.resolveExportDir()).toBe(path.dirname(stillThere.file_location));
    expect(existsSync(stillThere.file_location)).toBe(true);
  });
});

describe('stranded export jobs are reclaimed', () => {
  it('reclaims a job left in processing by a restart', async () => {
    const { db, worker } = await freshExportWorker();
    const userId = makeUser(db);
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    queueExport(db, { id: 'exp-stuck', userId, status: 'processing', createdAt: longAgo });

    const reclaimed = worker.reclaimStaleExports();

    expect(reclaimed).toBe(1);
    const row = db.prepare('SELECT status FROM data_export_jobs WHERE id = ?').get('exp-stuck');
    // Back to pending so it runs, rather than blocking the user forever.
    expect(row.status).toBe('pending');
  });

  it('leaves a genuinely running export alone', async () => {
    const { db, worker } = await freshExportWorker();
    const userId = makeUser(db);
    queueExport(db, { id: 'exp-now', userId, status: 'processing' });

    expect(worker.reclaimStaleExports()).toBe(0);
    const row = db.prepare('SELECT status FROM data_export_jobs WHERE id = ?').get('exp-now');
    expect(row.status).toBe('processing');
  });

  it('unblocks a user who was permanently 409-ed', async () => {
    const { db, worker } = await freshExportWorker();
    const userId = makeUser(db);
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    queueExport(db, { id: 'exp-block', userId, status: 'processing', createdAt: longAgo });

    // This is the query POST /api/privacy/export uses to refuse a new request.
    const blockedBefore = db.prepare(
      "SELECT id FROM data_export_jobs WHERE user_id = ? AND status IN ('pending','processing')"
    ).get(userId);
    expect(blockedBefore).toBeTruthy();

    worker.reclaimStaleExports();
    await worker.processPendingExports();

    const blockedAfter = db.prepare(
      "SELECT id FROM data_export_jobs WHERE user_id = ? AND status IN ('pending','processing')"
    ).get(userId);
    // The job ran to completion, so the user can request another export.
    expect(blockedAfter).toBeFalsy();
  });
});

describe('cleanup still happens', () => {
  it('deletes the file and clears the path when an export expires', async () => {
    const { db, worker, root } = await freshExportWorker();
    const userId = makeUser(db);
    queueExport(db, { id: 'exp-expire', userId });

    await worker.processPendingExports();
    const row = db.prepare('SELECT file_location FROM data_export_jobs WHERE id = ?').get('exp-expire');
    expect(existsSync(row.file_location)).toBe(true);

    // Backdate the expiry rather than waiting seven days.
    db.prepare("UPDATE data_export_jobs SET expires_at = datetime('now','-1 day') WHERE id = ?")
      .run('exp-expire');

    worker.cleanupExpiredExports();

    const after = db.prepare('SELECT status, file_location FROM data_export_jobs WHERE id = ?').get('exp-expire');
    expect(after.status).toBe('expired');
    expect(after.file_location).toBeNull();
    expect(existsSync(row.file_location), 'expired export file was left on disk').toBe(false);
    // And the directory is not accumulating orphans.
    expect(readdirSync(path.join(root, 'exports'))).toHaveLength(0);
  });
});
