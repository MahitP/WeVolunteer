#!/usr/bin/env node
/**
 * Copy one finished, encrypted backup to Backblaze B2 — and prove the copy is real.
 *
 * Invoked by bin/backup-postgres.sh after the archive has been dumped, checked,
 * encrypted and described in its manifest. "The PUT returned 200" is not the claim
 * this makes. In order, it establishes:
 *
 *   1. uploaded          B2 accepted the object, with its SHA-256 (signed) and
 *                        Content-MD5 checked on receipt
 *   2. head-verified     B2 reports the expected size and the SHA-256 we stored
 *   3. download-verified the object was fetched back and hashes to the local bytes
 *
 * Decryption and a real restore are levels 4–6, and are the weekly drill's job
 * (bin/restore-drill-postgres.sh), which runs where the private key is. This
 * script never holds that key and never sees plaintext.
 *
 * Then it audits what the bucket actually retains — every version under the
 * prefix, including hidden ones — against the retention policy, because a
 * lifecycle rule that silently stopped working keeps minors' deleted records for
 * ever, and nothing else would notice.
 *
 * Usage:   node bin/backup-offsite.mjs <archive.dump.enc> <archive.manifest.json>
 *
 * Exit codes:
 *   0  verified, or no destination configured (a local backup still happened)
 *   1  a destination IS configured and any step failed — the caller keeps the
 *      local archive and does NOT prune
 *
 * Writes status/offsite.json either way. No credential ever reaches it, stdout,
 * or an error message.
 */
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  b2ConfigFromEnv, putObject, headObject, getObject, listObjectVersions, withRetry, archiveKey,
} from './lib/object-store.mjs';
import { readStatus, writeStatus } from './lib/backup-status-file.mjs';

const env = process.env;
const DAY = 86_400_000;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/** Policy knobs, each with the default the runbook justifies. */
export const POLICY = {
  retentionDays: num(env.WEV_OFFSITE_RETENTION_DAYS, 28),
  maxAgeDays: num(env.WEV_OFFSITE_MAX_AGE_DAYS, 33),
  /**
   * Object Lock is deliberately MUCH shorter than the retention window, and that
   * is not a compromise — it is the only safe arrangement.
   *
   * Backblaze's Object Lock documentation: "When a file is locked, lifecycle
   * settings or an integration setting attempting to change or delete the file
   * will fail." So a lock that outlives the lifecycle rule does not make backups
   * safer, it makes them permanent: every archive the rule tries to delete is
   * refused, storage grows without bound, and deleted students' records stay
   * off-site for ever. The lock exists to stop a deletion in the window where one
   * would be an attack or a mistake; the lifecycle rule exists to end retention.
   * They must not overlap.
   */
  lockDays: num(env.WEV_OFFSITE_LOCK_DAYS, 7),
  maxObjectBytes: num(env.WEV_OFFSITE_MAX_BYTES, 250 * 1024 * 1024),
  maxTotalBytes: num(env.WEV_OFFSITE_MAX_TOTAL_BYTES, 5 * 1024 ** 3),
  maxUploadsPerDay: num(env.WEV_OFFSITE_MAX_UPLOADS_PER_DAY, 4),
  /* First backoff step. The tests shorten it; production has no reason to. */
  retryBaseMs: num(env.WEV_OFFSITE_RETRY_BASE_MS, 1000),
};

const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const log = (m) => console.log(`${stamp()} ${m}`);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/**
 * The status file is how the Owner Center learns what happened, but failing to
 * write it must not change what happened: an unwritable status directory turns
 * into a stale reading there (which alerts), not into a failed backup here.
 */
function saveStatus(value) {
  try {
    writeStatus('offsite.json', value);
  } catch (err) {
    console.error(`${stamp()} WARNING: could not record off-site status: ${err.message}`);
  }
}

