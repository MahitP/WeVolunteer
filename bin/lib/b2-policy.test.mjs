import { describe, it, expect } from 'vitest';
import { auditPolicy, ruleTotalDays, periodDays, REQUIRED_CAPABILITIES, FORBIDDEN_CAPABILITIES } from './b2-policy.mjs';

/**
 * The bucket settings a successful backup cannot tell you about.
 *
 * Every case here is shaped from a real `b2_list_buckets` / `b2_authorize_account`
 * response, because the two findings this file exists for were both *present and
 * wrong* rather than absent — `isFileLockEnabled: true` beside
 * `defaultRetention: {mode: null, period: null}`, and `lifecycleRules: []`. A
 * check written against an imagined shape would have read both as fine.
 */

const CONFIG = { bucket: 'wevolunteer-bucket', prefix: 'wevolunteer/backups/postgres' };

/** A correctly scoped writer key: exactly what the nightly backup needs. */
const goodKey = () => ({
  capabilities: [...REQUIRED_CAPABILITIES],
  keyScope: { bucketId: 'abc123', bucketName: 'wevolunteer-bucket', namePrefix: null, expiresAt: null },
});

/** A correctly configured bucket: private, locked 7 days, expiring at 28. */
const goodBucket = () => ({
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
  { fileName: 'wevolunteer/backups/postgres/daily/2026/09/14/wevolunteer-20260914T035746Z.dump.enc', action: 'upload', fileRetention: { value: { mode: 'governance' } } },
  { fileName: 'wevolunteer/backups/postgres/daily/2026/09/14/wevolunteer-20260914T035746Z.manifest.json', action: 'upload', fileRetention: { value: { mode: 'governance' } } },
]);

const run = (over = {}) => auditPolicy({
  ...goodKey(), bucket: goodBucket(), files: goodFiles(), config: CONFIG, retentionDays: 28, ...over,
});
const ids = (r) => r.findings.map((f) => f.id);

describe('a correctly configured bucket', () => {
  it('produces no findings', () => {
    const r = run();
    expect(r.findings, JSON.stringify(r.findings)).toEqual([]);
  });

  it('reports what it read, so a pass is legible rather than a bare OK', () => {
    const r = run();
    expect(r.notes.map((n) => n.id)).toContain('lock');
    expect(r.notes.find((n) => n.id === 'lifecycle').detail).toMatch(/= 28 days total/);
  });
});

describe('Object Lock', () => {
  /**
   * The finding that motivated the whole file. `isFileLockEnabled: true` with a
   * null default retention is the most misleading state the bucket can be in: the
   * console says Object Lock is on, and not one object is locked.
   */
  it('catches lock enabled with no default retention', () => {
    const b = goodBucket();
    b.fileLockConfiguration.value.defaultRetention = { mode: null, period: null };
    expect(ids(run({ bucket: b }))).toContain('lock-no-default-retention');
  });

  it('catches Object Lock not being enabled at all', () => {
    const b = goodBucket();
    b.fileLockConfiguration.value.isFileLockEnabled = false;
    const r = run({ bucket: b });
    expect(ids(r)).toContain('lock-disabled');
    /* And says the thing an operator most needs to know at that moment. */
    expect(r.findings.find((f) => f.id === 'lock-disabled').detail).toMatch(/cannot be enabled after creation/);
  });

  it('does not pass a lock it was not allowed to read', () => {
    const b = goodBucket();
    b.fileLockConfiguration.isClientAuthorizedToRead = false;
    expect(ids(run({ bucket: b }))).toContain('lock-unreadable');
  });

  it('notes compliance mode rather than silently accepting it', () => {
    const b = goodBucket();
    b.fileLockConfiguration.value.defaultRetention.mode = 'compliance';
    const r = run({ bucket: b });
    expect(r.findings).toEqual([]);
    expect(r.notes.find((n) => n.id === 'lock-mode').detail).toMatch(/cannot be undone by anyone/);
  });

  it('reports an archive that carries no retention', () => {
    const files = goodFiles();
    delete files[0].fileRetention;
    expect(ids(run({ files }))).toContain('archives-unlocked');
  });
});

