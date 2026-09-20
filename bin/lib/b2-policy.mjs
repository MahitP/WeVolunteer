/**
 * Does a bucket's configuration match the policy the off-site code assumes?
 *
 * Separated from bin/b2-audit.mjs, which fetches, so that the judgement can be
 * tested without an account. The two settings this exists for are both invisible
 * from inside a successful backup — the upload works identically whether or not
 * they are right — so they are exactly the kind of thing that stays wrong for
 * months unless something asks on purpose.
 *
 * Every function here is pure: it is handed what Backblaze said and returns
 * findings. No network, no credentials, no process exit.
 */

/**
 * What the nightly backup needs. `readFiles` is required and that is deliberate:
 * the job downloads the object back and compares hashes, because an upload that
 * is never read back is not a verified copy, it is a 200 response.
 */
export const REQUIRED_CAPABILITIES = Object.freeze(['listFiles', 'readFiles', 'writeFiles', 'readFileRetentions']);

/**
 * What a backup writer must NOT hold, each with the reason.
 *
 * A finding an operator cannot act on gets closed rather than fixed, so the
 * consequence travels with the capability name.
 */
export const FORBIDDEN_CAPABILITIES = Object.freeze({
  deleteFiles: 'can destroy every backup. Expiry belongs to the lifecycle rule, not to the application',
  bypassGovernance: 'can delete objects the Object Lock is protecting, which makes the lock decorative',
  writeBucketRetentions: 'can turn off the Object Lock default that protects every future upload',
  writeBucketLifecycleRules: 'can change or remove the rule that enforces the retention policy',
  writeBuckets: 'can change the bucket itself, including making it public',
  writeKeys: 'can mint a key with any capability, so every limit above is advisory',
  deleteKeys: 'can revoke the recovery key',
});

/**
 * The three credentials, and what each is allowed to be.
 *
 * Checked per role rather than against one list, because "least privilege" means
 * something different for each: the writer must be able to write and must not be
 * able to delete; the recovery key must not be able to write AT ALL, which is a
 * stronger claim than the writer's budget; the drill publisher must be able to
 * write and must be confined to the drills prefix.
 *
 * ── Why the drill key is a SECOND credential on the drill machine ──
 *
 * A Backblaze key carries one `namePrefix` covering every capability it holds.
 * So a key restricted to `…/drills/` cannot read `…/daily/`, and a key that can
 * read `…/daily/` cannot be confined to `…/drills/`. The first draft of the
 * runbook asked for a single drill key that did both, which cannot exist. The
 * drill machine therefore holds the read-only recovery key for fetching and this
 * write-only key for publishing its verdict.
 */
export const ROLE_SPECS = Object.freeze({
  writer: {
    required: ['listFiles', 'readFiles', 'writeFiles', 'readFileRetentions'],
    forbidden: [],
    prefix: null,
    note: 'the nightly backup: uploads, then reads back to prove the copy',
  },
  recovery: {
    required: ['listFiles', 'readFiles'],
    /* Beyond the shared list: a recovery key that can write is not a recovery
       key. It exists to be used on the worst day, from a machine that may not be
       trusted, and it must not be able to change what it is reading. */
    forbidden: ['writeFiles'],
    prefix: null,
    note: 'rebuilding after the host is lost: list and read, nothing else',
  },
  drill: {
    required: ['listFiles', 'readFiles', 'writeFiles'],
    forbidden: [],
    prefix: 'wevolunteer/backups/postgres/drills/',
    note: 'publishing the weekly drill verdict, and nothing outside the drills prefix',
  },
});

/**
 * Findings that describe how much the credential CAN do, rather than whether the
 * bucket is configured correctly.
 *
 * Separated because they are the only ones an owner can legitimately accept. A
 * bucket with no lifecycle rule is wrong however you feel about it; a credential
 * that holds more capability than the job needs is a risk somebody is entitled to
 * take with their own account, provided it is taken knowingly and written down.
 *
 * Accepting them does NOT hide them. `bin/b2-audit.mjs` still prints every one,
 * still says least privilege is not satisfied, and exits 3 rather than 0 — there
 * is deliberately no combination of flags that makes a master key report as a
 * clean pass, because a report nobody can distinguish from a real pass is how an
 * accepted risk quietly becomes a forgotten one.
 */
export const PRIVILEGE_FINDINGS = Object.freeze(new Set([
  'key-over-privileged',
  'key-unrestricted-bucket',
  'key-prefix-missing',
  'key-prefix-wrong',
]));

/** Split findings into the ones an owner may accept and the ones nobody may. */
export function partitionFindings(findings) {
  return {
    privilege: findings.filter((f) => PRIVILEGE_FINDINGS.has(f.id)),
    mandatory: findings.filter((f) => !PRIVILEGE_FINDINGS.has(f.id)),
  };
}

