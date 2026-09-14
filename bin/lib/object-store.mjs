/**
 * The off-site copy's storage client: Backblaze B2 through its S3-compatible API.
 *
 * ── Why hand-rolled rather than @aws-sdk/client-s3 ──
 *
 * The SDK is ~20 MB across dozens of transitive packages, and this uses five of
 * its operations. On a host whose job is to run one Node process, every
 * dependency is also a supply-chain surface. AWS Signature Version 4 is a
 * documented algorithm, Node 24 supplies HMAC-SHA256 and `fetch`, and a client
 * short enough to read in one sitting is the property that matters for code that
 * holds a credential. Nothing is installed.
 *
 * ── Why B2, and what that changes from the R2 client this replaced ──
 *
 * Cloudflare R2 has no spending cap; only notifications (docs/operations/
 * offsite-backups.md, "Billing"). B2 was chosen instead. Two B2 facts shape this
 * file, both from Backblaze's S3-compatible API documentation:
 *
 *   - The SigV4 credential scope must name the bucket's REGION — the
 *     `us-west-004` in `s3.us-west-004.backblazeb2.com`. R2 accepts `auto`; B2
 *     does not. The previous client hardcoded `auto`, so it could never have
 *     authenticated to B2. The region is now derived from the endpoint and
 *     checked against an explicit B2_REGION when both are given.
 *   - B2 rejects `x-amz-checksum-sha256` ("Unsupported header"). Integrity is
 *     carried instead by the two mechanisms S3 servers verify on receipt —
 *     `x-amz-content-sha256`, which is part of the signature, and `Content-MD5` —
 *     plus the SHA-256 written into object metadata and re-checked on download.
 *
 * ── What it deliberately does not do ──
 *
 * No multipart upload: a single PUT allows 5 GB, the production archive is
 * ~200 KB, and the backup refuses anything over its size cap long before 5 GB.
 * No delete: the backup writer's key has no `deleteFiles`, and expiry belongs to
 * the bucket's lifecycle rule (see the runbook). No presigned URLs: nothing
 * outside this host and the operator's own recovery machine reads the bucket.
 */
import { createHash, createHmac } from 'node:crypto';

export const DEFAULT_PREFIX = 'wevolunteer/postgres';

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');
const hmac = (key, str) => createHmac('sha256', key).update(str, 'utf8').digest();

/** RFC 3986 encoding, which SigV4 requires and `encodeURIComponent` does not fully do. */
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * An error from the store, carrying only what is safe to log.
 *
 * Never the request, never a header, never a credential: the message is built
 * from the HTTP status, the provider's error code, and a truncated provider
 * message, all of which describe the refusal and none of which identify the key.
 */
export class ObjectStoreError extends Error {
  constructor(message, { status = null, code = null, retryable = false, cap = false } = {}) {
    super(message);
    this.name = 'ObjectStoreError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    /** A spending cap was hit, as opposed to a credential or permission refusal. */
    this.cap = cap;
  }
}

/* ── Configuration ──────────────────────────────────────────────────────── */

const REQUIRED = ['B2_S3_ENDPOINT', 'B2_BUCKET', 'B2_KEY_ID', 'B2_APPLICATION_KEY'];

/**
 * Build the client configuration from the environment, or explain what is wrong.
 *
 * Returns null when NOTHING is configured: a development machine, the test suite,
 * or a host whose owner has not set B2 up yet. The backup still runs locally and
 * says loudly that no off-site copy exists.
 *
 * Throws on a PARTIAL or inconsistent configuration, because that is a mistake
 * rather than a choice — and silently skipping the upload is how an operator comes
 * to believe off-site copies exist that do not. The messages name variables, never
 * their values.
 */