async function main() {
  const [archivePath, manifestPath] = process.argv.slice(2);
  const previous = readStatus('offsite.json') || {};
  const lastVerified = previous.state === 'verified' ? summarise(previous) : previous.lastVerified ?? null;

  const fail = (stage, message) => {
    saveStatus({ state: 'failed', stage, error: String(message).slice(0, 400), at: stamp(), lastVerified });
    console.error(`${stamp()} FAILED (${stage}): ${message}`);
    process.exit(1);
  };

  let config;
  try {
    config = b2ConfigFromEnv(env);
  } catch (err) {
    fail('configuration', err.message);
  }
  if (!config) {
    saveStatus({ state: 'unconfigured', at: stamp(), lastVerified });
    log('WARNING: no off-site destination configured (B2_* unset).');
    log('WARNING: this backup exists only on this host. If the host is lost, so is it.');
    process.exit(0);
  }

  if (!archivePath || !manifestPath) fail('arguments', 'usage: backup-offsite.mjs <archive.dump.enc> <manifest.json>');

  /* ── Inputs ─────────────────────────────────────────────────────────── */
  const fileName = path.basename(archivePath);
  if (!fileName.endsWith('.dump.enc')) {
    fail('refused-plaintext', `${fileName} is not an encrypted archive. Nothing unencrypted is ever sent off this host.`);
  }
  let archive; let manifestBytes; let manifest;
  try {
    archive = readFileSync(archivePath);
    manifestBytes = readFileSync(manifestPath);
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (err) {
    fail('read-local', err.message);
  }
  if (archive.length === 0) fail('read-local', 'the archive is empty');
  if (archive.length > POLICY.maxObjectBytes) {
    fail('size-cap', `archive is ${archive.length} bytes, over the ${POLICY.maxObjectBytes}-byte off-site cap. `
      + 'Uploads are immutable for the retention period, so an unexpectedly large object is refused, not stored. '
      + 'Investigate the database size, then raise WEV_OFFSITE_MAX_BYTES deliberately.');
  }
  const digest = sha256(archive);
  if (manifest.archive_sha256 && manifest.archive_sha256 !== digest) {
    fail('local-integrity', 'the archive no longer matches the SHA-256 recorded in its manifest — it changed after it was written');
  }

  const archiveObject = archiveKey(config.prefix, fileName);
  const manifestObject = archiveKey(config.prefix, path.basename(manifestPath));
  const retry = (label) => ({ baseMs: POLICY.retryBaseMs, onRetry: ({ attempt, waitMs, error }) => log(`retrying ${label} (attempt ${attempt} failed: ${error.message}; waiting ${waitMs} ms)`) });
  const warnings = [];

  /* ── Frequency guard ────────────────────────────────────────────────── */
  let versionsBefore = [];
  try {
    versionsBefore = await withRetry(() => listObjectVersions({ config, prefix: `${config.prefix}/daily/` }), retry('listing'));
  } catch (err) {
    // Only a capability refusal is tolerated. A wrong key or region is also a 403,
    // with a different code, and must fail here with the real reason — not be
    // downgraded to a warning and resurface as a confusing HEAD failure.
    if (err.status === 403 && err.code === 'AccessDenied') {
      warnings.push('audit-unverifiable: the key cannot list files, so frequency and retention are not checked');
    } else {
      fail('list', err.message);
    }
  }
  const recent = versionsBefore.filter((v) => !v.deleteMarker && v.key.endsWith('.dump.enc')
    && Date.now() - Date.parse(v.lastModified) < DAY && v.key !== archiveObject);
  if (recent.length >= POLICY.maxUploadsPerDay && env.WEV_OFFSITE_FORCE !== '1') {
    fail('frequency-guard', `${recent.length} archives were already uploaded in the last 24 hours (limit ${POLICY.maxUploadsPerDay}). `
      + 'Every upload is locked for the retention period, so a job running in a loop is stopped here. '
      + 'Set WEV_OFFSITE_FORCE=1 for one deliberate extra run.');
  }

  /* ── 1. Upload (idempotent) ─────────────────────────────────────────── */
  const t0 = Date.now();
  const uploadOnce = async (key, body, contentType, meta) => {
    const existing = await withRetry(() => headObject({ config, key }), retry(`HEAD ${path.basename(key)}`));
    if (existing) {
      if (existing.metadata.sha256 === meta.sha256 && existing.size === body.length) {
        log(`already present, identical: ${path.basename(key)}`);
        return { reused: true };
      }
      throw Object.assign(new Error(`an object named ${path.basename(key)} already exists with different content — refusing to add a second version`), { stage: 'collision' });
    }
    await withRetry(() => putObject({ config, key, body, contentType, metadata: meta, timeoutMs: 60_000 + body.length / 1024 }), retry(`PUT ${path.basename(key)}`));
    return { reused: false };
  };
  let archiveUpload;
  try {
    archiveUpload = await uploadOnce(archiveObject, archive, 'application/octet-stream', {
      sha256: digest, 'format-version': String(manifest.format_version ?? 1),
    });
    await uploadOnce(manifestObject, manifestBytes, 'application/json', { sha256: sha256(manifestBytes) });
  } catch (err) {
    fail(err.stage || 'upload', err.message);
  }
  log(`uploaded ${archiveObject} (${archive.length} bytes)${archiveUpload.reused ? ' [already present]' : ''}`);

  /* ── 2. HEAD verification ───────────────────────────────────────────── */
  let head;
  try {
    head = await withRetry(() => headObject({ config, key: archiveObject }), retry('HEAD verify'));
  } catch (err) {
    fail('head-verify', err.message);
  }
  if (!head) fail('head-verify', 'the object was not found immediately after upload');
  if (head.size !== archive.length) fail('head-verify', `B2 reports ${head.size} bytes, expected ${archive.length}`);
  if (head.metadata.sha256 !== digest) fail('head-verify', 'the SHA-256 stored with the object does not match the local archive');
  log('verified: B2 reports the expected size and SHA-256');

  /* ── 3. Download verification ───────────────────────────────────────── */
  let downloaded;
  try {
    downloaded = await withRetry(() => getObject({ config, key: archiveObject, timeoutMs: 60_000 + archive.length / 1024 }), retry('GET verify'));
  } catch (err) {
    fail('download-verify', err.message);
  }
  if (downloaded.length !== archive.length || sha256(downloaded) !== digest) {
    fail('download-verify', 'the downloaded object does not hash to the local archive — the off-site copy is not a copy');
  }
  log('verified: downloaded copy is byte-identical (SHA-256)');
  const elapsedMs = Date.now() - t0;

  /* ── Object Lock observation ────────────────────────────────────────── */
  let lock = null;
  if (head.lockMode && head.lockRetainUntil) {
    const uploadedAt = head.lastModified ? Date.parse(head.lastModified) : Date.now();
    const lockDays = Math.round(((Date.parse(head.lockRetainUntil) - uploadedAt) / DAY) * 10) / 10;
    lock = { mode: head.lockMode, retainUntil: head.lockRetainUntil, days: lockDays };
    // The dangerous direction first, because it is the one that fails silently:
    // a lock at or beyond the lifecycle window makes every expiry attempt fail,
    // and nothing else in the system would ever say so. The retention audit below
    // eventually notices (objects outlive maxAgeDays), but weeks later.
    if (lockDays >= POLICY.retentionDays) {
      warnings.push(`lock-blocks-expiry: objects are locked for ${lockDays} days but retention is ${POLICY.retentionDays} days. `
        + 'B2 refuses a lifecycle deletion of a locked file, so nothing will ever expire and deleted students\' records will be kept indefinitely. '
        + "Lower the bucket's default retention below the lifecycle window.");
    } else if (lockDays < POLICY.lockDays - 1) {
      warnings.push(`lock-short: objects are locked for ${lockDays} days, expected about ${POLICY.lockDays}`);
    }
  } else {
    warnings.push('lock-not-observed: B2 reported no Object Lock retention on the new object (lock disabled, or the key lacks readFileRetentions)');
  }

  /* ── Retention audit (every version, hidden ones included) ──────────── */
  let audit = null;
  try {
    const all = await withRetry(() => listObjectVersions({ config, prefix: `${config.prefix}/` }), retry('audit listing'));
    const data = all.filter((v) => !v.deleteMarker);
    const archives = data.filter((v) => v.key.endsWith('.dump.enc'));
    const oldest = data.reduce((min, v) => Math.min(min, Date.parse(v.lastModified)), Date.now());
    audit = {
      objects: data.length,
      archives: archives.length,
      noncurrent: data.filter((v) => !v.isLatest).length,
      deleteMarkers: all.length - data.length,
      totalBytes: data.reduce((s, v) => s + v.size, 0),
      oldestAgeDays: Math.round(((Date.now() - oldest) / DAY) * 10) / 10,
      uploadsLast24h: recent.length + (archiveUpload.reused ? 0 : 1),
    };
    if (audit.oldestAgeDays > POLICY.maxAgeDays) {
      warnings.push(`retention-violation: the oldest retained object is ${audit.oldestAgeDays} days old; nothing should outlive ${POLICY.maxAgeDays}. The bucket lifecycle rule is missing or not working`);
    }
    if (audit.totalBytes > POLICY.maxTotalBytes) {
      warnings.push(`storage-high: ${audit.totalBytes} bytes retained, above the ${POLICY.maxTotalBytes}-byte expectation`);
    }
  } catch (err) {
    warnings.push(`audit-unverifiable: ${err.message}`);
  }

  /* ── The drill's verdict, collected on the way past ──────────────────── */
  //
  // The restore drill runs on the operator's machine, because it has to decrypt
  // and this host deliberately holds no private key. Its verdict is published to
  // the bucket (bin/backup-drill-publish.mjs) and picked up here, so the Owner
  // Center on THIS host can say whether a restore has actually been demonstrated.
  // Without it that row reads "Never drilled" for ever on a system that is being
  // drilled every week, which is a false alarm, and a false alarm on the row that
  // matters most is worse than no row at all.
  //
  // Entirely best effort: a bucket without a drill record yet, a key that cannot
  // read it, or malformed JSON must not turn a verified off-site copy into a
  // failed backup.
  try {
    const body = await getObject({ config, key: `${config.prefix}/drills/latest.json` });
    const drill = JSON.parse(body.toString('utf8'));
    if (drill && typeof drill.at === 'string' && ['passed', 'failed'].includes(drill.state)) {
      const local = readStatus('restore-drill.json');
      // Never move the record backwards: a drill run by hand on this host is more
      // direct evidence than a published one, and whichever is newer is the truth.
      if (!local?.at || Date.parse(drill.at) > Date.parse(local.at)) {
        writeStatus('restore-drill.json', drill);
        log(`recorded the published restore drill (${drill.state}, from the ${drill.source} copy, ${drill.at})`);
      }
    }
  } catch (err) {
    if (err?.status !== 404) warnings.push(`drill-record-unavailable: ${err.message}`);
  }

  const prevBytes = lastVerified?.bytes;
  if (prevBytes && archive.length > 10 * 1024 * 1024 && archive.length > prevBytes * 5) {
    warnings.push(`size-jump: this archive is ${archive.length} bytes; the previous verified one was ${prevBytes}`);
  }

  const record = {
    state: 'verified',
    at: stamp(),
    archive: fileName,
    key: archiveObject,
    bytes: archive.length,
    sha256: digest,
    levels: { uploaded: true, headVerified: true, downloadVerified: true },
    elapsedMs,
    lock,
    audit,
    policy: { retentionDays: POLICY.retentionDays, maxAgeDays: POLICY.maxAgeDays, lockDays: POLICY.lockDays },
    warnings,
  };
  saveStatus({ ...record, lastVerified: summarise(record) });
  for (const w of warnings) log(`WARNING: ${w}`);
  log('OK — off-site copy uploaded and verified');
}

function summarise(r) {
  return r ? { at: r.at, archive: r.archive, bytes: r.bytes, sha256: r.sha256 } : null;
}

main().catch((err) => {
  console.error(`${stamp()} FAILED (unexpected): ${err.message}`);
  try {
    const previous = readStatus('offsite.json') || {};
    writeStatus('offsite.json', { state: 'failed', stage: 'unexpected', error: String(err.message).slice(0, 400), at: stamp(), lastVerified: previous.lastVerified ?? null });
  } catch { /* status is best effort; the exit code is the signal */ }
  process.exit(1);
});
