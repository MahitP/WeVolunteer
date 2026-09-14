import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import {
  b2ConfigFromEnv, signingKey, signRequest, objectPath, withRetry, archiveKey,
  putObject, headObject, getObject, listObjectVersions, storeRequest, ObjectStoreError, DEFAULT_PREFIX,
} from './object-store.mjs';
import { startFakeB2 } from './fake-b2.mjs';

/**
 * Testing a B2 client without a B2 account.
 *
 * Three different claims, checked three different ways, because each fails in
 * its own way:
 *
 *   1. The HMAC chain is the one AWS specifies — against AWS's published vector,
 *      so this is the standard agreeing with the code, not the code with itself.
 *   2. Configuration refuses every mistake that would make B2 refuse the request
 *      (the old R2 client's hardcoded `auto` region is the one that motivated it).
 *   3. Requests are accepted by a server that recomputes the signature and the
 *      payload hash independently and refuses what B2 documents refusing.
 *
 * None of that proves Backblaze accepts it. The live check in
 * docs/operations/offsite-backups.md does, and reports say which one ran.
 */

const B2_ENV = {
  B2_S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
  B2_BUCKET: 'wev-backups-prod',
  B2_KEY_ID: '004abcdefabcdef0000000001',
  B2_APPLICATION_KEY: 'K004-not-a-real-application-key-xxxxxxxx',
};

