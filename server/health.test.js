/**
 * `/health` must be able to detect the failure it is alarmed on.
 *
 * The probe was `db.prepare('SELECT 1').get()` — a read. SQLite serves reads
 * happily from a database it cannot write to, so a full disk or a read-only
 * remount left every mutation returning 500 while `/health` reported
 * `{"status":"ok","database":"connected"}`.
 *
 * That is the specific gap that matters operationally: the runbook's two
 * highest-priority alerts ("Service down", "Database disconnected") both key off
 * this endpoint, so the monitor stays green through exactly the incident it exists
 * to catch. Disk exhaustion on the volume holding a school's service-hour records
 * is not a hypothetical.
 *
 * Cost is a real constraint here — a load balancer polls this every few seconds —
 * so the write probe must not accumulate rows or fsync a real table. The
 * implementation uses a scratch value inside a transaction that is always rolled
 * back; these tests pin both the detection and the no-side-effects property.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import request from 'supertest';

let dir;

async function freshApp() {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-health-'));
  process.env.WEV_DB_PATH = path.join(dir, 'health.db');
  process.env.JWT_SECRET = 'x'.repeat(48);
  delete process.env.NODE_ENV;

  vi.resetModules();
  const dbMod = await import('./db.js');
  dbMod.initDatabase();
  const { app } = await import('./app.js');
  return { app, db: dbMod.db };
}

beforeEach(() => { dir = null; });
afterEach(() => {
  if (dir) {
    try { chmodSync(dir, 0o755); } catch { /* already writable */ }
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('/health on a healthy database', () => {
  it('reports ok with the version', async () => {
    const { app } = await freshApp();

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('connected');
    expect(res.body.version).toBeTruthy();
  });

  it('reports that the database is writable, not merely readable', async () => {
    const { app } = await freshApp();

    const res = await request(app).get('/health');

    // The distinction the old probe could not make.
    expect(res.body.writable).toBe(true);
  });

  it('leaves no trace behind', async () => {
    const { app, db } = await freshApp();

    const tables = () => db.prepare(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'"
    ).get().c;
    const before = tables();

    // Several polls, as a load balancer would.
    await request(app).get('/health');
    await request(app).get('/health');
    await request(app).get('/health');

    // No scratch table left over, and no row growth anywhere that matters.
    expect(tables()).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS c FROM users').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM notifications').get().c).toBe(0);
  });

  it('stays cheap enough to poll', async () => {
    const { app } = await freshApp();

    const started = Date.now();
    for (let i = 0; i < 20; i++) await request(app).get('/health');
    const perCall = (Date.now() - started) / 20;

    // Generous bound — this is a smoke check against something pathological like a
    // per-call fsync or a full table scan, not a benchmark.
    expect(perCall, `${perCall}ms per /health call is too slow to poll`).toBeLessThan(50);
  });
});

describe('/health on a database that cannot be written', () => {
  it('reports unhealthy when writes fail but reads still work', async () => {
    const { app, db } = await freshApp();

    /**
     * Simulates the real incident — a full disk or a read-only remount — at the
     * layer that matters. Reads keep succeeding; only the write fails.
     *
     * Faked rather than produced with a genuinely read-only file because the
     * connection is already open: `node:sqlite` needs write access at open time to
     * set `journal_mode = WAL`, so a chmod-based version fails at import instead of
     * at probe time and would test the boot path rather than this one.
     *
     * `exec` is the method to intercept, not `prepare` — SQLite's PRAGMA statements
     * do not accept bind parameters, so the write probe issues
     * `db.exec('PRAGMA user_version = N')`. An earlier version of this test spied
     * only on `prepare`, so the write sailed through and the endpoint correctly
     * reported healthy; the test was wrong, not the code.
     */
    const realExec = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (/PRAGMA user_version\s*=/i.test(sql)) {
        throw new Error('attempt to write a readonly database');
      }
      return realExec(sql);
    });

    const res = await request(app).get('/health');

    // The whole point: this must NOT be 200/ok.
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.writable).toBe(false);
  });

  it('still reports unhealthy when the database is entirely unreachable', async () => {
    const { app, db } = await freshApp();

    // Regression guard on the behaviour the endpoint already had.
    vi.spyOn(db, 'prepare').mockImplementation(() => {
      throw new Error('unable to open database file');
    });

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.database).toBe('disconnected');
  });

  it('names the failure without leaking the database path', async () => {
    const { app, db } = await freshApp();

    vi.spyOn(db, 'prepare').mockImplementation(() => {
      throw new Error(`unable to open database file: ${process.env.WEV_DB_PATH}`);
    });

    const res = await request(app).get('/health');
    const body = JSON.stringify(res.body);

    // /health is unauthenticated, so it must not become a filesystem oracle.
    expect(body).not.toContain(process.env.WEV_DB_PATH);
  });
});

describe('/health remains ahead of the SPA catch-all', () => {
  it('returns JSON rather than index.html', async () => {
    const { app } = await freshApp();

    const res = await request(app).get('/health');

    // A load balancer must never receive HTML here. app.js registers this route
    // before the production static handler specifically to guarantee it.
    expect(res.headers['content-type']).toMatch(/json/);
  });
});
