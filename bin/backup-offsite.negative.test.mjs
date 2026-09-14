import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { startFakeB2 } from './lib/fake-b2.mjs';
import { b2ConfigFromEnv, storeRequest, putObject, archiveKey, withRetry, ObjectStoreError } from './lib/object-store.mjs';

/**
 * The ways the off-site copy is asked to fail.
 *
 * `backup-offsite.test.mjs` establishes that the happy path works and that the
 * obvious refusals are refused. This file is the adversarial half: what happens
 * when the network dies mid-response, when Backblaze answers with a spending cap
 * rather than a permission error, when the clock is wrong, when a byte changes in
 * flight, when the configuration is malformed in each of the ways a person
 * actually malforms it.
 *
 * Two rules every case here is written against, because they are the two that
 * decide whether a bad night is survivable:
 *
 *   1. A failure must be classified as what it IS. "Access denied" for a breached
 *      spending cap sends an operator to re-issue a key that was never the
 *      problem, and the archives stay un-copied while they do it.
 *   2. A failure must never destroy the last known-good recovery path. Nothing
 *      here may prune, delete, or overwrite a good archive because a new one
 *      went wrong.
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

function makeArchive(dir, name = NAME, { bytes = 4096 } = {}) {
  const archive = randomBytes(bytes);
  const sha = createHash('sha256').update(archive).digest('hex');
  const archivePath = path.join(dir, `${name}.dump.enc`);
  const manifestPath = path.join(dir, `${name}.manifest.json`);
  writeFileSync(archivePath, archive);
  writeFileSync(manifestPath, JSON.stringify({
    format_version: 2, created_utc: name.slice(12), archive: path.basename(archivePath),
    archive_bytes: bytes, archive_sha256: sha, migration_version: 67,
  }, null, 2));
  return { archive, sha, archivePath, manifestPath };
}

/* ── Configuration, malformed in each of the ways a person malforms it ────── */

