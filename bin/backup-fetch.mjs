#!/usr/bin/env node
/**
 * Fetch an encrypted backup and its manifest back out of Backblaze B2.
 *
 * Two callers, one tool, so the path exercised every week is the path used in a
 * real disaster:
 *
 *   - bin/restore-drill-postgres.sh, weekly on the operator's own machine — not
 *     on the host, which holds no private key and so cannot decrypt.
 *   - an operator rebuilding after the VM is lost, on a clean machine, with the
 *     separate recovery key from the password manager (read and list only).
 *
 * It verifies before it writes anything: the archive must hash to the SHA-256 in
 * its manifest AND to the SHA-256 B2 stored with the object. A file failing
 * either is never written at all, and the exit code is 1.
 *
 * Usage:
 *   node bin/backup-fetch.mjs --out <dir> --latest
 *   node bin/backup-fetch.mjs --out <dir> --archive wevolunteer-20260913T030356Z.dump.enc
 *   node bin/backup-fetch.mjs --list                  # what B2 holds, newest last
 *
 * Prints the local archive path on success (stdout, last line). Needs only the
 * B2_* variables; never a database URL, never the decryption key.
 */
import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { b2ConfigFromEnv, listObjectVersions, getObject, headObject, withRetry, archiveKey } from './lib/object-store.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const die = (m) => { console.error(`FAILED: ${m}`); process.exit(1); };

let config;
try { config = b2ConfigFromEnv(process.env); } catch (err) { die(err.message); }
if (!config) die('B2_* is not configured — there is no off-site copy to fetch from');

const versions = await withRetry(() => listObjectVersions({ config, prefix: `${config.prefix}/daily/` }))
  .catch((err) => die(`could not list the bucket: ${err.message}`));
const archives = versions
  .filter((v) => v.isLatest && !v.deleteMarker && v.key.endsWith('.dump.enc'))
  .map((v) => ({ ...v, name: path.basename(v.key) }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));   // UTC stamps: lexical order is chronological

if (flag('--list')) {
  for (const a of archives) console.log(`${a.name}\t${a.size}\t${a.lastModified}`);
  process.exit(0);
}

const out = value('--out') || die('--out <dir> is required');
const wanted = flag('--latest') ? archives[archives.length - 1]?.name : value('--archive');
if (!wanted) die(flag('--latest') ? 'the bucket holds no archives' : 'give --latest or --archive <name>');

const archiveObject = archiveKey(config.prefix, wanted);
const manifestName = wanted.replace(/\.dump\.enc$/, '.manifest.json');
const manifestObject = archiveKey(config.prefix, manifestName);

const head = await withRetry(() => headObject({ config, key: archiveObject })).catch((err) => die(err.message));
if (!head) die(`${wanted} is not in the bucket`);
const archive = await withRetry(() => getObject({ config, key: archiveObject, timeoutMs: 600_000 })).catch((err) => die(err.message));
const manifestBytes = await withRetry(() => getObject({ config, key: manifestObject })).catch((err) => die(`manifest: ${err.message}`));

let manifest;
try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { die('the manifest is not valid JSON'); }
const digest = sha256(archive);
if (head.metadata.sha256 && head.metadata.sha256 !== digest) die('the downloaded archive does not match the SHA-256 B2 stored with it');
if (manifest.archive_sha256 && manifest.archive_sha256 !== digest) die('the downloaded archive does not match the SHA-256 in its manifest');
if (!manifest.archive_sha256 && !head.metadata.sha256) die('neither the manifest nor B2 records a SHA-256 for this archive; its integrity cannot be established');

/**
 * Written to a `.partial` name and renamed into place.
 *
 * The archive is verified above, before anything is written, so the only thing
 * left to go wrong here is the write itself — a full disk part-way through. That
 * would leave a truncated `.dump.enc` on disk, and a truncated archive under a
 * name that looks like a recovered backup is the worst artifact this tool could
 * produce, on the day it is most likely to be used in a hurry.
 *
 * Renaming is atomic within a directory, so the final name never exists unless
 * the whole file does, and a failure leaves `.partial` — which nothing here or in
 * bin/verify-restore-postgres.sh will match. Nothing is deleted to achieve that,
 * which is deliberate: this tool runs in a disaster, sometimes into a directory
 * somebody typed, and it should have no path that removes a file at all.
 */
mkdirSync(out, { recursive: true, mode: 0o700 });
const archivePath = path.join(out, wanted);
try {
  const write = (finalPath, bytes) => {
    const partial = `${finalPath}.partial`;
    writeFileSync(partial, bytes, { mode: 0o600 });
    renameSync(partial, finalPath);
  };
  write(path.join(out, manifestName), manifestBytes);
  write(archivePath, archive);
} catch (err) {
  die(err.message);
}
console.error(`fetched ${wanted} (${archive.length} bytes), SHA-256 verified against ${manifest.archive_sha256 ? 'manifest' : ''}${manifest.archive_sha256 && head.metadata.sha256 ? ' and ' : ''}${head.metadata.sha256 ? 'B2 metadata' : ''}`);
console.log(archivePath);
