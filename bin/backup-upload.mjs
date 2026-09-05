#!/usr/bin/env node
/**
 * Copy a finished backup off the host it protects.
 *
 * A backup that lives only on the machine whose failure it exists to survive is
 * not off-site. This is the step that makes the nightly dump independent of
 * both the application host AND the database provider — the two things a
 * restore is most likely to be needed for.
 *
 * Invoked by bin/backup-postgres.sh once the archive is written, verified and
 * encrypted. Kept separate rather than inlined so it can be run by hand against
 * an older archive, and so its failure mode is a distinct exit code.
 *
 * Usage:
 *   node bin/backup-upload.mjs <file> [<file>...]
 *
 * Configuration (all four required, or none):
 *   R2_ACCOUNT_ID  R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY  R2_BUCKET
 *   R2_ENDPOINT    optional, for an S3-compatible store that is not R2
 *   R2_PREFIX      optional key prefix, e.g. "wevolunteer/production"
 *
 * Exit codes:
 *   0  uploaded, or no destination configured (a local backup still happened)
 *   1  a destination IS configured and the upload failed
 */
import { uploadFile, r2ConfigFromEnv } from './lib/r2-upload.mjs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node bin/backup-upload.mjs <file> [<file>...]');
  process.exit(2);
}

const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const log = (msg) => console.log(`${stamp()} ${msg}`);

let config;
try {
  config = r2ConfigFromEnv();
} catch (err) {
  // A partial configuration is a mistake, not a decision. Fail rather than
  // quietly skip: the operator believes off-site copies exist.
  console.error(`${stamp()} FAILED: ${err.message}`);
  process.exit(1);
}

if (!config) {
  log('WARNING: no off-site destination configured (R2_* unset).');
  log('WARNING: this backup exists only on this host. If the host is lost, so is it.');
  process.exit(0);
}

let failed = false;
for (const file of files) {
  try {
    const r = await uploadFile({ config, filePath: file, prefix: process.env.R2_PREFIX || '' });
    log(`uploaded ${r.key} (${r.bytes} bytes)`);
  } catch (err) {
    // Never echo the config. The message carries the provider's status only.
    console.error(`${stamp()} FAILED to upload ${file}: ${err.message}`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