export function b2ConfigFromEnv(env = process.env) {
  const present = REQUIRED.filter((k) => env[k]);
  if (present.length === 0) return null;
  if (present.length !== REQUIRED.length) {
    const missing = REQUIRED.filter((k) => !env[k]);
    throw new Error(
      `Off-site backup is partially configured: missing ${missing.join(', ')}.\n`
      + '  Set all four, or none. A half-configured destination silently skips the\n'
      + '  off-site copy, which is how backups come to exist only on the host they\n'
      + '  are meant to protect against losing.'
    );
  }

  let endpoint;
  try {
    endpoint = new URL(env.B2_S3_ENDPOINT.includes('://') ? env.B2_S3_ENDPOINT : `https://${env.B2_S3_ENDPOINT}`);
  } catch {
    throw new Error('B2_S3_ENDPOINT is not a valid URL (expected e.g. https://s3.us-west-004.backblazeb2.com).');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !loopback) {
    throw new Error('B2_S3_ENDPOINT must be https. A plaintext endpoint would send the signed request, and the archive, in clear.');
  }
  if (endpoint.pathname !== '/' || endpoint.search) {
    throw new Error('B2_S3_ENDPOINT must be the bare endpoint with no path, e.g. https://s3.us-west-004.backblazeb2.com');
  }

  const derived = endpoint.hostname.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/)?.[1] ?? null;
  const explicit = (env.B2_REGION || '').trim() || null;
  if (derived && explicit && derived !== explicit) {
    throw new Error(
      `B2_REGION (${explicit}) does not match the region in B2_S3_ENDPOINT (${derived}).\n`
      + '  B2 validates the region inside the request signature, so every request would\n'
      + '  be refused. Remove B2_REGION (it is derived from the endpoint) or correct it.'
    );
  }
  const region = explicit || derived;
  if (!region) {
    throw new Error('B2_REGION is required when B2_S3_ENDPOINT is not an s3.<region>.backblazeb2.com host.');
  }

  const bucket = env.B2_BUCKET.trim();
  if (!/^[a-z0-9][a-z0-9-]{4,61}[a-z0-9]$/i.test(bucket)) {
    throw new Error('B2_BUCKET is not a valid bucket name (6–63 letters, digits and hyphens).');
  }

  const prefix = (env.B2_PREFIX || DEFAULT_PREFIX).trim().replace(/^\/+|\/+$/g, '');
  if (!prefix || prefix.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new Error('B2_PREFIX must be a relative path such as wevolunteer/postgres.');
  }

  return {
    endpoint,
    region,
    bucket,
    prefix,
    accessKeyId: env.B2_KEY_ID.trim(),
    secretAccessKey: env.B2_APPLICATION_KEY.trim(),
  };
}

/* ── Signing ────────────────────────────────────────────────────────────── */

/** SigV4 signing key: date -> region -> service -> "aws4_request". */
export function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

/**
 * Sign one request. Pure, so the tests can pin it; `now` is injectable.
 *
 * Every header that is sent is signed, including `content-md5` and each
 * `x-amz-meta-*`, so a proxy or a bug cannot alter metadata in flight without the
 * provider refusing the request.
 */
