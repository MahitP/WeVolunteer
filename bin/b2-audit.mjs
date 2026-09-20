#!/usr/bin/env node
/**
 * Does the real bucket match the policy the code assumes?
 *
 * ── Why this exists ──
 *
 * Everything else in the off-site path verifies the ARCHIVE. Nothing verified the
 * BUCKET, and the first look at a real one (2026-09-14) found two settings the
 * application silently depends on that nobody had set:
 *
 *   - Object Lock was enabled with `defaultRetention: {mode: null, period: null}`.
 *     Enabled and applying nothing: every object would have uploaded unlocked
 *     while the runbook said objects were locked.
 *   - `lifecycleRules: []`. Nothing would EVER have expired — the exact opposite
 *     of the 28-day policy, and a silent contradiction of the published deletion
 *     commitment. The only thing that would eventually have noticed is the
 *     nightly `retention-violation` warning, 33 days later.
 *
 * Both are invisible from inside a successful backup: the upload works perfectly
 * either way. So they need their own check, re-runnable rather than a line in a
 * report saying somebody looked once.
 *
 * The judgement lives in bin/lib/b2-policy.mjs so it can be tested without an
 * account; this file is the part that fetches.
 *
 * ── What it costs, and what it touches ──
 *
 * Three Class C calls, free on pay-as-you-go. It uploads nothing, deletes
 * nothing and changes nothing — every check is read-only.
 *
 * Nothing secret is printed: not the key id, not the application key, not the
 * authorization token. A key too restricted to read something reports "UNCHECKED"
 * rather than passing it, because an audit that reports a pass because it was
 * refused is worse than no audit.
 *
 * ── When the credential is deliberately over-privileged ──
 *
 * WeVolunteer's owner has chosen to run the nightly backup with a single highly
 * privileged Backblaze key rather than the three scoped ones. That is an
 * owner-level decision about their own account, and this tool's job is to report
 * it accurately, not to argue with it.
 *
 * `--accept-privileged` says the deviation is known and owned. It does NOT
 * suppress anything: every capability finding is still printed, the summary still
 * says least privilege is not satisfied, and the exit code is **3**, never 0.
 * There is deliberately no flag combination that makes a master key report as a
 * clean pass — a report nobody can tell apart from a real one is how an accepted
 * risk becomes a forgotten one. Bucket findings are never acceptable and still
 * exit 1 regardless.
 *
 * Usage:   node bin/b2-audit.mjs [--role=writer|recovery|drill] [--accept-privileged] [--json]
 * Exit:    0 clean · 1 policy findings · 2 could not run
 *          3 bucket correct, credential privilege deviations ACCEPTED by the owner
 */
import { b2ConfigFromEnv } from './lib/object-store.mjs';
import { auditPolicy, partitionFindings } from './lib/b2-policy.mjs';

const JSON_OUT = process.argv.includes('--json');
/**
 * Which credential is being audited.
 *
 * Defaults to `writer`, which is what the nightly host runs and what this tool
 * checked before the three-key layout existed. `--role=recovery` and
 * `--role=drill` check the other two against their own budgets — "least
 * privilege" is a different set for each, and a recovery key that can write
 * would pass a writer audit while being exactly wrong.
 */
const ROLE = (process.argv.find((a) => a.startsWith('--role='))?.split('=')[1]) || 'writer';
/** See the header: acknowledges capability findings, hides none of them. */
const ACCEPT_PRIVILEGED = process.argv.includes('--accept-privileged')
  || process.env.WEV_B2_ACCEPT_PRIVILEGED_CREDENTIAL === '1';
const NATIVE_API = process.env.B2_NATIVE_API || 'https://api.backblazeb2.com';
const die = (m) => { console.error(`FAILED: ${m}`); process.exit(2); };

let cfg;
try {
  cfg = b2ConfigFromEnv(process.env);
} catch (err) {
  die(err.message);
}
if (!cfg) die('B2_* is not configured — there is no bucket to audit.');

/* The native API, not S3: it is the only one that reports a key's own
   capabilities and a bucket's lock and lifecycle configuration. */
const authRes = await fetch(`${NATIVE_API}/b2api/v3/b2_authorize_account`, {
  headers: { Authorization: `Basic ${Buffer.from(`${cfg.accessKeyId}:${cfg.secretAccessKey}`).toString('base64')}` },
}).catch(() => null);

if (!authRes?.ok) die(`could not authorize against Backblaze (HTTP ${authRes?.status ?? 'no response'}).`);
const auth = await authRes.json();
const api = auth.apiInfo.storageApi;
/* Reaching here means Backblaze accepted the credential. Reported as its own
   fact because "the key works" and "the key is appropriately scoped" are
   different questions, and a privileged-credential deployment needs the first
   answered plainly without the second being implied. */
const authorizationOk = true;

