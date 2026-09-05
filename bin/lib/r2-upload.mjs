/**
 * Upload a file to Cloudflare R2 (or any S3-compatible store) with no SDK.
 *
 * ── Why hand-rolled rather than @aws-sdk/client-s3 ──
 *
 * The SDK is ~20 MB across dozens of transitive packages, and this uses one of
 * its operations. On a host whose entire job is to run one Node process, every
 * dependency is also a supply-chain surface and something to keep patched. AWS
 * Signature V4 is a documented algorithm and the single-PUT case is short
 * enough to read in one sitting, which is the property that matters for code
 * that handles a credential.
 *
 * Node 24 supplies both halves already: `node:crypto` for HMAC-SHA256 and a
 * global `fetch`. Nothing is installed.
 *
 * ── Why R2 ──
 *
 * The backup must survive the loss of the production database, so it cannot
 * live in the same account as the database. R2's free tier is 10 GB-month of
 * storage with 1M Class A (writes) and 10M Class B (reads) operations, and —
 * unusually — no egress charge, which matters because a restore drill downloads
 * the whole archive. One upload per night is ~30 Class A operations a month
 * against an allowance of a million.
 *
 * ── What this deliberately does not do ──
 *
 * No multipart upload. A single PUT is limited to 5 GB, and a compressed
 * pg_dump of this database is orders of magnitude below that; multipart would
 * triple the size of this file to handle a case that would mean the free tier
 * was long gone anyway. If a dump ever approaches 5 GB, the right response is
 * to notice, not to stream harder.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');
const hmac = (key, str) => createHmac('sha256', key).update(str, 'utf8').digest();

/**
 * Derive the SigV4 signing key.
 *
 * The chain is date -> region -> service -> "aws4_request", each step keyed by
 * the previous result. Deriving per-request rather than caching keeps the
 * secret in memory for the shortest time and costs four HMACs.
 */
function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

/**
 * PUT one object.
 *
 * `config` carries accountId, accessKeyId, secretAccessKey and bucket. Every
 * one of those is a secret except the bucket, so nothing here is logged and the
 * thrown error deliberately carries only status and the provider's own message.
 */
export async function putObject({ config, key, body, contentType = 'application/octet-stream' }) {
  const { accountId, accessKeyId, secretAccessKey, bucket, endpoint } = config;

  /**
   * R2's S3 endpoint.
   *
   * The scheme is taken FROM the endpoint rather than hardcoded to https. Real
   * R2 is always https, so hardcoding it looks harmless — but it made the
   * signing path impossible to exercise against a local server, and code that
   * handles a credential and cannot be tested is the wrong trade. An endpoint
   * with no scheme, and the default when none is given, are https.
   *
   * `region` is literally "auto" for R2, and it must still appear in the
   * credential scope or the signature will not match.
   */
  const base = endpoint
    ? new URL(endpoint)
    : new URL(`https://${accountId}.r2.cloudflarestorage.com`);
  const host = base.host;
  const scheme = base.protocol;
  const region = 'auto';
  const service = 's3';

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20260905T110730Z
  const dateStamp = amzDate.slice(0, 8);                            // 20260905

  const payloadHash = sha256Hex(body);
  // Path-style: /<bucket>/<key>. Each segment is encoded separately so a key
  // containing "/" keeps its structure rather than becoming %2F.
  const canonicalUri = `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

  const canonicalHeaders =
    `content-type:${contentType}\n`
    + `host:${host}\n`
    + `x-amz-content-sha256:${payloadHash}\n`
    + `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest =
    `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign =
    `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(Buffer.from(canonicalRequest, 'utf8'))}`;

  const signature = createHmac('sha256', signingKey(secretAccessKey, dateStamp, region, service))
    .update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`${scheme}//${host}${canonicalUri}`, {
    method: 'PUT',
    headers: {
      'Authorization': authorization,
      'Content-Type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
    body,
  });

  if (!res.ok) {
    // The body is the provider's XML error. Truncated because it is going into
    // a log, and never accompanied by the request we signed.
    const detail = (await res.text().catch(() => '')).slice(0, 400);
    throw new Error(`R2 upload failed: HTTP ${res.status} ${detail}`);
  }

  return { key, bytes: body.length, etag: res.headers.get('etag') };
}

/** Read a local file and upload it under the same basename, optionally prefixed. */
export async function uploadFile({ config, filePath, prefix = '' }) {
  const body = await readFile(filePath);
  const key = `${prefix}${prefix && !prefix.endsWith('/') ? '/' : ''}${basename(filePath)}`;
  return putObject({ config, key, body });
}

/**
 * Build config from the environment, or explain precisely what is missing.
 *
 * Returns null rather than throwing when nothing is configured at all, so the
 * backup script can treat "no off-site copy configured" as a loud warning
 * rather than a failed backup — a local backup is worth more than no backup.
 * A PARTIAL configuration does throw, because that is a mistake rather than a
 * choice, and silently skipping the upload is how an operator comes to believe
 * they have off-site copies they do not have.
 */
export function r2ConfigFromEnv(env = process.env) {
  const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  const present = keys.filter(k => env[k]);
  if (present.length === 0) return null;
  if (present.length !== keys.length) {
    const missing = keys.filter(k => !env[k]);
    throw new Error(
      `R2 is partially configured: missing ${missing.join(', ')}.\n`
      + '  Set all four, or none. A half-configured destination silently skips the\n'
      + '  off-site copy, which is how backups come to exist only on the host they\n'
      + '  are meant to protect against losing.'
    );
  }
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    endpoint: env.R2_ENDPOINT,
  };
}