export function signRequest({ config, method, path, query = {}, headers = {}, payloadHash, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = config.endpoint.host;

  const all = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(String(query[k]))}`).join('&');

  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(Buffer.from(canonicalRequest, 'utf8'))].join('\n');
  const signature = createHmac('sha256', signingKey(config.secretAccessKey, dateStamp, config.region, 's3'))
    .update(stringToSign, 'utf8').digest('hex');

  return {
    headers: {
      ...headers,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalQuery,
  };
}

/* ── Transport ──────────────────────────────────────────────────────────── */

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set(['RequestTimeout', 'SlowDown', 'ServiceUnavailable', 'InternalError']);

/**
 * The refusals that mean "you have hit your own spending cap", not "your key is wrong".
 *
 * B2's caps are enforced rather than advisory — that is the property it was chosen
 * for over R2 — and a breached cap comes back as HTTP 403, the same status as a bad
 * credential. Left undistinguished, the nightly run would report "access denied" and
 * an operator would spend the morning re-issuing a key that was never the problem.
 * Caps reset at midnight US/Pacific, so these are never retried: nothing this run can
 * do will change the answer.
 */
const CAP_CODES = new Set(['storage_cap_exceeded', 'download_cap_exceeded', 'transaction_cap_exceeded']);
const capAdvice = (code) => `${code} — this is a Backblaze spending cap, not a credential problem. `
  + 'Caps reset at midnight US/Pacific; raise it on the Caps & Alerts page if the usage is expected.';

const xmlField = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]) : null;
};
const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Path-style URL path for a key: `/<bucket>/<key>`, each segment encoded once. */
export function objectPath(config, key = '') {
  return key ? `/${config.bucket}/${key.split('/').map(rfc3986).join('/')}` : `/${config.bucket}`;
}

/**
 * One signed request, with a timeout. Returns `{ status, headers, body }`.
 *
 * Non-2xx responses (other than 404 on a HEAD, which callers ask for) are thrown
 * as ObjectStoreError with `retryable` set from the status and provider code.
 */
export async function storeRequest({
  config, method, key = '', query = {}, headers = {}, body, timeoutMs = 60_000, fetchImpl = fetch, now,
}) {
  const payload = body ?? Buffer.alloc(0);
  const payloadHash = sha256Hex(payload);
  const path = objectPath(config, key);
  const signed = signRequest({ config, method, path, query, headers, payloadHash, now });
  const url = `${config.endpoint.protocol}//${config.endpoint.host}${path}${signed.canonicalQuery ? `?${signed.canonicalQuery}` : ''}`;

  // Built outside the try below, and rounded: AbortSignal.timeout throws a
  // RangeError on a fractional delay, and a size-scaled timeout is fractional for
  // almost every real archive. Inside the try, that programming error was reported
  // as a network failure and retried four times — every upload failed, looking
  // like an outage. Found by the integration tests, not by reading.
  const signal = AbortSignal.timeout(Math.ceil(timeoutMs));

  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: signed.headers,
      body: method === 'PUT' ? payload : undefined,
      redirect: 'error',
      signal,
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    // fetch reports every transport failure (DNS, refused, reset, TLS) as a
    // TypeError. Anything else is a defect here, and retrying it only delays the
    // report.
    if (!timedOut && !(err instanceof TypeError)) throw err;
    const reason = timedOut ? `timed out after ${Math.ceil(timeoutMs)} ms` : (err?.cause?.code || 'network error');
    throw new ObjectStoreError(`${method} failed before a response: ${reason}`, { retryable: true, code: 'NetworkError' });
  }

  const buf = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (res.ok) return { status: res.status, headers: res.headers, body: buf };
  if (method === 'HEAD' && res.status === 404) return { status: 404, headers: res.headers, body: buf };

  const text = buf.toString('utf8');
  const code = xmlField(text, 'Code');
  const message = (xmlField(text, 'Message') || '').slice(0, 200);
  if (CAP_CODES.has(code)) {
    throw new ObjectStoreError(`${method} refused: ${capAdvice(code)}`, { status: res.status, code, retryable: false, cap: true });
  }
  throw new ObjectStoreError(
    `${method} refused: HTTP ${res.status}${code ? ` ${code}` : ''}${message ? ` — ${message}` : ''}`,
    { status: res.status, code, retryable: RETRYABLE_STATUS.has(res.status) || RETRYABLE_CODES.has(code) },
  );
}

/**
 * Bounded retry with exponential backoff and full jitter.
 *
 * Four attempts by default, waits capped at 20 s — at most about half a minute of
 * waiting per operation, so an outage makes one nightly run fail and report rather
 * than hammer the provider or run into the next night's backup. Only failures that
 * can succeed on retry are retried: an authentication or permission refusal is
 * returned at once, because repeating it changes nothing and delays the alert.
 */
export async function withRetry(fn, {
  attempts = 4, baseMs = 1000, maxMs = 20_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random, onRetry = () => {},
} = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (!err?.retryable || i === attempts) break;
      const wait = Math.floor(random() * Math.min(maxMs, baseMs * 2 ** (i - 1)));
      onRetry({ attempt: i, waitMs: wait, error: err });
      await sleep(wait);
    }
  }
  throw lastErr;
}

/* ── Operations ─────────────────────────────────────────────────────────── */

/**
 * PUT one object with an integrity check the provider enforces on receipt.
 *
 * `metadata` becomes `x-amz-meta-*`. Kept short on purpose: B2 limits the file
 * name and all file information together to 2,048 bytes on an Object Lock bucket.
 */