describe('configuration that would fail against the real Backblaze', () => {
  const base = {
    B2_S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
    B2_BUCKET: 'wev-backups-prod',
    B2_KEY_ID: '004abcdefabcdef0000000001',
    B2_APPLICATION_KEY: 'K004-not-a-real-application-key',
  };

  it('refuses a plaintext endpoint — the archive and the signature would go in clear', () => {
    expect(() => b2ConfigFromEnv({ ...base, B2_S3_ENDPOINT: 'http://s3.us-west-004.backblazeb2.com' }))
      .toThrow(/must be https/);
  });

  it('refuses an endpoint carrying a path or a query, which would corrupt every signature', () => {
    expect(() => b2ConfigFromEnv({ ...base, B2_S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com/my-bucket' }))
      .toThrow(/bare endpoint with no path/);
    expect(() => b2ConfigFromEnv({ ...base, B2_S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com/?x=1' }))
      .toThrow(/bare endpoint with no path/);
  });

  it('refuses an endpoint that is not a URL at all', () => {
    expect(() => b2ConfigFromEnv({ ...base, B2_S3_ENDPOINT: 'ht!tp://%%%' })).toThrow(/not a valid URL/);
  });

  /**
   * The mistake that motivated deriving the region rather than accepting one.
   *
   * B2 validates the region inside the credential scope, so a wrong region is not
   * a routing error that resolves itself — it is a SignatureDoesNotMatch on every
   * request, for ever. The R2 client this replaced hardcoded `auto`, which meant
   * it could never have authenticated to Backblaze at all.
   */
  it('refuses a B2_REGION that contradicts the endpoint instead of silently preferring one', () => {
    expect(() => b2ConfigFromEnv({ ...base, B2_REGION: 'us-east-005' }))
      .toThrow(/does not match the region in B2_S3_ENDPOINT/);
  });

  it('requires an explicit region when the endpoint is not a recognisable B2 host', () => {
    expect(() => b2ConfigFromEnv({ ...base, B2_S3_ENDPOINT: 'https://storage.example.com' }))
      .toThrow(/B2_REGION is required/);
    expect(b2ConfigFromEnv({ ...base, B2_S3_ENDPOINT: 'https://storage.example.com', B2_REGION: 'eu-west-1' }).region)
      .toBe('eu-west-1');
  });

  it('refuses a bucket name B2 would reject, before a request is built', () => {
    for (const bucket of ['ab', '-leading', 'trailing-', 'has_underscore', 'x'.repeat(64)]) {
      expect(() => b2ConfigFromEnv({ ...base, B2_BUCKET: bucket }), bucket).toThrow(/not a valid bucket name/);
    }
  });

  it('refuses a prefix that could escape its own namespace', () => {
    for (const prefix of ['../elsewhere', 'a/../../b', 'a//b', '.']) {
      expect(() => b2ConfigFromEnv({ ...base, B2_PREFIX: prefix }), prefix).toThrow(/must be a relative path/);
    }
  });

  it('treats every partial combination as a mistake, never as "no destination"', () => {
    const keys = ['B2_S3_ENDPOINT', 'B2_BUCKET', 'B2_KEY_ID', 'B2_APPLICATION_KEY'];
    for (const missing of keys) {
      const env = { ...base };
      delete env[missing];
      expect(() => b2ConfigFromEnv(env), missing).toThrow(new RegExp(`missing ${missing}`));
    }
    expect(b2ConfigFromEnv({})).toBeNull();
  });
});

/* ── Object keys ──────────────────────────────────────────────────────────── */

describe('the object key is a pure function of the archive name', () => {
  it('places an archive by the UTC stamp in its own name, not by this host\'s clock', () => {
    expect(archiveKey('p', 'wevolunteer-20260913T030356Z.dump.enc'))
      .toBe('p/daily/2026/09/13/wevolunteer-20260913T030356Z.dump.enc');
  });

  /**
   * A backup taken at 23:30 local time on the 12th in New York is 03:30 UTC on
   * the 13th, and must land under the 13th on both this host and the operator's
   * recovery machine in another timezone. Deriving the path from the name rather
   * than from a Date the local zone can shift is what makes a retried upload
   * target the same key.
   */
  it('does not move an object when the process timezone changes', () => {
    const name = 'wevolunteer-20260913T030356Z.dump.enc';
    const before = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      const a = archiveKey('p', name);
      process.env.TZ = 'Pacific/Kiritimati';
      expect(archiveKey('p', name)).toBe(a);
    } finally {
      if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    }
  });

  it('refuses a name that is not a WeVolunteer archive', () => {
    for (const bad of [
      'notes.txt', 'wevolunteer.dump.enc', 'wevolunteer-20260913.dump.enc',
      'wevolunteer-20260913T030356Z.dump',            // unencrypted
      '../../escape/wevolunteer-20260913T030356Z.dump.enc',
    ]) {
      expect(() => archiveKey('p', bad), bad).toThrow(/not a WeVolunteer backup file name/);
    }
  });

  it('refuses a date that looks valid and is not a day', () => {
    /* 2027 is not a leap year. A calendar check, not just a regex — otherwise
       this lands in a directory that can never be found again. */
    expect(() => archiveKey('p', 'wevolunteer-20270229T030356Z.dump.enc')).toThrow(/not a WeVolunteer/);
    expect(() => archiveKey('p', 'wevolunteer-20261332T030356Z.dump.enc')).toThrow(/not a WeVolunteer/);
  });
});

/* ── The transport, against a server that misbehaves ──────────────────────── */

describe('transport failures are classified as what they are', () => {
  let fake;
  beforeAll(async () => { fake = await startFakeB2(); });
  afterAll(() => fake.close());
  beforeEach(() => {
    fake.state.objects.clear();
    fake.state.requests.length = 0;
    fake.state.faults.length = 0;
  });

  const config = () => b2ConfigFromEnv(fake.env);

  /**
   * The bug this pins cost every upload in the previous implementation.
   *
   * The PUT timeout was scaled by size — `60_000 + body.length / 1024` — which is
   * fractional for almost every real archive, and `AbortSignal.timeout` throws a
   * RangeError on a fractional delay. The RangeError was raised inside the same
   * try that catches network errors, so a programming mistake was reported as a
   * transport failure and retried four times. Every real ~200 KB archive failed
   * every night and it looked like an outage.
   */
  it('accepts a fractional timeout rather than turning it into a fake network error', async () => {
    const body = randomBytes(200 * 1024);
    const timeoutMs = 60_000 + body.length / 1024;      // 60200.0 — but not always integral
    expect(Number.isInteger(60_000 + 4097 / 1024)).toBe(false);   // the shape that broke it
    await expect(putObject({
      config: config(), key: 'wevolunteer/postgres/daily/2026/09/13/x', body, timeoutMs: 60_000 + 4097 / 1024,
    })).resolves.toMatchObject({ bytes: body.length });
    expect(timeoutMs).toBeGreaterThan(0);
  });

  it('reports a timeout as a timeout, and retries it', async () => {
    fake.state.faults.push({ hangMs: 300, persistent: false });
    const err = await storeRequest({ config: config(), method: 'GET', key: 'nothing', timeoutMs: 50 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect(err.message).toMatch(/timed out after 50 ms/);
    expect(err.retryable).toBe(true);
  });

  it('reports a connection destroyed mid-request as a retryable network error', async () => {
    fake.state.faults.push({ destroy: true, persistent: false });
    const err = await storeRequest({ config: config(), method: 'GET', key: 'nothing' }).catch((e) => e);
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect(err.code).toBe('NetworkError');
    expect(err.retryable).toBe(true);
  });

  it('reports a refused connection without hanging', async () => {
    const dead = createServer();
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const port = dead.address().port;
    await new Promise((r) => dead.close(r));            // nothing is listening now

    const err = await storeRequest({
      config: b2ConfigFromEnv({ ...fake.env, B2_S3_ENDPOINT: `http://127.0.0.1:${port}` }),
      method: 'GET', key: 'nothing',
    }).catch((e) => e);
    expect(err.code).toBe('NetworkError');
    expect(err.retryable).toBe(true);
  });

  it('reports a name that does not resolve as a network error, not a crash', async () => {
    const err = await storeRequest({
      config: b2ConfigFromEnv({ ...fake.env, B2_S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.invalid' }),
      method: 'GET', key: 'nothing', timeoutMs: 8_000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect(err.code).toBe('NetworkError');
  });

  /**
   * A breached spending cap is a 403, exactly like a bad key — and Backblaze's
   * caps are enforced rather than advisory, which is the property B2 was chosen
   * for over R2. Left undistinguished, the nightly report says "access denied"
   * and an operator spends the morning re-issuing a working credential.
   */
  it('tells a spending cap apart from a credential problem, and does not retry it', async () => {
    for (const code of ['storage_cap_exceeded', 'download_cap_exceeded', 'transaction_cap_exceeded']) {
      fake.state.faults.push({ status: 403, code, persistent: false });
      const err = await storeRequest({ config: config(), method: 'GET', key: 'nothing' }).catch((e) => e);
      expect(err.cap, code).toBe(true);
      expect(err.retryable, code).toBe(false);
      expect(err.message).toMatch(/Backblaze spending cap, not a credential problem/);
      expect(err.message).toMatch(/midnight US\/Pacific/);
    }
  });

  it('does not retry a refusal that repeating cannot fix', async () => {
    let calls = 0;
    const err = await withRetry(async () => {
      calls++;
      throw new ObjectStoreError('nope', { status: 403, code: 'InvalidAccessKeyId', retryable: false });
    }, { baseMs: 1 }).catch((e) => e);
    expect(calls).toBe(1);           // one attempt, then report — not four
    expect(err.code).toBe('InvalidAccessKeyId');
  });

  it('gives up after a bounded number of attempts rather than hammering an outage', async () => {
    let calls = 0;
    await withRetry(async () => {
      calls++;
      throw new ObjectStoreError('busy', { status: 503, retryable: true });
    }, { baseMs: 1, attempts: 4 }).catch(() => {});
    expect(calls).toBe(4);
  });

  it('refuses a payload B2 would refuse: a Content-MD5 that does not describe the body', async () => {
    /* The fake checks Content-MD5 the way B2 documents checking it. This proves
       the check is live, so a corrupted body in flight is refused on receipt
       rather than stored. */
    const cfg = config();
    const err = await storeRequest({
      config: cfg, method: 'PUT', key: 'wevolunteer/postgres/daily/2026/09/13/x',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-MD5': createHash('md5').update('different').digest('base64') },
      body: Buffer.from('actual'),
    }).catch((e) => e);
    expect(err.code).toBe('BadDigest');
    expect(err.retryable).toBe(false);
  });

  it('never sends the checksum header B2 rejects', async () => {
    await putObject({ config: config(), key: 'wevolunteer/postgres/daily/2026/09/13/x', body: Buffer.from('hello') });
    const put = fake.state.requests.find((r) => r.method === 'PUT');
    expect(Object.keys(put.headers).some((h) => h.startsWith('x-amz-checksum-'))).toBe(false);
    /* And the fake would have refused it, so this is a live check rather than an
       assertion about our own intentions. */
    expect(Object.keys(put.headers)).toContain('content-md5');
  });

  it('signs every x-amz-* header it sends, so metadata cannot be altered in flight', async () => {
    await putObject({
      config: config(), key: 'wevolunteer/postgres/daily/2026/09/13/y',
      body: Buffer.from('hi'), metadata: { sha256: 'abc', 'format-version': '2' },
    });
    const put = fake.state.requests.find((r) => r.path.endsWith('/y'));
    const signed = put.headers.authorization.match(/SignedHeaders=([^,]+)/)[1].split(';');
    expect(signed).toContain('x-amz-meta-sha256');
    expect(signed).toContain('x-amz-meta-format-version');
    expect(signed).toContain('content-md5');
  });

  it('is refused when this host\'s clock has drifted out of the signing window', async () => {
    const err = await storeRequest({
      config: config(), method: 'GET', key: 'nothing',
      now: new Date(Date.now() - 40 * 60_000),
    }).catch((e) => e);
    expect(err.code).toBe('RequestTimeTooSkewed');
  });
});

/* ── The recovery path refuses what it cannot prove ───────────────────────── */

describe('the recovery path never hands over an archive it cannot vouch for', () => {
  let fake; let work;
  beforeAll(async () => { fake = await startFakeB2(); });
  afterAll(() => fake.close());
  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'wev-neg-'));
    fake.state.objects.clear();
    fake.state.requests.length = 0;
    fake.state.faults.length = 0;
    fake.state.corruptNextGet = false;
    fake.state.capabilities = new Set(['listBuckets', 'writeFiles', 'readFiles', 'listFiles', 'readFileRetentions']);
    return () => rmSync(work, { recursive: true, force: true });
  });

  const env = (extra = {}) => ({ ...fake.env, WEV_BACKUP_STATUS_DIR: path.join(work, 'status'), ...extra });
  const upload = async () => {
    const a = makeArchive(work);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env());
    expect(r.code, r.out).toBe(0);
    return a;
  };

  it('refuses an archive B2 does not hold rather than reporting an empty success', async () => {
    await upload();
    const out = path.join(work, 'restore');
    const r = await run(FETCH, ['--out', out, '--archive', 'wevolunteer-20250101T000000Z.dump.enc'], env());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/is not in the bucket/);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses a truncated object and leaves nothing behind to be restored by mistake', async () => {
    const a = await upload();
    const key = archiveKey('wevolunteer/postgres', `${NAME}.dump.enc`);
    const stored = fake.state.objects.get(key);
    stored[stored.length - 1].body = a.archive.subarray(0, a.archive.length - 64);

    const out = path.join(work, 'restore');
    const r = await run(FETCH, ['--out', out, '--latest'], env());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/does not match the SHA-256/);
    expect(existsSync(path.join(out, `${NAME}.dump.enc`))).toBe(false);
  });

  /**
   * A recovery key that cannot read fails at the first HEAD, and says only "403".
   *
   * That is as much as there is to say: an HTTP HEAD response carries no body, so
   * the provider's error code never reaches the client — B2 behaves the same way.
   * What matters is that it stops, exits non-zero, and writes nothing, rather than
   * continuing and producing an empty "recovered" archive.
   */
  it('refuses to read with a key that has no read capability', async () => {
    await upload();
    fake.state.capabilities.delete('readFiles');
    const out = path.join(work, 'restore');
    const r = await run(FETCH, ['--out', out, '--latest'], env());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/HTTP 403/);
    expect(existsSync(out)).toBe(false);
  });

  it('says plainly when the bucket holds nothing, instead of exiting 0 with no file', async () => {
    const r = await run(FETCH, ['--out', path.join(work, 'restore'), '--latest'], env());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/holds no archives/);
  });

  it('never prints the application key, on any failure path', async () => {
    fake.state.capabilities.delete('readFiles');
    const r = await run(FETCH, ['--out', path.join(work, 'restore'), '--latest'], env());
    expect(r.out).not.toContain(fake.env.B2_APPLICATION_KEY);
    expect(r.out).not.toContain(fake.env.B2_KEY_ID);
  });
});

/* ── The rule that outranks all of the above ──────────────────────────────── */

describe('a failed new backup never destroys the last good one', () => {
  let fake; let work;
  beforeAll(async () => { fake = await startFakeB2(); });
  afterAll(() => fake.close());
  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'wev-neg-keep-'));
    fake.state.objects.clear();
    fake.state.requests.length = 0;
    fake.state.faults.length = 0;
    return () => rmSync(work, { recursive: true, force: true });
  });
  const env = (extra = {}) => ({ ...fake.env, WEV_BACKUP_STATUS_DIR: path.join(work, 'status'), ...extra });

  it('leaves every earlier object in the bucket untouched when tonight fails', async () => {
    const good = makeArchive(work, 'wevolunteer-20260911T030000Z');
    expect((await run(OFFSITE, [good.archivePath, good.manifestPath], env())).code).toBe(0);
    const before = new Map([...fake.state.objects].map(([k, v]) => [k, v.map((x) => x.versionId)]));

    /* Tonight: B2 is simply gone. */
    fake.state.faults.push({ status: 503, persistent: true });
    const bad = makeArchive(work, 'wevolunteer-20260913T030356Z');
    const r = await run(OFFSITE, [bad.archivePath, bad.manifestPath], env());
    expect(r.code).toBe(1);

    fake.state.faults.length = 0;
    const after = new Map([...fake.state.objects].map(([k, v]) => [k, v.map((x) => x.versionId)]));
    expect(after).toEqual(before);
    /* And no DELETE was ever attempted — the writer's key has no deleteFiles, so
       an attempt would be a defect even though B2 would refuse it. */
    expect(fake.state.requests.some((q) => q.method === 'DELETE')).toBe(false);
  });

  it('keeps the last verified copy on the record so an operator can see how far back it is', async () => {
    const good = makeArchive(work, 'wevolunteer-20260911T030000Z');
    expect((await run(OFFSITE, [good.archivePath, good.manifestPath], env())).code).toBe(0);

    fake.state.faults.push({ status: 503, persistent: true });
    const bad = makeArchive(work, 'wevolunteer-20260913T030356Z');
    expect((await run(OFFSITE, [bad.archivePath, bad.manifestPath], env())).code).toBe(1);

    const s = JSON.parse(readFileSync(path.join(work, 'status', 'offsite.json'), 'utf8'));
    expect(s.state).toBe('failed');
    expect(s.lastVerified).toMatchObject({ archive: 'wevolunteer-20260911T030000Z.dump.enc' });
  });

  it('leaves the local archive on disk when the off-site copy fails', async () => {
    fake.state.faults.push({ status: 503, persistent: true });
    const a = makeArchive(work, 'wevolunteer-20260913T030356Z');
    expect((await run(OFFSITE, [a.archivePath, a.manifestPath], env())).code).toBe(1);
    expect(existsSync(a.archivePath)).toBe(true);
    expect(existsSync(a.manifestPath)).toBe(true);
  });

  /**
   * The ordering guarantee, read out of the script itself.
   *
   * `bin/backup-postgres.sh` prunes with `find -delete`. If that ever runs before
   * the off-site gate — or if the gate stops being fatal — then a run of failed
   * nights ages out the last good archive while producing no new one, and the
   * platform quietly arrives at having no recoverable backup at all. No unit test
   * of the uploader can catch that; it is a property of the order of two lines.
   */
  it('prunes only after the off-site copy has succeeded, in the script itself', () => {
    /* Code, not commentary: the header mentions both by name, so an index into
       the whole file would pass on a script that never runs either. */
    const sh = readFileSync(path.join(ROOT, 'bin/backup-postgres.sh'), 'utf8')
      .split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

    const gate = sh.search(/^if ! node .*backup-offsite\.mjs/m);
    const prune = sh.search(/^\s*-type f -mtime .*-delete$|-delete/m);
    expect(gate, 'the off-site gate is not invoked').toBeGreaterThan(-1);
    expect(prune, 'nothing prunes').toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(gate);

    /* And the gate must be fatal. A bare invocation would let a failed upload
       fall through to the prune. */
    expect(sh.slice(gate, gate + 400)).toMatch(/fail "the off-site copy failed/);
  });

  it('refuses to produce an archive at all when a destination is set and encryption is not', () => {
    const sh = readFileSync(path.join(ROOT, 'bin/backup-postgres.sh'), 'utf8')
      .split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    /* Checked before the dump, not after: otherwise a night's work is done and
       then discarded, and the window in which a plaintext archive exists on disk
       is the whole backup. */
    const check = sh.indexOf('refusing to produce an archive that could be sent unencrypted');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(sh.search(/^log "dumping/m));
  });
});

/* ── The drill's verdict has to cross machines ────────────────────────────── */

describe('the restore drill reaches the host that cannot run it', () => {
  let fake; let work;
  beforeAll(async () => { fake = await startFakeB2(); });
  afterAll(() => fake.close());
  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'wev-drill-pub-'));
    fake.state.objects.clear();
    fake.state.requests.length = 0;
    fake.state.faults.length = 0;
    return () => rmSync(work, { recursive: true, force: true });
  });

  const PUBLISH = path.join(ROOT, 'bin/backup-drill-publish.mjs');
  const statusDir = () => path.join(work, 'status');
  const env = (extra = {}) => ({ ...fake.env, WEV_BACKUP_STATUS_DIR: statusDir(), ...extra });
  const drillRecord = (over = {}) => {
    const p = path.join(work, 'restore-drill.json');
    writeFileSync(p, JSON.stringify({
      state: 'passed', at: '2026-09-12T04:00:00Z', source: 'offsite',
      archive: `${NAME}.dump.enc`, elapsedSeconds: 41,
      result: { tables: 48, foreign_keys: 61, migration_version: 67, users: 3 },
      ...over,
    }));
    return p;
  };

  /**
   * The round trip: the operator's machine publishes, the host picks it up on its
   * next nightly run and records it where the Owner Center reads it.
   */
  it('publishes a pass on one machine and records it on the other', async () => {
    expect((await run(PUBLISH, [drillRecord()], { ...fake.env, WEV_DRILL_LABEL: 'laptop' })).code).toBe(0);

    const a = makeArchive(work);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env());
    expect(r.code, r.out).toBe(0);

    const recorded = JSON.parse(readFileSync(path.join(statusDir(), 'restore-drill.json'), 'utf8'));
    expect(recorded).toMatchObject({ state: 'passed', source: 'offsite', drilledBy: 'laptop' });
    expect(recorded.result).toMatchObject({ migration_version: 67 });
  });

  it('publishes a FAILED drill too — that is the one the host needs to hear', async () => {
    expect((await run(PUBLISH, [drillRecord({ state: 'failed', stage: 'restore', error: 'pg_restore failed' })], fake.env)).code).toBe(0);
    const a = makeArchive(work);
    expect((await run(OFFSITE, [a.archivePath, a.manifestPath], env())).code).toBe(0);

    const recorded = JSON.parse(readFileSync(path.join(statusDir(), 'restore-drill.json'), 'utf8'));
    expect(recorded).toMatchObject({ state: 'failed', stage: 'restore' });
  });

  /**
   * A drill run by hand on the host is more direct evidence than a published one,
   * so the newer record wins rather than the remote one always overwriting.
   */
  it('never moves the recorded drill backwards in time', async () => {
    const local = { state: 'passed', at: '2026-09-14T09:00:00Z', source: 'local' };
    writeFileSync(path.join(work, 'seed.json'), '');
    rmSync(statusDir(), { recursive: true, force: true });
    const fs = await import('node:fs');
    fs.mkdirSync(statusDir(), { recursive: true });
    fs.writeFileSync(path.join(statusDir(), 'restore-drill.json'), JSON.stringify(local));

    expect((await run(PUBLISH, [drillRecord({ at: '2026-09-12T04:00:00Z' })], fake.env)).code).toBe(0);
    const a = makeArchive(work);
    expect((await run(OFFSITE, [a.archivePath, a.manifestPath], env())).code).toBe(0);

    expect(JSON.parse(readFileSync(path.join(statusDir(), 'restore-drill.json'), 'utf8')).at)
      .toBe('2026-09-14T09:00:00Z');
  });

  it('publishes only the fields it decided to publish, never the whole record', async () => {
    const p = drillRecord({ databaseUrl: 'postgresql://user:secret@host/db', notes: 'internal' });
    expect((await run(PUBLISH, [p], fake.env)).code).toBe(0);

    const key = 'wevolunteer/postgres/drills/latest.json';
    const stored = JSON.parse(fake.state.objects.get(key).at(-1).body.toString('utf8'));
    expect(stored).not.toHaveProperty('databaseUrl');
    expect(stored).not.toHaveProperty('notes');
    expect(JSON.stringify(stored)).not.toContain('secret');
  });

  it('leaves the nightly copy verified when no drill has ever been published', async () => {
    const a = makeArchive(work);
    const r = await run(OFFSITE, [a.archivePath, a.manifestPath], env());
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(readFileSync(path.join(statusDir(), 'offsite.json'), 'utf8')).state).toBe('verified');
    expect(existsSync(path.join(statusDir(), 'restore-drill.json'))).toBe(false);
  });

  it('exits 0 and says so when there is no bucket to publish to', async () => {
    const r = await run(PUBLISH, [drillRecord()], { PATH: process.env.PATH });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/not configured/);
  });
});
