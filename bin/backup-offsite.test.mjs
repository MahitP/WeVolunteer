import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { startFakeB2 } from './lib/fake-b2.mjs';

/**
 * The off-site copy and its recovery path, run as the real processes against a
 * server that refuses what B2 refuses.
 *
 * Processes rather than imported functions because the exit code IS the
 * interface: bin/backup-postgres.sh prunes only when it is 0. And asynchronous
 * spawns, because the fake B2 lives in this process — a synchronous spawn would
 * block the event loop that has to answer the child's requests.
 *
 * Every failure case also asserts what did NOT happen (no PUT, no file left
 * behind, the last verified record preserved), because a failure that reports
 * correctly while having already uploaded is still a defect.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const OFFSITE = path.join(ROOT, 'bin/backup-offsite.mjs');
const FETCH = path.join(ROOT, 'bin/backup-fetch.mjs');
const NAME = 'wevolunteer-20260913T030356Z';

function run(script, args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH, WEV_OFFSITE_RETRY_BASE_MS: '5', ...env },
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr, out: stdout + stderr });
    });
  });
}

function makeArchive(dir, name = NAME, { bytes = 4096, manifestSha } = {}) {
  const archive = randomBytes(bytes);
  const sha = createHash('sha256').update(archive).digest('hex');
  const archivePath = path.join(dir, `${name}.dump.enc`);
  const manifestPath = path.join(dir, `${name}.manifest.json`);
  writeFileSync(archivePath, archive);
  writeFileSync(manifestPath, JSON.stringify({
    format_version: 2, created_utc: name.slice(12), archive: path.basename(archivePath), archive_bytes: bytes,
    archive_sha256: manifestSha ?? sha, encryption: 'cms-authenveloped-aes-256-gcm-rsa-oaep',
    migration_version: 67, invariants: { users: 3, credited_hours: 4.5, certificates: 1, hours_ledger: 2 },
  }, null, 2));
  return { archive, sha, archivePath, manifestPath };
}

describe('bin/backup-offsite.mjs', () => {
  let fake;
  let work;
  let statusDir;
  const status = () => JSON.parse(readFileSync(path.join(statusDir, 'offsite.json'), 'utf8'));
  const env = (extra = {}) => ({ ...fake.env, WEV_BACKUP_STATUS_DIR: statusDir, ...extra });
  const puts = () => fake.state.requests.filter((r) => r.method === 'PUT');
  const secret = () => fake.env.B2_APPLICATION_KEY;

  beforeAll(async () => { fake = await startFakeB2(); });
  afterAll(() => fake.close());
  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'wev-offsite-'));
    statusDir = path.join(work, 'status');
    fake.state.objects.clear();
    fake.state.requests.length = 0;
    fake.state.faults.length = 0;
    fake.state.corruptNextGet = false;
    fake.state.lockDays = 7;
    fake.state.capabilities = new Set(['listBuckets', 'writeFiles', 'readFiles', 'listFiles', 'readFileRetentions']);
    return () => rmSync(work, { recursive: true, force: true });
  });

  it('with nothing configured: exits 0, says so, records "unconfigured", contacts nobody', async () => {
    const a = makeArchive(work);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], { WEV_BACKUP_STATUS_DIR: statusDir });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/exists only on this host/);
    expect(status().state).toBe('unconfigured');
    expect(fake.state.requests).toHaveLength(0);
  });

  it('a partial configuration fails, names the missing variable, and leaks no value', async () => {
    const a = makeArchive(work);
    const partial = { ...env() };
    delete partial.B2_BUCKET;
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], partial);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/missing B2_BUCKET/);
    expect(r.out).not.toContain(secret());
    expect(status()).toMatchObject({ state: 'failed', stage: 'configuration' });
  });

  it('uploads, HEAD-verifies, download-verifies, observes the lock and audits retention', async () => {
    const a = makeArchive(work);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env());
    expect(r.code, r.out).toBe(0);

    const key = `wevolunteer/postgres/daily/2026/09/13/${NAME}.dump.enc`;
    const stored = fake.state.objects.get(key);
    expect(stored).toHaveLength(1);
    expect(Buffer.compare(stored[0].body, a.archive)).toBe(0);
    expect(stored[0].meta['x-amz-meta-sha256']).toBe(a.sha);
    expect(fake.state.objects.has(`wevolunteer/postgres/daily/2026/09/13/${NAME}.manifest.json`)).toBe(true);

    const s = status();
    expect(s.state).toBe('verified');
    expect(s.levels).toEqual({ uploaded: true, headVerified: true, downloadVerified: true });
    expect(s.sha256).toBe(a.sha);
    expect(s.lock).toMatchObject({ mode: 'GOVERNANCE' });
    expect(s.lock.days).toBeGreaterThanOrEqual(6.9);
    expect(s.audit).toMatchObject({ objects: 2, archives: 1, noncurrent: 0, deleteMarkers: 0, uploadsLast24h: 1 });
    expect(s.warnings).toEqual([]);
    expect(s.lastVerified).toMatchObject({ archive: `${NAME}.dump.enc`, sha256: a.sha });

    // The download really happened — a verifier that skipped it would still pass
    // every assertion above.
    expect(fake.state.requests.some((q) => q.method === 'GET' && q.path.endsWith(`${NAME}.dump.enc`))).toBe(true);

    // No credential anywhere the operator or the application can read.
    expect(r.out).not.toContain(secret());
    expect(JSON.stringify(s)).not.toContain(secret());
    expect(JSON.stringify(s)).not.toContain(fake.env.B2_KEY_ID);
    expect((statSync(path.join(statusDir, 'offsite.json')).mode & 0o777).toString(8)).toBe('640');
  });

  it('is idempotent: a re-run of the same archive adds no version', async () => {
    const a = makeArchive(work);
    expect((await run(OFFSITE, [a.archivePath, a.manifestPath], env())).code).toBe(0);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/already present, identical/);
    expect(puts()).toHaveLength(2);
    expect(fake.state.objects.get(`wevolunteer/postgres/daily/2026/09/13/${NAME}.dump.enc`)).toHaveLength(1);
  });

  it('refuses to add a second, different version under an existing name — and keeps lastVerified', async () => {
    const first = makeArchive(work);
    expect((await run(OFFSITE, [first.archivePath, first.manifestPath], env())).code).toBe(0);
    const other = makeArchive(work); // same name, different bytes
    const r = await run(OFFSITE, [other.archivePath, other.manifestPath], env());
    expect(r.code).toBe(1);
    expect(status()).toMatchObject({ state: 'failed', stage: 'collision' });
    expect(status().lastVerified.sha256).toBe(first.sha);
    expect(puts()).toHaveLength(2);
  });

  it('refuses a plaintext archive before contacting B2', async () => {
    const plain = path.join(work, `${NAME}.dump`);
    writeFileSync(plain, 'PGDMP plaintext');
    const a = makeArchive(work);
    const r = await run(OFFSITE, [plain, a.manifestPath], env());
    expect(r.code).toBe(1);
    expect(status().stage).toBe('refused-plaintext');
    expect(fake.state.requests).toHaveLength(0);
  });

  it('refuses an archive that no longer matches its manifest, before uploading', async () => {
    const a = makeArchive(work, NAME, { manifestSha: 'a'.repeat(64) });
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env());
    expect(r.code).toBe(1);
    expect(status().stage).toBe('local-integrity');
    expect(puts()).toHaveLength(0);
  });

  it('refuses an archive over the size cap, before uploading', async () => {
    const a = makeArchive(work);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env({ WEV_OFFSITE_MAX_BYTES: '1000' }));
    expect(r.code).toBe(1);
    expect(status().stage).toBe('size-cap');
    expect(puts()).toHaveLength(0);
  });

  it('recovers from a transient 503 on upload', async () => {
    fake.state.faults.push({ match: (q) => q.method === 'PUT', status: 503 });
    const a = makeArchive(work);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/retrying PUT/);
    expect(status().state).toBe('verified');
  });

  it('fails, bounded, when B2 stays unavailable', async () => {
    fake.state.faults.push({ match: (q) => q.method === 'PUT', status: 503, persistent: true });
    const a = makeArchive(work);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env());
    expect(r.code).toBe(1);
    expect(status()).toMatchObject({ state: 'failed', stage: 'upload' });
    expect(puts()).toHaveLength(4);
  });

  it('fails when the downloaded copy does not match — the copy is not a copy', async () => {
    fake.state.corruptNextGet = true;
    const a = makeArchive(work);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env());
    expect(r.code).toBe(1);
    expect(status().stage).toBe('download-verify');
  });

  it('notices when the object B2 holds under the name is not the local archive', async () => {
    const a = makeArchive(work);
    const r0 = await run(OFFSITE, [a.archivePath, a.manifestPath], env());
    expect(r0.code).toBe(0);
    // Tamper with what B2 holds; a re-run must notice rather than call it identical.
    const stored = fake.state.objects.get(`wevolunteer/postgres/daily/2026/09/13/${NAME}.dump.enc`)[0];
    stored.meta['x-amz-meta-sha256'] = 'b'.repeat(64);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env());
    expect(r.code).toBe(1);
    expect(status().stage).toBe('collision');
  });

  it('a wrong application key fails at once — no retries — and the key is not printed', async () => {
    const a = makeArchive(work);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env({ B2_APPLICATION_KEY: 'definitely-the-wrong-key' }));
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('definitely-the-wrong-key');
    expect(r.out).not.toMatch(/retrying/);
    expect(status().error).toMatch(/403|SignatureDoesNotMatch/);
  });

  it('a wrong region fails', async () => {
    const a = makeArchive(work);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env({ B2_REGION: 'eu-central-003' }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/SignatureDoesNotMatch/);
  });

  it('a key that cannot read cannot verify, and so fails rather than reporting an unverified upload', async () => {
    fake.state.capabilities.delete('readFiles');
    const a = makeArchive(work);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env());
    expect(r.code).toBe(1);
    expect(status().state).toBe('failed');
  });

  it('the frequency guard stops a job running in a loop; WEV_OFFSITE_FORCE=1 allows one deliberate run', async () => {
    for (let i = 0; i < 4; i++) {
      const name = `wevolunteer-20260913T0${i}0000Z`;
      const a = makeArchive(work, name);
      expect((await run(OFFSITE, [a.archivePath, a.manifestPath], env())).code).toBe(0);
    }
    const fifth = makeArchive(work, 'wevolunteer-20260913T050000Z');
    const r = await run(OFFSITE, [fifth.archivePath, fifth.manifestPath], env());
    expect(r.code).toBe(1);
    expect(status().stage).toBe('frequency-guard');
    expect(puts()).toHaveLength(8);

    const forced = await run(OFFSITE, [fifth.archivePath, fifth.manifestPath], env({ WEV_OFFSITE_FORCE: '1' }));
    expect(forced.code, forced.out).toBe(0);
  });

  it('warns — without failing the backup — when something outlives the retention window', async () => {
    const old = makeArchive(work, 'wevolunteer-20260801T030000Z');
    expect((await run(OFFSITE, [old.archivePath, old.manifestPath], env())).code).toBe(0);
    fake.age('wevolunteer/postgres/daily/2026/08/01/wevolunteer-20260801T030000Z.dump.enc', 40);
    const a = makeArchive(work);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env());
    expect(r.code).toBe(0);
    const s = status();
    expect(s.state).toBe('verified');
    expect(s.audit.oldestAgeDays).toBeGreaterThan(39);
    expect(s.warnings.join('\n')).toMatch(/retention-violation/);
  });

  it('the audit counts hidden (noncurrent) versions — they still hold data', async () => {
    const a = makeArchive(work);
    expect((await run(OFFSITE, [a.archivePath, a.manifestPath], env())).code).toBe(0);
    const key = `wevolunteer/postgres/daily/2026/09/13/${NAME}.manifest.json`;
    fake.state.objects.get(key).push({ versionId: 'hide', deleteMarker: true, lastModified: new Date(), body: Buffer.alloc(0) });
    const b = makeArchive(work, 'wevolunteer-20260914T030000Z');
    const r = await run(OFFSITE, [b.archivePath, b.manifestPath], env());
    expect(r.code, r.out).toBe(0);
    expect(status().audit).toMatchObject({ objects: 4, deleteMarkers: 1 });
  });

  /**
   * The lock must be SHORTER than the retention window, and this test used to
   * assert the opposite.
   *
   * It was written on the assumption that a longer lock is a safer lock, so it
   * expected a warning only once the lock exceeded retention + 7 days and treated
   * a 28-day lock beside a 28-day policy as correct. Backblaze's Object Lock
   * documentation says otherwise: "When a file is locked, lifecycle settings or
   * an integration setting attempting to change or delete the file will fail." A
   * lock that reaches the lifecycle window does not protect the archives, it
   * makes them permanent — every expiry is refused, storage grows without bound,
   * and deleted students' records stay off-site for ever. Nothing else in the
   * system would have said so for weeks, until the retention audit noticed
   * objects outliving maxAgeDays.
   */
  it('warns when no Object Lock is observed', async () => {
    fake.state.lockDays = 0;
    const a = makeArchive(work);
    expect((await run(OFFSITE, [a.archivePath, a.manifestPath], env())).code).toBe(0);
    expect(status().warnings.join('\n')).toMatch(/lock-not-observed/);
  });

  it('warns that a lock reaching the retention window stops anything ever expiring', async () => {
    const a = makeArchive(work);
    for (const days of [28, 365]) {
      fake.state.objects.clear();
      fake.state.lockDays = days;
      expect((await run(OFFSITE, [a.archivePath, a.manifestPath], env())).code).toBe(0);
      expect(status().warnings.join('\n')).toMatch(/lock-blocks-expiry/);
    }
  });

  it('warns when the lock is far shorter than the policy expects', async () => {
    fake.state.lockDays = 1;
    const a = makeArchive(work);
    expect((await run(OFFSITE, [a.archivePath, a.manifestPath], env())).code).toBe(0);
    expect(status().warnings.join('\n')).toMatch(/lock-short/);
  });

  it('a key without listFiles still uploads and verifies, and says the audit could not run', async () => {
    fake.state.capabilities.delete('listFiles');
    const a = makeArchive(work);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env());
    expect(r.code, r.out).toBe(0);
    expect(status().warnings.join('\n')).toMatch(/audit-unverifiable/);
    expect(status().audit).toBeNull();
  });

  it('an unwritable status directory does not turn a verified upload into a failed backup', async () => {
    const locked = path.join(work, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    const a = makeArchive(work);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env({ WEV_BACKUP_STATUS_DIR: path.join(locked, 'status') }));
    chmodSync(locked, 0o700);
    if (process.getuid?.() === 0) return; // root ignores the mode; nothing to prove
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/could not record off-site status/);
  });
});

