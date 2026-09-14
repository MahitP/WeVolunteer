#!/usr/bin/env node
/**
 * Scan the built client bundle for secrets.
 *
 * ── The gap this fills ──
 *
 * `bin/pre-commit-secret-scan.sh` scans what is being COMMITTED. That catches a
 * secret pasted into a source file, and it cannot catch the more likely
 * accident: a secret that is correctly kept out of the repository, correctly
 * stored in the environment, and then compiled into the bundle because someone
 * named it `VITE_SOMETHING`.
 *
 * Vite inlines every `VITE_`-prefixed variable at build time. There is no
 * runtime boundary and no warning — the value simply becomes a string literal
 * in a JavaScript file served to every visitor. The repository stays clean, the
 * pre-commit hook stays green, and the key is public.
 *
 * So this scans the OUTPUT, which is the only artefact that reflects what users
 * actually receive.
 *
 * ── Two kinds of check, because each misses what the other catches ──
 *
 *   1. VALUE matching. If a server-only variable is set in this environment,
 *      its literal value must not appear anywhere in dist/. This is exact and
 *      has no false positives, but it only works for variables that are set
 *      where the scan runs.
 *
 *   2. SHAPE matching. Vendor-prefixed key formats (sk_…, re_…, pcsk_…, a JWT,
 *      a PEM private key) are recognised by pattern, so a secret this process
 *      has never seen is still caught.
 *
 * ── Deliberately NOT flagged ──
 *
 * `VITE_AMPLITUDE_API_KEY` is a write-only ingest key. It is public by design —
 * every analytics SDK ships one — and flagging it would train everyone to
 * ignore this scan. Publicness is a property of the credential, not of where it
 * appears, and the allowlist below records that judgement explicitly rather
 * than leaving it implicit.
 *
 * Usage:
 *   node bin/scan-bundle-secrets.mjs [dist-dir]
 *
 * Exit codes:
 *   0  clean
 *   1  something that looks like a secret is in the bundle
 *   2  the bundle is missing — run `npm run build` first
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const DIST = path.resolve(process.argv[2] || 'dist');

if (!existsSync(DIST)) {
  console.error(`No bundle at ${DIST}. Run \`npm run build\` first.`);
  process.exit(2);
}

/**
 * Server-only variables whose values must never reach the client.
 *
 * Not derived from `process.env` wholesale: that would compare against PATH and
 * HOME and produce noise. This is the list of things that are actually secret.
 */
const SERVER_ONLY = [
  'JWT_SECRET', 'TFA_ENCRYPTION_KEY', 'DATABASE_URL', 'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET', 'PINECONE_API_KEY', 'UPSTASH_REDIS_REST_TOKEN',
  'BETTERSTACK_SOURCE_TOKEN', 'BETTERSTACK_API_TOKEN', 'BETTER_STACK_API_TOKEN',
  'BETTERSTACK_QUERY_PASSWORD', 'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_SECRET',
  'SMTP_PASS', 'ROUTING_API_KEY', 'R2_SECRET_ACCESS_KEY', 'R2_ACCESS_KEY_ID',
  'MAP_TILES_CARTO_KEY',
  /* The off-site backup credential. Added with the B2 uploader rather than after
     it, because a new secret that no scanner knows about is exactly the one that
     reaches a bundle: the list is the only thing standing between a server-only
     variable and a build that inlines it. The R2 pair above is kept — the names
     no longer appear in the tree, and a scanner that stops looking for a retired
     credential is how an old .env line survives a rename. */
  'B2_APPLICATION_KEY', 'B2_KEY_ID',
];

/**
 * Credentials that are public on purpose.
 *
 * A scanner that reports these is a scanner people learn to ignore, which is
 * worse than no scanner.
 */
const PUBLIC_BY_DESIGN = ['VITE_AMPLITUDE_API_KEY'];

const SHAPES = [
  { name: 'private key block',   re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'PostgreSQL URL with password', re: /postgres(?:ql)?:\/\/[^\s:@'"]+:[^\s@'"]+@/ },
  { name: 'Resend API key',      re: /\bre_[A-Za-z0-9_]{16,}/ },
  { name: 'Stripe-style secret', re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { name: 'Pinecone API key',    re: /\bpcsk_[A-Za-z0-9_]{20,}/ },
  { name: 'AWS access key id',   re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token',        re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'Slack token',         re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  {
    name: 'JSON Web Token',
    // Three base64url segments. Anchored on the standard alg header so a
    // fingerprinted asset filename cannot look like one.
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(js|mjs|css|html|json|map|webmanifest)$/.test(name)) out.push(full);
  }
  return out;
}

/** Never print a secret. Enough to locate it, not enough to use it. */
const redact = (s) => `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;

const findings = [];
const files = walk(DIST);

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const rel = path.relative(process.cwd(), file);

  for (const name of SERVER_ONLY) {
    const value = process.env[name];
    /* Short values produce false positives against minified code; a real secret
       is never 12 characters. Placeholders from .env.example are skipped so a
       developer's template does not fail the scan. */
    if (!value || value.length < 12) continue;
    if (/^(changeme|placeholder|your-|example|test-|dummy)/i.test(value)) continue;
    if (text.includes(value)) {
      findings.push({ file: rel, kind: `value of ${name}`, detail: redact(value) });
    }
  }

  for (const { name, re } of SHAPES) {
    const m = text.match(re);
    if (m) findings.push({ file: rel, kind: name, detail: redact(m[0]) });
  }
}

console.log(`Scanned ${files.length} files in ${path.relative(process.cwd(), DIST) || DIST}`);
if (PUBLIC_BY_DESIGN.length) {
  console.log(`Public by design, not flagged: ${PUBLIC_BY_DESIGN.join(', ')}`);
}

if (findings.length === 0) {
  console.log('CLEAN — no secret-shaped material in the bundle.');
  process.exit(0);
}

console.error(`\nFOUND ${findings.length} problem(s):\n`);
for (const f of findings) {
  console.error(`  ${f.file}`);
  console.error(`    ${f.kind}: ${f.detail}\n`);
}
console.error('A value reaches the bundle when it is read through a VITE_-prefixed');
console.error('variable, or hardcoded. Vite inlines those at build time; there is no');
console.error('runtime boundary. Move it server-side and expose it through an API route.');
process.exit(1);
