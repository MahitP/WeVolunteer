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
 * Usage:   node bin/b2-audit.mjs [--role=writer|recovery|drill] [--json]
 * Exit:    0 clean · 1 policy findings · 2 could not run
 */
import { b2ConfigFromEnv } from './lib/object-store.mjs';
import { auditPolicy } from './lib/b2-policy.mjs';

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

const call = async (name, body) => {
  const res = await fetch(`${api.apiUrl}/b2api/v3/${name}`, {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
};

const bucketsRes = api.bucketId
  ? await call('b2_list_buckets', { accountId: auth.accountId, bucketId: api.bucketId })
  : { ok: false, json: {} };
const bucket = bucketsRes.ok ? (bucketsRes.json.buckets ?? [])[0] ?? null : null;

let files = null;
if (api.bucketId) {
  const listed = await call('b2_list_file_versions', { bucketId: api.bucketId, prefix: `${cfg.prefix}/`, maxFileCount: 1000 });
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

if (JSON_OUT) {
  console.log(JSON.stringify({
    bucket: cfg.bucket, prefix: cfg.prefix, region: cfg.region, role: ROLE,
    capabilities: [...(api.capabilities ?? [])].sort(),
    restrictedToBucket: api.bucketName ?? null,
    namePrefix: api.namePrefix ?? null,
    notes, findings, ok: findings.length === 0,
  }, null, 2));
} else {
  console.log(`bucket ${cfg.bucket} · prefix ${cfg.prefix}/ · region ${cfg.region} · role ${ROLE}`);
  console.log(`key: ${(api.capabilities ?? []).length} capabilities, restricted to ${api.bucketName ?? 'EVERY BUCKET'}${api.namePrefix ? `, prefix ${api.namePrefix}` : ''}`);
  for (const n of notes) console.log(`  · ${n.id}: ${n.detail}`);
  if (findings.length === 0) console.log('\nOK — the bucket matches the policy the code assumes.');
  else {
    console.log(`\n${findings.length} finding(s):`);
    for (const f of findings) console.log(`  ✗ ${f.id}\n      ${f.detail}`);
  }
}
process.exit(findings.length === 0 ? 0 : 1);