/** B2 expresses a lock period in days or years; the comparison needs one unit. */
export const periodDays = (period) => {
  if (!period || !Number.isFinite(period.duration)) return null;
  return period.unit === 'years' ? period.duration * 365 : period.duration;
};

/**
 * Total retention for a B2 lifecycle rule.
 *
 * The SUM of the two stages, not either one. Reading a B2 rule as an S3-style
 * "expire after N days" is how a 28-day policy silently becomes a 55-day one
 * without anybody changing a number.
 */
export const ruleTotalDays = (rule) => {
  const hide = rule?.daysFromUploadingToHiding;
  const del = rule?.daysFromHidingToDeleting;
  if (hide == null && del == null) return null;
  return (hide ?? 0) + (del ?? 0);
};

const trimSlash = (s) => String(s ?? '').replace(/\/+$/, '');

/**
 * @param {object} input
 * @param {string[]} input.capabilities   the key's capabilities, per b2_authorize_account
 * @param {object}   input.keyScope       { bucketId, bucketName, namePrefix, expiresAt }
 * @param {object?}  input.bucket         a b2_list_buckets entry, or null if unreadable
 * @param {object[]?} input.files         b2_list_file_versions entries under the prefix, or null
 * @param {object}   input.config         { bucket, prefix }
 * @param {number}   input.retentionDays  the policy window the code enforces
 * @returns {{findings: {id: string, detail: string}[], notes: {id: string, detail: string}[]}}
 */