export async function putObject({ config, key, body, contentType = 'application/octet-stream', metadata = {}, ...opts }) {
  const headers = {
    'Content-Type': contentType,
    'Content-MD5': createHash('md5').update(body).digest('base64'),
  };
  for (const [k, v] of Object.entries(metadata)) headers[`x-amz-meta-${k.toLowerCase()}`] = String(v);
  const res = await storeRequest({ config, method: 'PUT', key, headers, body, ...opts });
  return { key, bytes: body.length, etag: res.headers.get('etag'), versionId: res.headers.get('x-amz-version-id') };
}

/** HEAD one object: null when absent, otherwise what the provider says it holds. */
export async function headObject({ config, key, ...opts }) {
  const res = await storeRequest({ config, method: 'HEAD', key, ...opts });
  if (res.status === 404) return null;
  const metadata = {};
  for (const [k, v] of res.headers.entries()) {
    if (k.startsWith('x-amz-meta-')) metadata[k.slice('x-amz-meta-'.length)] = v;
  }
  return {
    size: Number(res.headers.get('content-length')),
    etag: res.headers.get('etag'),
    versionId: res.headers.get('x-amz-version-id'),
    lastModified: res.headers.get('last-modified'),
    lockMode: res.headers.get('x-amz-object-lock-mode'),
    lockRetainUntil: res.headers.get('x-amz-object-lock-retain-until-date'),
    metadata,
  };
}

/** GET one object's bytes. */
export async function getObject({ config, key, ...opts }) {
  const res = await storeRequest({ config, method: 'GET', key, ...opts });
  return res.body;
}

/**
 * Every version and delete marker under a prefix, following pagination.
 *
 * Versions, not just current objects: an object the lifecycle rule has hidden
 * still occupies storage and still holds a copy of the data, and a listing of
 * current objects would report it as gone. The retention audit must see what is
 * actually retained.
 */
export async function listObjectVersions({ config, prefix, maxPages = 50, ...opts }) {
  const out = [];
  let keyMarker = null;
  let versionMarker = null;
  for (let page = 0; page < maxPages; page++) {
    const query = { versions: '', prefix, 'max-keys': '1000' };
    if (keyMarker) query['key-marker'] = keyMarker;
    if (versionMarker) query['version-id-marker'] = versionMarker;
    const res = await storeRequest({ config, method: 'GET', query, ...opts });
    const xml = res.body.toString('utf8');
    for (const [, tag, inner] of xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
      out.push({
        key: xmlField(inner, 'Key'),
        versionId: xmlField(inner, 'VersionId'),
        isLatest: xmlField(inner, 'IsLatest') === 'true',
        lastModified: xmlField(inner, 'LastModified'),
        size: tag === 'Version' ? Number(xmlField(inner, 'Size') || 0) : 0,
        deleteMarker: tag === 'DeleteMarker',
      });
    }
    if (xmlField(xml, 'IsTruncated') !== 'true') return out;
    keyMarker = xmlField(xml, 'NextKeyMarker');
    versionMarker = xmlField(xml, 'NextVersionIdMarker');
    if (!keyMarker) return out;
  }
  throw new ObjectStoreError(`listing ${prefix} exceeded ${maxPages} pages — refusing to continue`, { code: 'TooManyPages' });
}

/**
 * The object key for an archive, from its UTC creation stamp.
 *
 * `<prefix>/daily/YYYY/MM/DD/<file>`. The date path comes from the stamp inside
 * the file name, never from this host's clock or timezone, so a key is a pure
 * function of the archive and a retried upload targets the same key. Names carry
 * a timestamp and nothing about any person.
 */
export function archiveKey(prefix, fileName) {
  const m = fileName.match(/^wevolunteer-(\d{4})(\d{2})(\d{2})T\d{6}Z\.(dump\.enc|manifest\.json)$/);
  // A calendar check, in UTC: 2027-02-29 matches the pattern and is not a day.
  const day = m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (!m || day.getUTCFullYear() !== Number(m[1]) || day.getUTCMonth() !== Number(m[2]) - 1 || day.getUTCDate() !== Number(m[3])) {
    throw new Error(`not a WeVolunteer backup file name: ${fileName}`);
  }
  return `${prefix}/daily/${m[1]}/${m[2]}/${m[3]}/${fileName}`;
}
