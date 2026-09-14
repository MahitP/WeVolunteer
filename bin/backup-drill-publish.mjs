#!/usr/bin/env node
/**
 * Carry a restore drill's verdict back to the host that takes the backups.
 *
 * ── The gap this closes ──
 *
 * The drill cannot run on the production host. It has to decrypt, and the whole
 * point of encrypting to a public key is that the host holds no private key — so
 * it runs on the operator's machine, where the key already is. That is also the
 * better drill, because it exercises the path a real disaster uses.
 *
 * But the Owner Center runs on the host. Left alone, the one fact worth more than
 * any other — "a restore has actually been demonstrated, from the off-site copy,
 * within the last week" — would be invisible on the only surface anybody looks
 * at, and the drill row would read "Never drilled" for ever. A permanent false
 * alarm is not better than no signal: it is the thing that teaches people to
 * ignore the row that matters.
 *
 * So the verdict travels the way everything else between these two machines
 * travels — through the bucket. The drill machine writes one small JSON object;
 * bin/backup-offsite.mjs reads it on the next nightly run and records it locally.
 *
 * ── What may be in it ──
 *
 * Counts, durations, table and index totals, a migration number, an archive file
 * name, and a stage name if it failed. No student data, no connection string, no
 * key, and nothing that identifies a person — the same rule the manifest follows,
 * for the same reason: this object is readable by anything holding the bucket's
 * read key.
 *
 * Usage:   node bin/backup-drill-publish.mjs <restore-drill.json>
 *
 * Exit codes: 0 published, or B2 is not configured (the drill still happened and
 * still wrote its local record). 1 only if publishing was attempted and failed.
 */
import { readFileSync } from 'node:fs';
import { b2ConfigFromEnv, putObject, withRetry } from './lib/object-store.mjs';

const [source] = process.argv.slice(2);
const die = (m) => { console.error(`FAILED: ${m}`); process.exit(1); };

if (!source) die('usage: backup-drill-publish.mjs <restore-drill.json>');

/**
 * Publishing uses its OWN credential, and that is the whole point of it.
 *
 * A Backblaze application key carries a single `namePrefix` that applies to every
 * capability it holds — there is no per-capability prefix. So one key cannot both
 * read archives under `…/daily/` and write only under `…/drills/`: restrict it to
 * the drills prefix and it can no longer fetch the archive it is meant to drill;
 * leave it unrestricted and a compromised drill machine can write anywhere under
 * the backup prefix.
 *
 * The runbook's first draft of the key table asked for exactly that impossible
 * key. The arrangement that works is two credentials on the drill machine: the
 * read-only recovery key for `bin/backup-fetch.mjs`, and a separate write key —
 * `B2_DRILL_*` — restricted to `…/drills/`, used only here.
 *
 * Falling back to `B2_*` keeps a single-key deployment working and is what the
 * tests exercise; it is logged, because a deployment that believes it has split
 * the credential and has not should be able to see that from the output.
 */
const drillEnv = { ...process.env };
if (process.env.B2_DRILL_KEY_ID && process.env.B2_DRILL_APPLICATION_KEY) {
  drillEnv.B2_KEY_ID = process.env.B2_DRILL_KEY_ID;
  drillEnv.B2_APPLICATION_KEY = process.env.B2_DRILL_APPLICATION_KEY;
} else if (process.env.B2_KEY_ID) {
  console.error('note: B2_DRILL_* is not set — publishing with the general B2 credential.');
}

let config;
try { config = b2ConfigFromEnv(drillEnv); } catch (err) { die(err.message); }
if (!config) {
  console.error('B2 is not configured; the drill result stays on this machine only.');
  process.exit(0);
}

let record;
try {
  record = JSON.parse(readFileSync(source, 'utf8'));
} catch (err) {
  die(`could not read the drill record: ${err.message}`);
}

/**
 * Rebuilt field by field rather than forwarded.
 *
 * Whatever the drill wrote locally is the drill's business; what leaves this
 * machine is this list and nothing else. Forwarding the object wholesale would
 * mean any field added to the local record later is published without anyone
 * deciding it should be.
 */
const published = {
  state: record.state === 'passed' ? 'passed' : 'failed',
  at: typeof record.at === 'string' ? record.at.slice(0, 32) : new Date().toISOString(),
  source: record.source === 'offsite' ? 'offsite' : 'local',
  archive: typeof record.archive === 'string' ? record.archive.slice(0, 128) : null,
  archiveAgeHours: Number.isFinite(record.archiveAgeHours) ? record.archiveAgeHours : null,
  stage: typeof record.stage === 'string' ? record.stage.slice(0, 64) : null,
  error: typeof record.error === 'string' ? record.error.slice(0, 300) : null,
  elapsedSeconds: Number.isFinite(record.elapsedSeconds) ? record.elapsedSeconds : null,
  result: record.result && typeof record.result === 'object' ? record.result : null,
  /* Which machine says so. A host name is not personal data and it is the first
     thing an operator wants when two people both drill. */
  drilledBy: String(process.env.WEV_DRILL_LABEL || 'operator').slice(0, 64),
};

const body = Buffer.from(`${JSON.stringify(published, null, 2)}\n`, 'utf8');
const key = `${config.prefix}/drills/latest.json`;

try {
  await withRetry(() => putObject({ config, key, body, contentType: 'application/json' }));
} catch (err) {
  die(`could not publish the drill result: ${err.message}`);
}
console.error(`published the drill result to ${key} (${published.state}, from the ${published.source} copy)`);