const call = async (name, body) => {
  const res = await fetch(`${api.apiUrl}/b2api/v3/${name}`, {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
};

/**
 * Look the bucket up by id when the key is restricted to one, by NAME when it is
 * not.
 *
 * An unrestricted key — a master key, or any key spanning the account — carries
 * no `bucketId` in its authorize response. Keying the lookup on that id alone
 * meant the bucket was never fetched for exactly those credentials, so the audit
 * reported `bucket-unreadable` and "bucket configuration: NOT VERIFIED" for a
 * bucket that was perfectly configured and perfectly readable. The Object Lock
 * and lifecycle checks — the two this tool exists for — silently did not run on
 * the one credential type that can see everything.
 */
const bucketQuery = api.bucketId
  ? { accountId: auth.accountId, bucketId: api.bucketId }
  : { accountId: auth.accountId, bucketName: cfg.bucket };
const bucketsRes = await call('b2_list_buckets', bucketQuery);
const bucket = bucketsRes.ok ? (bucketsRes.json.buckets ?? [])[0] ?? null : null;

let files = null;
/* The id from the lookup, so the file listing works for an unrestricted key too. */
const bucketId = api.bucketId ?? bucket?.bucketId ?? null;
if (bucketId) {
  const listed = await call('b2_list_file_versions', { bucketId, prefix: `${cfg.prefix}/`, maxFileCount: 1000 });
  if (listed.ok) files = listed.json.files ?? [];
}

const { findings, notes } = auditPolicy({
  capabilities: api.capabilities ?? [],
  keyScope: {
    bucketId: api.bucketId, bucketName: api.bucketName, namePrefix: api.namePrefix,
    expiresAt: auth.applicationKeyExpirationTimestamp ?? null,
  },
  bucket,
  files,
  config: { bucket: cfg.bucket, prefix: cfg.prefix },
  retentionDays: Number(process.env.WEV_OFFSITE_RETENTION_DAYS) || 28,
  role: ROLE,
});

const { privilege, mandatory } = partitionFindings(findings);
const leastPrivilege = privilege.length === 0;
/* Could we actually read what we came to check? A key that authorizes but cannot
   see the bucket leaves Object Lock and lifecycle UNCHECKED, which must never be
   reported as either a pass or a privilege question. */
const bucketAccessOk = bucket !== null;
/* What this deployment INTENDS, so the report distinguishes a deliberate
   privileged credential from an accidental one. */
const intendedDesign = ACCEPT_PRIVILEGED ? 'privileged-single-key (owner decision)' : 'least-privilege';
/* 0 clean · 3 accepted deviations · 1 something nobody may accept. */
const exitCode = mandatory.length > 0 ? 1
  : privilege.length === 0 ? 0
    : ACCEPT_PRIVILEGED ? 3 : 1;

if (JSON_OUT) {
  console.log(JSON.stringify({
    bucket: cfg.bucket, prefix: cfg.prefix, region: cfg.region, role: ROLE,
    capabilities: [...(api.capabilities ?? [])].sort(),
    restrictedToBucket: api.bucketName ?? null,
    namePrefix: api.namePrefix ?? null,
    notes,
    findings,
    /* Four separate claims, never collapsed into one boolean. */
    authorizationOk,
    bucketAccessOk,
    intendedDesign,
    bucketConfigurationOk: mandatory.length === 0,
    leastPrivilege,
    privilegeDeviationsAccepted: ACCEPT_PRIVILEGED && privilege.length > 0,
    privilegeFindings: privilege,
    mandatoryFindings: mandatory,
    exitCode,
  }, null, 2));
} else {
  console.log(`bucket ${cfg.bucket} · prefix ${cfg.prefix}/ · region ${cfg.region} · role ${ROLE}`);
  console.log(`key: ${(api.capabilities ?? []).length} capabilities, restricted to ${api.bucketName ?? 'EVERY BUCKET'}${api.namePrefix ? `, prefix ${api.namePrefix}` : ''}`);
  for (const n of notes) console.log(`  \u00b7 ${n.id}: ${n.detail}`);

  if (mandatory.length > 0) {
    console.log(`\n${mandatory.length} bucket/configuration finding(s) — these are not acceptable:`);
    for (const f of mandatory) console.log(`  \u2717 ${f.id}\n      ${f.detail}`);
  } else {
    console.log('\nBucket configuration: OK (private, Object Lock, lifecycle, prefix).');
  }

  if (privilege.length > 0) {
    const header = ACCEPT_PRIVILEGED
      ? `${privilege.length} credential-privilege finding(s) — ACCEPTED by the owner, NOT fixed:`
      : `${privilege.length} credential-privilege finding(s):`;
    console.log(`\n${header}`);
    for (const f of privilege) console.log(`  ${ACCEPT_PRIVILEGED ? '!' : '\u2717'} ${f.id}\n      ${f.detail}`);
  }

  console.log('\n--------------------------------------------------------------');
  console.log(`  1. authorization     : ${authorizationOk ? 'VERIFIED (Backblaze accepted the credential)' : 'NOT VERIFIED'}`);
  console.log(`  2. bucket access     : ${bucketAccessOk ? 'VERIFIED (configuration readable)' : 'NOT VERIFIED \u2014 lock and lifecycle UNCHECKED'}`);
  console.log(`  3. intended design   : ${intendedDesign}`);
  console.log(`  4. least privilege   : ${leastPrivilege ? 'SATISFIED' : 'NOT SATISFIED'}`);
  if (!leastPrivilege) {
    console.log(`     \u21b3 deviation     : ${ACCEPT_PRIVILEGED
      ? 'INTENTIONAL owner decision \u2014 accepted, residual risk retained'
      : 'NOT accepted \u2014 unexplained over-privilege'}`);
  }
  console.log(`  bucket configuration : ${mandatory.length === 0 ? 'VERIFIED' : 'NOT VERIFIED'}`);
  console.log(`  exit                 : ${exitCode}${exitCode === 3 ? '  (not a pass \u2014 accepted deviations)' : ''}`);
  console.log('--------------------------------------------------------------');
}
process.exit(exitCode);