describe('lifecycle', () => {
  it('catches a bucket with no rules at all', () => {
    const b = goodBucket();
    b.lifecycleRules = [];
    const r = run({ bucket: b });
    expect(ids(r)).toContain('lifecycle-missing');
    expect(r.findings[0].detail).toMatch(/nothing will ever expire/);
  });

  it('catches a rule that covers some other prefix', () => {
    const b = goodBucket();
    b.lifecycleRules = [{ fileNamePrefix: 'something/else/', daysFromUploadingToHiding: 27, daysFromHidingToDeleting: 1 }];
    expect(ids(run({ bucket: b }))).toContain('lifecycle-does-not-cover-prefix');
  });

  it('catches a rule that expires nothing', () => {
    const b = goodBucket();
    b.lifecycleRules = [{ fileNamePrefix: 'wevolunteer/backups/postgres/', daysFromUploadingToHiding: null, daysFromHidingToDeleting: null }];
    expect(ids(run({ bucket: b }))).toContain('lifecycle-inert');
  });

  /**
   * B2 retention is the SUM of the two stages. Reading a rule as an S3-style
   * "expire after N days" is how a 28-day policy silently becomes a 55-day one
   * with nobody changing a number.
   */
  it('adds the two stages rather than reading either as the window', () => {
    expect(ruleTotalDays({ daysFromUploadingToHiding: 27, daysFromHidingToDeleting: 1 })).toBe(28);
    expect(ruleTotalDays({ daysFromUploadingToHiding: 28, daysFromHidingToDeleting: 27 })).toBe(55);
    expect(ruleTotalDays({ daysFromUploadingToHiding: null, daysFromHidingToDeleting: 1 })).toBe(1);
    expect(ruleTotalDays({})).toBeNull();

    const b = goodBucket();
    b.lifecycleRules[0].daysFromHidingToDeleting = 28;     // 27 + 28 = 55, not 28
    const r = run({ bucket: b });
    expect(ids(r)).toContain('lifecycle-wrong-window');
    expect(r.findings.find((f) => f.id === 'lifecycle-wrong-window').detail).toMatch(/after 55 days; the policy is 28/);
  });

  /**
   * The incompatibility that makes both settings useless together: Backblaze
   * refuses a lifecycle deletion of a locked file, so a lock reaching the
   * lifecycle window means nothing ever expires.
   */
  it('catches a lock that outlasts the point the rule starts hiding', () => {
    const b = goodBucket();
    b.fileLockConfiguration.value.defaultRetention.period = { duration: 30, unit: 'days' };
    const r = run({ bucket: b });
    expect(ids(r)).toContain('lock-blocks-lifecycle');
    expect(r.findings.find((f) => f.id === 'lock-blocks-lifecycle').detail).toMatch(/nothing would expire/);
  });

  it('treats a lock expressed in years the same way', () => {
    expect(periodDays({ duration: 1, unit: 'years' })).toBe(365);
    const b = goodBucket();
    b.fileLockConfiguration.value.defaultRetention.period = { duration: 1, unit: 'years' };
    expect(ids(run({ bucket: b }))).toContain('lock-blocks-lifecycle');
  });

  it('accepts a rule whose prefix is broader than ours', () => {
    const b = goodBucket();
    b.lifecycleRules = [{ fileNamePrefix: 'wevolunteer/', daysFromUploadingToHiding: 27, daysFromHidingToDeleting: 1 }];
    expect(run({ bucket: b }).findings).toEqual([]);
  });
});

describe('the application key', () => {
  it('reports every capability a backup writer must not hold', () => {
    const r = run({ capabilities: [...REQUIRED_CAPABILITIES, ...Object.keys(FORBIDDEN_CAPABILITIES)] });
    const over = r.findings.filter((f) => f.id === 'key-over-privileged');
    expect(over).toHaveLength(Object.keys(FORBIDDEN_CAPABILITIES).length);
    /* Each says what it can do, not merely that it is present. */
    expect(over.find((f) => f.detail.includes('deleteFiles')).detail).toMatch(/destroy every backup/);
    expect(over.find((f) => f.detail.includes('bypassGovernance')).detail).toMatch(/makes the lock decorative/);
  });

  it('reports a capability the backup actually needs and does not have', () => {
    const r = run({ capabilities: ['listFiles', 'writeFiles'] });
    expect(r.findings.filter((f) => f.id === 'key-missing-capability')).toHaveLength(2);
    /* readFiles specifically: without it the download-verify step cannot run, and
       an upload that is never read back is not a verified copy. */
    expect(r.findings.some((f) => f.detail.includes('readFiles'))).toBe(true);
  });

  it('catches a key that is not restricted to one bucket', () => {
    expect(ids(run({ keyScope: { bucketId: null } }))).toContain('key-unrestricted-bucket');
  });

  it('catches a key scoped to a different bucket than the one configured', () => {
    expect(ids(run({ keyScope: { bucketId: 'x', bucketName: 'some-other-bucket' } })))
      .toContain('key-wrong-bucket');
  });

  it('accepts a prefix-restricted key that covers our prefix, and rejects one that does not', () => {
    expect(run({ keyScope: { bucketId: 'x', bucketName: 'wevolunteer-bucket', namePrefix: 'wevolunteer/backups/' } }).findings).toEqual([]);
    expect(ids(run({ keyScope: { bucketId: 'x', bucketName: 'wevolunteer-bucket', namePrefix: 'wevolunteer/uploads/' } })))
      .toContain('key-prefix-mismatch');
  });

  it('warns before a key expires rather than after', () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
    expect(ids(run({ keyScope: { ...goodKey().keyScope, expiresAt: soon } }))).toContain('key-expiring');
    const later = new Date(Date.now() + 200 * 86_400_000).toISOString();
    expect(ids(run({ keyScope: { ...goodKey().keyScope, expiresAt: later } }))).not.toContain('key-expiring');
  });
});

