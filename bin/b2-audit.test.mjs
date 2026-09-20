import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';

/**
 * What the audit REPORTS, not just what it decides.
 *
 * `b2-policy.test.mjs` covers the judgement. This file covers the part an
 * operator and a script actually consume: the exit code and the summary.
 *
 * It exists because of a specific request and a specific hazard. WeVolunteer's
 * owner has chosen to run the nightly backup with one highly privileged
 * Backblaze key rather than three scoped ones — their account, their call — and
 * asked for that to be reported accurately rather than argued with. The hazard is
 * the obvious way to implement it: a flag that silences the findings and exits 0.
 * That produces a report indistinguishable from a genuinely least-privileged
 * deployment, which is how an accepted risk becomes a forgotten one.
 *
 * So the contract asserted here is three-way and deliberately awkward:
 *
 *   exit 0  everything clean, least privilege genuinely satisfied
 *   exit 3  bucket correct, capability deviations ACCEPTED and still printed
 *   exit 1  anything nobody may accept — or deviations that were not accepted
 *
 * There must be no flag combination that turns a master key into exit 0.
 *
 * The whole CLI runs, against a stand-in for Backblaze's native API reached
 * through B2_NATIVE_API, so the fetching, the partitioning and the exit code are
 * exercised together.
 */

const AUDIT = path.join(path.resolve(import.meta.dirname), 'b2-audit.mjs');

/** A master-key-shaped authorize response: every capability, no restriction. */
const MASTER = [
  'listKeys', 'writeKeys', 'deleteKeys', 'listBuckets', 'writeBuckets', 'deleteBuckets',
  'listFiles', 'readFiles', 'shareFiles', 'writeFiles', 'deleteFiles',
  'readBucketRetentions', 'writeBucketRetentions', 'readFileRetentions', 'writeFileRetentions',
  'readBucketLifecycleRules', 'writeBucketLifecycleRules', 'bypassGovernance',
];
const SCOPED_WRITER = ['listFiles', 'readFiles', 'writeFiles', 'readFileRetentions'];

const goodBucket = () => ({
  bucketId: 'b1',
  bucketName: 'wevolunteer-bucket',
  bucketType: 'allPrivate',
  fileLockConfiguration: {
    isClientAuthorizedToRead: true,
    value: { isFileLockEnabled: true, defaultRetention: { mode: 'governance', period: { duration: 7, unit: 'days' } } },
  },
  lifecycleRules: [{
    fileNamePrefix: 'wevolunteer/backups/postgres/',
    daysFromUploadingToHiding: 27,
    daysFromHidingToDeleting: 1,
  }],
});

const goodFiles = () => ([
  { fileName: 'wevolunteer/backups/postgres/daily/2026/09/20/wevolunteer-20260920T030000Z.dump.enc', action: 'upload', fileRetention: { value: { mode: 'governance' } } },
]);

let server; let origin; let state;

beforeAll(async () => {
  state = { capabilities: SCOPED_WRITER, restricted: true, bucket: goodBucket(), files: goodFiles() };
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url.endsWith('b2_authorize_account')) {
        return send({
          accountId: 'acct',
          authorizationToken: 'tok',
          apiInfo: {
            storageApi: {
              apiUrl: origin,
              s3ApiUrl: 'https://s3.us-east-005.backblazeb2.com',
              capabilities: state.capabilities,
              bucketId: state.restricted ? 'b1' : null,
              bucketName: state.restricted ? 'wevolunteer-bucket' : null,
              namePrefix: null,
            },
          },
        });
      }
      if (req.url.endsWith('b2_list_buckets')) return send({ buckets: state.bucket ? [state.bucket] : [] });
      if (req.url.endsWith('b2_list_file_versions')) return send({ files: state.files });
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((r) => server.close(r)));

const audit = (args = [], extraEnv = {}) => new Promise((resolve) => {
  execFile(process.execPath, [AUDIT, ...args], {
    env: {
      PATH: process.env.PATH,
      B2_NATIVE_API: origin,
      B2_S3_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com',
      B2_BUCKET: 'wevolunteer-bucket',
      B2_KEY_ID: 'not-a-real-key-id',
      B2_APPLICATION_KEY: 'not-a-real-application-key',
      ...extraEnv,
    },
  }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: stdout + stderr });
  });
});

describe('a genuinely least-privileged writer', () => {
  it('exits 0 and says least privilege is satisfied', async () => {
    state.capabilities = SCOPED_WRITER; state.restricted = true;
    const r = await audit();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/bucket configuration\s+: VERIFIED/);
    expect(r.out).toMatch(/least privilege\s+: SATISFIED/);
  });
});