describe('SigV4 signing key derivation', () => {
  it('matches the published AWS vector', () => {
    const hmac = (key, str) => createHmac('sha256', key).update(str, 'utf8').digest();
    const reference = hmac(
      hmac(hmac(hmac('AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215'), 'us-east-1'), 'iam'),
      'aws4_request',
    ).toString('hex');
    expect(reference).toBe('f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
    expect(signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam').toString('hex'))
      .toBe('f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
  });
});

describe('b2ConfigFromEnv', () => {
  it('returns null when nothing is configured — a local-only backup still runs', () => {
    expect(b2ConfigFromEnv({})).toBeNull();
  });

  it('derives the region from a B2 endpoint — never "auto"', () => {
    const c = b2ConfigFromEnv(B2_ENV);
    expect(c.region).toBe('us-west-004');
    expect(c.region).not.toBe('auto');
    expect(c.bucket).toBe('wev-backups-prod');
    expect(c.prefix).toBe(DEFAULT_PREFIX);
  });

  it('accepts a bare host and adds https', () => {
    expect(b2ConfigFromEnv({ ...B2_ENV, B2_S3_ENDPOINT: 's3.eu-central-003.backblazeb2.com' }).region).toBe('eu-central-003');
  });

  it('refuses a partial configuration and names what is missing, never a value', () => {
    const env = { ...B2_ENV };
    delete env.B2_KEY_ID;
    expect(() => b2ConfigFromEnv(env)).toThrow(/missing B2_KEY_ID/);
    try { b2ConfigFromEnv(env); } catch (err) {
      expect(err.message).not.toContain(B2_ENV.B2_APPLICATION_KEY);
    }
  });

  it('refuses a B2_REGION that disagrees with the endpoint', () => {
    expect(() => b2ConfigFromEnv({ ...B2_ENV, B2_REGION: 'us-east-005' })).toThrow(/does not match/);
  });

  it('accepts a B2_REGION that agrees with the endpoint', () => {
    expect(b2ConfigFromEnv({ ...B2_ENV, B2_REGION: 'us-west-004' }).region).toBe('us-west-004');
  });

  it('refuses plain http to anything but loopback', () => {
    expect(() => b2ConfigFromEnv({ ...B2_ENV, B2_S3_ENDPOINT: 'http://s3.us-west-004.backblazeb2.com' })).toThrow(/must be https/);
    expect(b2ConfigFromEnv({ ...B2_ENV, B2_S3_ENDPOINT: 'http://127.0.0.1:9000', B2_REGION: 'us-west-004' }).endpoint.port).toBe('9000');
  });

  it('refuses an endpoint with a path (a bucket URL pasted by mistake)', () => {
    expect(() => b2ConfigFromEnv({ ...B2_ENV, B2_S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com/wev-backups-prod' })).toThrow(/no path/);
  });

  it('requires B2_REGION for a non-B2 host, rather than guessing', () => {
    expect(() => b2ConfigFromEnv({ ...B2_ENV, B2_S3_ENDPOINT: 'https://storage.example.com' })).toThrow(/B2_REGION is required/);
  });

  it('refuses an invalid bucket name and a traversal prefix', () => {
    expect(() => b2ConfigFromEnv({ ...B2_ENV, B2_BUCKET: 'no' })).toThrow(/bucket name/);
    expect(() => b2ConfigFromEnv({ ...B2_ENV, B2_PREFIX: 'a/../b' })).toThrow(/B2_PREFIX/);
    expect(b2ConfigFromEnv({ ...B2_ENV, B2_PREFIX: '/custom/path/' }).prefix).toBe('custom/path');
  });
});

describe('signRequest', () => {
  const config = b2ConfigFromEnv(B2_ENV);
  const now = new Date('2026-09-13T03:00:00.000Z');
  const base = { config, method: 'PUT', path: '/wev-backups-prod/k', payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', now };

  it('scopes the credential to the bucket region and s3', () => {
    const { headers } = signRequest(base);
    expect(headers.Authorization).toContain(`Credential=${B2_ENV.B2_KEY_ID}/20260913/us-west-004/s3/aws4_request`);
    expect(headers['x-amz-date']).toBe('20260913T030000Z');
  });

  it('signs every header it sends, metadata and Content-MD5 included', () => {
    const { headers } = signRequest({ ...base, headers: { 'Content-MD5': 'x', 'x-amz-meta-sha256': 'y' } });
    expect(headers.Authorization).toMatch(/SignedHeaders=content-md5;host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256,/);
  });

  it('never puts the secret in a header', () => {
    const { headers } = signRequest(base);
    expect(JSON.stringify(headers)).not.toContain(B2_ENV.B2_APPLICATION_KEY);
  });

  it('changes when the secret, the region, the body or the query changes', () => {
    const sig = (o) => signRequest({ ...base, ...o }).headers.Authorization.split('Signature=')[1];
    const reference = sig({});
    expect(sig({ config: { ...config, secretAccessKey: 'other' } })).not.toBe(reference);
    expect(sig({ config: { ...config, region: 'us-east-005' } })).not.toBe(reference);
    expect(sig({ payloadHash: 'f'.repeat(64) })).not.toBe(reference);
    expect(sig({ query: { versions: '' } })).not.toBe(reference);
  });

  it('builds path-style object paths with each segment encoded once', () => {
    expect(objectPath(config, 'a b/c')).toBe('/wev-backups-prod/a%20b/c');
    expect(objectPath(config)).toBe('/wev-backups-prod');
  });
});

describe('archiveKey — names come from the archive, never the clock', () => {
  it('files an archive under its own UTC date', () => {
    expect(archiveKey('wevolunteer/postgres', 'wevolunteer-20260913T030356Z.dump.enc'))
      .toBe('wevolunteer/postgres/daily/2026/09/13/wevolunteer-20260913T030356Z.dump.enc');
  });

  it('keeps a just-before-midnight UTC archive on its UTC day whatever TZ the host has', () => {
    const before = process.env.TZ;
    try {
      for (const tz of ['UTC', 'America/New_York', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
        process.env.TZ = tz;
        expect(archiveKey('p', 'wevolunteer-20261231T235959Z.dump.enc')).toBe('p/daily/2026/12/31/wevolunteer-20261231T235959Z.dump.enc');
      }
    } finally {
      if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    }
  });

  it('accepts a leap day and the manifest beside it', () => {
    expect(archiveKey('p', 'wevolunteer-20280229T030000Z.manifest.json')).toBe('p/daily/2028/02/29/wevolunteer-20280229T030000Z.manifest.json');
  });

  it('refuses a date that does not exist', () => {
    expect(() => archiveKey('p', 'wevolunteer-20270229T030000Z.dump.enc')).toThrow(/not a WeVolunteer backup/);
    expect(() => archiveKey('p', 'wevolunteer-20261301T030000Z.dump.enc')).toThrow(/not a WeVolunteer backup/);
  });

  it('refuses anything that is not an encrypted archive or its manifest', () => {
    for (const name of ['wevolunteer-20260913T030356Z.dump', 'users.csv', '../wevolunteer-20260913T030356Z.dump.enc', 'wevolunteer-20260913T030356Z.dump.enc.tmp']) {
      expect(() => archiveKey('p', name)).toThrow(/not a WeVolunteer backup/);
    }
  });
});

describe('withRetry', () => {
  const noSleep = { sleep: async () => {}, random: () => 0.5 };

  it('retries a retryable failure and then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw new ObjectStoreError('503', { status: 503, retryable: true });
      return 'ok';
    }, noSleep);
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry an authentication or permission refusal', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls += 1; throw new ObjectStoreError('403', { status: 403 }); }, noSleep)).rejects.toThrow('403');
    expect(calls).toBe(1);
  });

  it('is bounded — four attempts, then the last error', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls += 1; throw new ObjectStoreError(`fail ${calls}`, { retryable: true }); }, noSleep)).rejects.toThrow('fail 4');
    expect(calls).toBe(4);
  });

  it('backs off exponentially with full jitter, capped', async () => {
    const waits = [];
    await withRetry(async () => { throw new ObjectStoreError('x', { retryable: true }); }, {
      attempts: 7, baseMs: 1000, maxMs: 20_000, random: () => 0.999999, sleep: async (ms) => { waits.push(ms); },
    }).catch(() => {});
    expect(waits).toEqual([999, 1999, 3999, 7999, 15_999, 19_999]);
    const low = [];
    await withRetry(async () => { throw new ObjectStoreError('x', { retryable: true }); }, {
      random: () => 0, sleep: async (ms) => { low.push(ms); },
    }).catch(() => {});
    expect(low).toEqual([0, 0, 0]);
  });
});

describe('against a server that verifies like B2', () => {
  let fake;
  let config;

  beforeAll(async () => {
    fake = await startFakeB2();
    config = b2ConfigFromEnv(fake.env);
  });
  afterAll(() => fake.close());
  beforeEach(() => {
    fake.state.objects.clear();
    fake.state.faults.length = 0;
    fake.state.capabilities = new Set(['listBuckets', 'writeFiles', 'readFiles', 'listFiles', 'readFileRetentions']);
  });

  it('PUT, HEAD and GET round-trip the exact bytes and metadata', async () => {
    const body = Buffer.from('encrypted archive bytes  ÿ');
    const sha = createHash('sha256').update(body).digest('hex');
    await putObject({ config, key: 'wevolunteer/postgres/daily/2026/09/13/x.dump.enc', body, metadata: { sha256: sha } });
    const head = await headObject({ config, key: 'wevolunteer/postgres/daily/2026/09/13/x.dump.enc' });
    expect(head.size).toBe(body.length);
    expect(head.metadata.sha256).toBe(sha);
    expect(head.lockMode).toBe('GOVERNANCE');
    expect(Date.parse(head.lockRetainUntil) - Date.parse(head.lastModified)).toBeGreaterThan(27 * 86_400_000);
    expect(Buffer.compare(await getObject({ config, key: 'wevolunteer/postgres/daily/2026/09/13/x.dump.enc' }), body)).toBe(0);
    const put = fake.state.requests.find((r) => r.method === 'PUT');
    expect(put.headers['x-amz-checksum-sha256']).toBeUndefined();
    expect(put.headers['content-md5']).toBeDefined();
  });

  it('HEAD of a missing object is null, not an error', async () => {
    expect(await headObject({ config, key: 'nope' })).toBeNull();
  });

  it('a wrong application key is refused and not retried', async () => {
    const bad = { ...config, secretAccessKey: 'wrong' };
    const err = await putObject({ config: bad, key: 'k', body: Buffer.from('x') }).catch((e) => e);
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect(err.code).toBe('SignatureDoesNotMatch');
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain('wrong');
  });

  it('a wrong region is refused — the defect the R2 client would have shipped', async () => {
    const err = await putObject({ config: { ...config, region: 'auto' }, key: 'k', body: Buffer.from('x') }).catch((e) => e);
    expect(err.code).toBe('SignatureDoesNotMatch');
  });

  it('a wrong bucket is refused', async () => {
    const err = await putObject({ config: { ...config, bucket: 'someone-elses-bucket' }, key: 'k', body: Buffer.from('x') }).catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.code).toBe('NoSuchBucket');
  });

  it('a clock skewed past fifteen minutes is refused', async () => {
    // GET, not HEAD: a HEAD error has no body, so it carries a status and no code
    // — here, and at B2.
    const err = await storeRequest({ config, method: 'GET', key: 'k', now: new Date(Date.now() - 20 * 60_000) }).catch((e) => e);
    expect(err.code).toBe('RequestTimeTooSkewed');
    const headErr = await storeRequest({ config, method: 'HEAD', key: 'k', now: new Date(Date.now() - 20 * 60_000) }).catch((e) => e);
    expect(headErr.status).toBe(403);
    expect(headErr.retryable).toBe(false);
  });

  it('a key without writeFiles cannot upload', async () => {
    fake.state.capabilities.delete('writeFiles');
    const err = await putObject({ config, key: 'k', body: Buffer.from('x') }).catch((e) => e);
    expect(err.status).toBe(403);
  });

  it('503 is retryable, a timeout is retryable, a dropped connection is retryable', async () => {
    fake.state.faults.push({ status: 503 });
    const e1 = await headObject({ config, key: 'k' }).catch((e) => e);
    expect(e1.retryable).toBe(true);

    fake.state.faults.push({ hangMs: 400 });
    const e2 = await headObject({ config, key: 'k', timeoutMs: 100 }).catch((e) => e);
    expect(e2.retryable).toBe(true);
    expect(e2.message).toMatch(/timed out/);

    fake.state.faults.push({ destroy: true });
    const e3 = await headObject({ config, key: 'k' }).catch((e) => e);
    expect(e3.retryable).toBe(true);
  });

  it('lists every version and delete marker, across pages', async () => {
    const small = await startFakeB2({ pageSize: 2 });
    try {
      const c = b2ConfigFromEnv(small.env);
      for (let i = 0; i < 5; i++) await putObject({ config: c, key: `p/daily/${i}.dump.enc`, body: Buffer.from(`v${i}`) });
      await putObject({ config: c, key: 'p/daily/0.dump.enc', body: Buffer.from('v0-second') });
      small.state.objects.get('p/daily/1.dump.enc').push({ versionId: 'dm', deleteMarker: true, lastModified: new Date(), body: Buffer.alloc(0) });
      small.state.objects.set('other/x', [{ versionId: 'o', body: Buffer.from('x'), meta: {}, lastModified: new Date() }]);
      const all = await listObjectVersions({ config: c, prefix: 'p/' });
      expect(all).toHaveLength(7);
      expect(all.filter((v) => v.deleteMarker)).toHaveLength(1);
      expect(all.filter((v) => !v.isLatest)).toHaveLength(2);
      expect(all.every((v) => v.key.startsWith('p/'))).toBe(true);
    } finally {
      await small.close();
    }
  });

  it('a listing that never ends is stopped', async () => {
    const small = await startFakeB2({ pageSize: 1 });
    try {
      const c = b2ConfigFromEnv(small.env);
      for (let i = 0; i < 4; i++) await putObject({ config: c, key: `p/${i}`, body: Buffer.from('x') });
      await expect(listObjectVersions({ config: c, prefix: 'p/', maxPages: 2 })).rejects.toThrow(/exceeded 2 pages/);
    } finally {
      await small.close();
    }
  });

  it('the fake refuses what B2 refuses — so a green run here means something', async () => {
    // Mutation check on the harness itself: a client that sent x-amz-checksum-*
    // (as the AWS SDK does by default) must fail here, not first in production.
    const body = Buffer.from('x');
    const err = await storeRequest({ config, method: 'PUT', key: 'k', body, headers: { 'x-amz-checksum-sha256': createHash('sha256').update(body).digest('base64') } }).catch((e) => e);
    expect(err.code).toBe('InvalidArgument');
    // And a Content-MD5 that does not match the body.
    const err2 = await storeRequest({ config, method: 'PUT', key: 'k', body, headers: { 'Content-MD5': createHash('md5').update('y').digest('base64') } }).catch((e) => e);
    expect(err2.code).toBe('BadDigest');
  });

  it('a locked version cannot be deleted even by a key that has deleteFiles', async () => {
    fake.state.capabilities.add('deleteFiles');
    await putObject({ config, key: 'k', body: Buffer.from('x') });
    const [v] = fake.state.objects.get('k');
    const err = await storeRequest({ config, method: 'DELETE', key: 'k', query: { versionId: v.versionId } }).catch((e) => e);
    expect(err.status).toBe(403);
    expect(fake.state.objects.get('k')).toHaveLength(1);
  });
});

describe('timeouts scaled by size', () => {
  it('a fractional timeout is accepted rather than failing every real archive', async () => {
    const fake = await startFakeB2();
    try {
      const config = b2ConfigFromEnv(fake.env);
      // 199,878 bytes — the production archive size on 2026-09-13 — gives a
      // fractional size-scaled timeout.
      const body = Buffer.alloc(199_878, 7);
      await expect(putObject({ config, key: 'k', body, timeoutMs: 60_000 + body.length / 1024 })).resolves.toMatchObject({ bytes: 199_878 });
    } finally {
      await fake.close();
    }
  });

  it('a programming error is not disguised as a retryable network failure', async () => {
    const config = b2ConfigFromEnv({ ...B2_ENV });
    const fetchImpl = async () => { throw new RangeError('boom'); };
    const err = await storeRequest({ config, method: 'HEAD', key: 'k', fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(RangeError);
    expect(err.retryable).toBeUndefined();
  });
});