describe('what is in the bucket', () => {
  it('says so when there is no off-site copy at all', () => {
    expect(ids(run({ files: [] }))).toContain('no-archives');
  });

  it('refuses to call a public backup bucket acceptable', () => {
    expect(ids(run({ bucket: { ...goodBucket(), bucketType: 'allPublic' } }))).toContain('bucket-public');
  });

  it('reports an unencrypted archive as the incident it is', () => {
    const files = [...goodFiles(), { fileName: 'wevolunteer/backups/postgres/daily/2026/09/14/wevolunteer-20260914T035746Z.dump', action: 'upload' }];
    expect(ids(run({ files }))).toContain('plaintext-archive');
  });

  /**
   * A bucket that could not be read must never come back clean. An audit that
   * reports a pass because it was refused is worse than no audit.
   */
  it('does not pass a bucket it could not read', () => {
    const r = auditPolicy({ ...goodKey(), bucket: null, files: null, config: CONFIG });
    expect(ids(r)).toContain('bucket-unreadable');
    expect(r.findings.length).toBeGreaterThan(0);
  });
});

describe('the three roles, each with its own budget', () => {
  const withRole = (role, caps, scope = {}) => auditPolicy({
    capabilities: caps,
    keyScope: { bucketId: 'abc', bucketName: 'wevolunteer-bucket', namePrefix: null, expiresAt: null, ...scope },
    bucket: goodBucket(), files: goodFiles(), config: CONFIG, retentionDays: 28, role,
  });

  it('accepts each role configured exactly as §11a specifies', () => {
    expect(withRole('writer', ['listFiles', 'readFiles', 'writeFiles', 'readFileRetentions']).findings).toEqual([]);
    expect(withRole('recovery', ['listFiles', 'readFiles']).findings).toEqual([]);
    expect(withRole('drill', ['listFiles', 'readFiles', 'writeFiles'],
      { namePrefix: 'wevolunteer/backups/postgres/drills/' }).findings).toEqual([]);
  });

  /**
   * The case a single shared capability list cannot express.
   *
   * `writeFiles` is required for the writer and disqualifying for the recovery
   * key. Audited against the writer's budget, a writable recovery key passes —
   * which is exactly the credential you do not want on the machine used on the
   * worst day.
   */
  it('rejects a recovery key that can write, though a writer audit would pass it', () => {
    const caps = ['listFiles', 'readFiles', 'writeFiles'];
    expect(withRole('writer', caps).findings.filter(f => f.id === 'key-over-privileged')).toEqual([]);
    const bad = withRole('recovery', caps).findings;
    expect(bad.map(f => f.id)).toContain('key-over-privileged');
    expect(bad.find(f => f.id === 'key-over-privileged').detail).toMatch(/recovery key holds writeFiles/);
  });

  it('rejects any role holding a capability nobody may hold', () => {
    for (const role of ['writer', 'recovery', 'drill']) {
      const caps = ['listFiles', 'readFiles', 'writeFiles', 'readFileRetentions', 'deleteFiles'];
      const scope = role === 'drill' ? { namePrefix: 'wevolunteer/backups/postgres/drills/' } : {};
      expect(withRole(role, caps, scope).findings.map(f => f.id), role).toContain('key-over-privileged');
    }
  });

  /**
   * The drill key is defined by its confinement, so an unrestricted one fails
   * even though every capability it holds is individually allowed.
   */
  it('requires the drill key to be confined, and to the right prefix', () => {
    const caps = ['listFiles', 'readFiles', 'writeFiles'];
    expect(withRole('drill', caps).findings.map(f => f.id)).toContain('key-prefix-missing');
    expect(withRole('drill', caps, { namePrefix: 'wevolunteer/backups/postgres/' }).findings.map(f => f.id))
      .toContain('key-prefix-wrong');
    expect(withRole('drill', caps, { namePrefix: 'wevolunteer/backups/postgres/drills' }).findings).toEqual([]);
  });

  it('reports a role it does not know rather than passing it', () => {
    const r = withRole('superuser', ['listFiles']);
    expect(r.findings.map(f => f.id)).toContain('unknown-role');
  });

  it('notes capabilities beyond the role without failing on harmless ones', () => {
    const r = withRole('writer', ['listFiles', 'readFiles', 'writeFiles', 'readFileRetentions', 'shareFiles']);
    expect(r.findings).toEqual([]);
    expect(r.notes.find(n => n.id === 'key-extra-capabilities').detail).toMatch(/shareFiles/);
  });

  it('still requires every role to be restricted to the bucket', () => {
    expect(withRole('recovery', ['listFiles', 'readFiles'], { bucketId: null }).findings.map(f => f.id))
      .toContain('key-unrestricted-bucket');
  });
});