describe('the owner\'s privileged credential', () => {
  /**
   * The case this file exists for. Accepting the deviation must change how it is
   * REPORTED and nothing about whether it is reported.
   */
  it('never exits 0, however it is acknowledged', async () => {
    state.capabilities = MASTER; state.restricted = false;
    for (const args of [[], ['--accept-privileged']]) {
      const r = await audit(args);
      expect(r.code, `args=${args} out=${r.out}`).not.toBe(0);
    }
    const viaEnv = await audit([], { WEV_B2_ACCEPT_PRIVILEGED_CREDENTIAL: '1' });
    expect(viaEnv.code).not.toBe(0);
  });

  it('exits 3 when accepted — a code no caller can mistake for a pass', async () => {
    state.capabilities = MASTER; state.restricted = false;
    const r = await audit(['--accept-privileged']);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/exit\s+: 3/);
    expect(r.out).toMatch(/not a pass/);
  });

  it('exits 1 when the deviation has NOT been acknowledged', async () => {
    state.capabilities = MASTER; state.restricted = false;
    expect((await audit()).code).toBe(1);
  });

  /** Acceptance is acknowledgement, not suppression. */
  it('still prints every capability finding, and still says NOT SATISFIED', async () => {
    state.capabilities = MASTER; state.restricted = false;
    const r = await audit(['--accept-privileged']);
    expect(r.out).toMatch(/least privilege\s+: NOT SATISFIED/);
    expect(r.out).toMatch(/ACCEPTED by the owner, NOT fixed/);
    expect(r.out).toMatch(/residual risk retained/);
    for (const cap of ['deleteFiles', 'bypassGovernance', 'writeBucketLifecycleRules', 'writeKeys']) {
      expect(r.out, cap).toContain(cap);
    }
    expect(r.out).toMatch(/not restricted to one bucket/);
  });

  it('reports the three claims separately in --json', async () => {
    state.capabilities = MASTER; state.restricted = false;
    const r = await audit(['--accept-privileged', '--json']);
    const j = JSON.parse(r.out);
    expect(j.bucketConfigurationOk).toBe(true);
    expect(j.leastPrivilege).toBe(false);
    expect(j.privilegeDeviationsAccepted).toBe(true);
    expect(j.exitCode).toBe(3);
    expect(j.privilegeFindings.length).toBeGreaterThan(0);
    expect(j.mandatoryFindings).toEqual([]);
  });

  /**
   * The line that must not be crossed: a privileged credential does not excuse a
   * misconfigured bucket. Accepting capabilities is the owner's to do; accepting
   * a bucket that never expires anything is not, because that one contradicts a
   * published commitment rather than a preference.
   */
  it('still fails on a bucket problem even with the deviation accepted', async () => {
    state.capabilities = MASTER; state.restricted = false;
    const b = goodBucket(); b.lifecycleRules = [];
    state.bucket = b;
    const r = await audit(['--accept-privileged']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/these are not acceptable/);
    expect(r.out).toMatch(/lifecycle-missing/);
    expect(r.out).toMatch(/bucket configuration\s+: NOT VERIFIED/);
    state.bucket = goodBucket();
  });

  it('does not print the credential on any path', async () => {
    state.capabilities = MASTER; state.restricted = false;
    for (const args of [[], ['--accept-privileged'], ['--accept-privileged', '--json']]) {
      const r = await audit(args);
      expect(r.out, `args=${args}`).not.toContain('not-a-real-key-id');
      expect(r.out, `args=${args}`).not.toContain('not-a-real-application-key');
      expect(r.out, `args=${args}`).not.toContain('tok');
    }
  });
});

describe('the four claims are reported separately', () => {
  /**
   * "The key works", "the key can see the bucket", "this deployment intends a
   * privileged key" and "least privilege is satisfied" are four different
   * questions. Collapsing any pair of them is how a privileged-credential
   * deployment ends up reading as either broken or fine, when it is neither.
   */
  it('names authorization, bucket access, intended design and least privilege', async () => {
    state.capabilities = MASTER; state.restricted = false;
    const r = await audit(['--accept-privileged']);
    expect(r.out).toMatch(/1\. authorization\s+: VERIFIED/);
    expect(r.out).toMatch(/2\. bucket access\s+: VERIFIED/);
    expect(r.out).toMatch(/3\. intended design\s+: privileged-single-key \(owner decision\)/);
    expect(r.out).toMatch(/4\. least privilege\s+: NOT SATISFIED/);
    expect(r.out).toMatch(/INTENTIONAL owner decision/);
  });

  it('calls the design least-privilege when the deviation is not claimed as intentional', async () => {
    state.capabilities = MASTER; state.restricted = false;
    const r = await audit();
    expect(r.out).toMatch(/3\. intended design\s+: least-privilege/);
    expect(r.out).toMatch(/NOT accepted — unexplained over-privilege/);
    expect(r.code).toBe(1);
  });

  /**
   * A credential that authorizes but cannot read the bucket leaves Object Lock
   * and lifecycle UNCHECKED. That must never be reported as a pass, and must
   * never be filed under "privilege" either — it is a different failure.
   */
  it('reports bucket access separately when the bucket cannot be read', async () => {
    state.capabilities = MASTER; state.restricted = false;
    const keep = state.bucket;
    state.bucket = null;
    const r = await audit(['--accept-privileged']);
    expect(r.out).toMatch(/2\. bucket access\s+: NOT VERIFIED/);
    expect(r.out).toMatch(/lock and lifecycle UNCHECKED/);
    expect(r.code).toBe(1);
    state.bucket = keep;
  });

  it('exposes all four in --json', async () => {
    state.capabilities = MASTER; state.restricted = false;
    const j = JSON.parse((await audit(['--accept-privileged', '--json'])).out);
    expect(j.authorizationOk).toBe(true);
    expect(j.bucketAccessOk).toBe(true);
    expect(j.intendedDesign).toMatch(/privileged-single-key/);
    expect(j.leastPrivilege).toBe(false);
    expect(j.privilegeDeviationsAccepted).toBe(true);
    expect(j.bucketConfigurationOk).toBe(true);
  });
});