export function auditPolicy({ capabilities = [], keyScope = {}, bucket = null, files = null, config, retentionDays = 28, now = Date.now(), role = 'writer' }) {
  const findings = [];
  const notes = [];
  const fail = (id, detail) => findings.push({ id, detail });
  const note = (id, detail) => notes.push({ id, detail });
  const caps = new Set(capabilities);

  /* ── The key ───────────────────────────────────────────────────────────── */

  const spec = ROLE_SPECS[role];
  if (!spec) {
    fail('unknown-role', `"${role}" is not one of ${Object.keys(ROLE_SPECS).join(', ')}`);
    return { findings, notes };
  }
  note('role', `${role} — ${spec.note}`);

  for (const c of spec.required) {
    if (!caps.has(c)) fail('key-missing-capability', `the ${role} key lacks ${c}, which it needs to do its job`);
  }
  for (const [c, why] of Object.entries(FORBIDDEN_CAPABILITIES)) {
    if (caps.has(c)) fail('key-over-privileged', `the ${role} key holds ${c} — it ${why}`);
  }
  /* Per-role extras: a capability that is legitimate for one credential and
     disqualifying for another. `writeFiles` on the recovery key is the case. */
  for (const c of spec.forbidden) {
    if (caps.has(c)) {
      fail('key-over-privileged', `the ${role} key holds ${c}, which this role must not have — ${spec.note}`);
    }
  }
  /* A capability nobody asked for is still a capability somebody can use. */
  const extra = [...caps].filter((c) => !spec.required.includes(c)
    && !Object.keys(FORBIDDEN_CAPABILITIES).includes(c) && !spec.forbidden.includes(c));
  if (extra.length) note('key-extra-capabilities', `beyond this role's needs: ${extra.sort().join(', ')}`);
  if (!keyScope.bucketId) {
    fail('key-unrestricted-bucket', 'the key is not restricted to one bucket, so it reaches every bucket in the account');
  } else if (keyScope.bucketName && keyScope.bucketName !== config.bucket) {
    fail('key-wrong-bucket', `the key is restricted to "${keyScope.bucketName}" but B2_BUCKET is "${config.bucket}"`);
  }
  if (spec.prefix) {
    /* This role is DEFINED by its confinement, so an unrestricted key fails. */
    if (!keyScope.namePrefix) {
      fail('key-prefix-missing',
        `the ${role} key is not restricted by name prefix. It must be confined to "${spec.prefix}", `
        + 'or a compromised drill machine can write anywhere under the backup prefix');
    } else if (trimSlash(keyScope.namePrefix) !== trimSlash(spec.prefix)) {
      fail('key-prefix-wrong', `the ${role} key is confined to "${keyScope.namePrefix}", expected "${spec.prefix}"`);
    } else {
      note('key-prefix-restricted', `confined to "${keyScope.namePrefix}"`);
    }
  } else if (keyScope.namePrefix) {
    note('key-prefix-restricted', `the key is restricted to the prefix "${keyScope.namePrefix}"`);
    if (!`${config.prefix}/`.startsWith(trimSlash(keyScope.namePrefix))) {
      fail('key-prefix-mismatch', `the key's prefix "${keyScope.namePrefix}" does not cover "${config.prefix}/"`);
    }
  }
  if (keyScope.expiresAt) {
    const days = Math.round((new Date(keyScope.expiresAt).getTime() - now) / 86_400_000);
    if (days < 30) fail('key-expiring', `the key expires in ${days} days (${new Date(keyScope.expiresAt).toISOString()})`);
    else note('key-expires', `${new Date(keyScope.expiresAt).toISOString()} (${days} days)`);
  }

  /* ── The bucket ────────────────────────────────────────────────────────── */

  let lockDays = null;

  if (!bucket) {
    fail('bucket-unreadable', 'the bucket configuration could not be read — Object Lock and lifecycle are UNCHECKED');
    return { findings, notes };
  }

  if (bucket.bucketType !== 'allPrivate') {
    fail('bucket-public', `the bucket type is "${bucket.bucketType}" — every archive is world-readable`);
  }

  const lock = bucket.fileLockConfiguration;
  if (!lock?.isClientAuthorizedToRead) {
    fail('lock-unreadable', "the key cannot read the bucket's Object Lock configuration, so it is UNCHECKED");
  } else if (!lock.value?.isFileLockEnabled) {
    fail('lock-disabled', 'Object Lock is not enabled on the bucket, and it cannot be enabled after creation');
  } else {
    const dr = lock.value.defaultRetention ?? {};
    lockDays = dr.mode ? periodDays(dr.period) : null;
    if (!dr.mode || lockDays == null) {
      /* The finding that motivated this file. */
      fail('lock-no-default-retention',
        'Object Lock is enabled but the bucket applies NO default retention, so every object uploads unlocked. '
        + 'Enabled-and-applying-nothing reads as protected and protects nothing');
    } else {
      note('lock', `${dr.mode} for ${dr.period.duration} ${dr.period.unit}`);
      if (dr.mode !== 'governance') {
        note('lock-mode', `mode is "${dr.mode}" — compliance cannot be undone by anyone, including you`);
      }
    }
  }

  const rules = bucket.lifecycleRules ?? [];
  const covering = rules.filter((r) => {
    const p = trimSlash(r.fileNamePrefix);
    return p === '' || `${config.prefix}/`.startsWith(p);
  });

  if (rules.length === 0) {
    fail('lifecycle-missing', 'the bucket has NO lifecycle rules — nothing will ever expire, and deleted records stay off-site indefinitely');
  } else if (covering.length === 0) {
    fail('lifecycle-does-not-cover-prefix',
      `no lifecycle rule covers "${config.prefix}/" (rules cover: ${rules.map((r) => r.fileNamePrefix || '(all)').join(', ')})`);
  } else {
    for (const r of covering) {
      const total = ruleTotalDays(r);
      if (total == null) {
        fail('lifecycle-inert', `the rule for "${r.fileNamePrefix}" sets neither hiding nor deleting, so it expires nothing`);
        continue;
      }
      note('lifecycle', `"${r.fileNamePrefix}" hide ${r.daysFromUploadingToHiding ?? 'never'} + delete ${r.daysFromHidingToDeleting ?? 'never'} = ${total} days total`);

      const hide = r.daysFromUploadingToHiding;
      if (lockDays != null && hide != null && lockDays >= hide) {
        fail('lock-blocks-lifecycle',
          `objects are locked for ${lockDays} days but the rule hides them at ${hide} days. `
          + 'Backblaze refuses a lifecycle change or deletion of a locked file, so nothing would expire');
      }
      if (total !== retentionDays) {
        fail('lifecycle-wrong-window', `the rule expires objects after ${total} days; the policy is ${retentionDays}`);
      }
    }
  }

  /* ── What is actually stored ───────────────────────────────────────────── */

  if (files) {
    const archives = files.filter((f) => f.fileName.endsWith('.dump.enc') && f.action === 'upload');
    const unlocked = archives.filter((f) => !f.fileRetention?.value?.mode);
    const plain = files.filter((f) => f.fileName.endsWith('.dump'));
    note('objects', `${files.length} versions under the prefix, ${archives.length} archives`);
    if (archives.length === 0) {
      fail('no-archives', 'the bucket holds no archives under the configured prefix — there is no off-site copy');
    }
    if (unlocked.length > 0) {
      fail('archives-unlocked', `${unlocked.length} archive(s) carry no Object Lock retention`);
    }
    if (plain.length > 0) {
      fail('plaintext-archive', `${plain.length} UNENCRYPTED archive(s) are in the bucket`);
    }
  }

  return { findings, notes };
}