describe('bin/backup-fetch.mjs — the recovery path', () => {
  let fake;
  let work;
  const recoveryCaps = ['readFiles', 'listFiles'];

  beforeAll(async () => { fake = await startFakeB2(); });
  afterAll(() => fake.close());
  beforeEach(async () => {
    work = mkdtempSync(path.join(tmpdir(), 'wev-fetch-'));
    fake.state.objects.clear();
    fake.state.requests.length = 0;
    fake.state.corruptNextGet = false;
    fake.state.capabilities = new Set(['listBuckets', 'writeFiles', 'readFiles', 'listFiles', 'readFileRetentions']);
    for (const name of ['wevolunteer-20260911T030000Z', 'wevolunteer-20260912T030000Z', 'wevolunteer-20260913T030000Z']) {
      const a = makeArchive(work, name);
      const r = await run(OFFSITE, [a.archivePath, a.manifestPath], { ...fake.env, WEV_BACKUP_STATUS_DIR: path.join(work, 'status'), WEV_OFFSITE_FORCE: '1' });
      expect(r.code, r.out).toBe(0);
    }
    return () => rmSync(work, { recursive: true, force: true });
  });

  it('lists what the bucket holds, oldest first', async () => {
    const r = await run(FETCH, ['--list'], fake.env);
    expect(r.code, r.out).toBe(0);
    const names = r.stdout.trim().split('\n').map((l) => l.split('\t')[0]);
    expect(names).toEqual(['wevolunteer-20260911T030000Z.dump.enc', 'wevolunteer-20260912T030000Z.dump.enc', 'wevolunteer-20260913T030000Z.dump.enc']);
  });

  it('fetches the latest with a read-only recovery key, verifies it, and writes it privately', async () => {
    fake.state.capabilities = new Set(recoveryCaps);
    const out = path.join(work, 'recovered');
    const r = await run(FETCH, ['--out', out, '--latest'], fake.env);
    expect(r.code, r.out).toBe(0);
    const archivePath = r.stdout.trim().split('\n').pop();
    expect(path.basename(archivePath)).toBe('wevolunteer-20260913T030000Z.dump.enc');
    const local = readFileSync(archivePath);
    const original = readFileSync(path.join(work, 'wevolunteer-20260913T030000Z.dump.enc'));
    expect(Buffer.compare(local, original)).toBe(0);
    expect(existsSync(path.join(out, 'wevolunteer-20260913T030000Z.manifest.json'))).toBe(true);
    expect((statSync(archivePath).mode & 0o777).toString(8)).toBe('600');
    expect((statSync(out).mode & 0o777).toString(8)).toBe('700');
    expect(r.out).toMatch(/SHA-256 verified against manifest and B2 metadata/);
  });

  it('the recovery key cannot write or delete — least privilege is enforced, not assumed', async () => {
    fake.state.capabilities = new Set(recoveryCaps);
    const a = makeArchive(work, 'wevolunteer-20260914T030000Z');
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], { ...fake.env, WEV_BACKUP_STATUS_DIR: path.join(work, 'status') });
    expect(r.code).toBe(1);
    expect(fake.state.objects.has('wevolunteer/postgres/daily/2026/09/14/wevolunteer-20260914T030000Z.dump.enc')).toBe(false);
  });

  it('refuses a corrupted download and leaves nothing behind', async () => {
    fake.state.corruptNextGet = true;
    const out = path.join(work, 'recovered');
    const r = await run(FETCH, ['--out', out, '--latest'], fake.env);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/does not match the SHA-256/);
    expect(existsSync(path.join(out, 'wevolunteer-20260913T030000Z.dump.enc'))).toBe(false);
  });

  it('refuses an archive whose manifest in the bucket disagrees with it', async () => {
    const key = 'wevolunteer/postgres/daily/2026/09/12/wevolunteer-20260912T030000Z.manifest.json';
    const v = fake.state.objects.get(key)[0];
    const m = JSON.parse(v.body.toString());
    m.archive_sha256 = 'c'.repeat(64);
    v.body = Buffer.from(JSON.stringify(m));
    const r = await run(FETCH, ['--out', path.join(work, 'x'), '--archive', 'wevolunteer-20260912T030000Z.dump.enc'], fake.env);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/manifest/);
  });

  it('says clearly when there is nothing to fetch from', async () => {
    const r = await run(FETCH, ['--list'], {});
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not configured/);
    const missing = await run(FETCH, ['--out', path.join(work, 'x'), '--archive', 'wevolunteer-20200101T000000Z.dump.enc'], fake.env);
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/not in the bucket/);
  });
});
