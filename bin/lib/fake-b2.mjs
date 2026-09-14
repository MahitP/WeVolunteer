/**
 * A local stand-in for Backblaze B2's S3-compatible API — for tests only.
 *
 * ── What it is for, and what it cannot prove ──
 *
 * It lets the off-site backup be exercised end to end without an account or a
 * credential, and — the reason it is more than a recorder — it REFUSES requests
 * the way B2 documents refusing them, so a client bug fails here rather than in
 * production:
 *
 *   - SigV4 is recomputed from the received request with the known secret. A
 *     wrong secret, a wrong region in the credential scope, an unsigned header or
 *     a tampered query string is refused with SignatureDoesNotMatch.
 *   - `x-amz-content-sha256` must equal the body's SHA-256, and `Content-MD5` its
 *     MD5 — the integrity checks the real client relies on.
 *   - `x-amz-checksum-*` is refused, as B2 refuses it.
 *   - Every operation requires the B2 capability Backblaze's documentation maps it
 *     to (PutObject → writeFiles, HeadObject/GetObject → readFiles, listing →
 *     listFiles, DeleteObject → deleteFiles), so least-privilege claims are tested
 *     rather than asserted.
 *   - Versions are kept; PUT to an existing key adds a version; a default Object
 *     Lock retention blocks deleting a version before it expires.
 *
 * What it cannot prove is that Backblaze behaves identically. Only the live check
 * in docs/operations/offsite-backups.md settles that, and reports must say which
 * of the two was run.
 */
import { createServer } from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s, 'utf8').digest();
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function startFakeB2({
  accessKeyId = 'fake-key-id',
  secretAccessKey = 'fake-application-key-0123456789',
  region = 'us-west-004',
  bucket = 'wev-backups-test',
  capabilities = ['listBuckets', 'writeFiles', 'readFiles', 'listFiles', 'readFileRetentions'],
  lockDays = 28,
  lockMode = 'GOVERNANCE',
  pageSize = 1000,
} = {}) {
  const state = {
    objects: new Map(),          // key -> [version, ...] oldest first
    requests: [],                // { method, path, query, status }
    faults: [],                  // queue of { match(req) , action }
    capabilities: new Set(capabilities),
    lockDays,
    lockMode,
    clock: () => new Date(),
  };

  const send = (res, status, body = '', headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/xml', ...headers });
    res.end(body);
  };
  const error = (res, status, code, message = code) =>
    send(res, status, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`);

  function verifySignature(req, url, body) {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/);
    if (!m) return ['AccessDenied', 'missing or malformed Authorization'];
    const [, keyId, date, scopeRegion, signedHeaders, signature] = m;
    if (keyId !== accessKeyId) return ['InvalidAccessKeyId', 'The key is not valid'];
    if (scopeRegion !== region) return ['SignatureDoesNotMatch', `region in credential scope is ${scopeRegion}, expected ${region}`];
    const amzDate = req.headers['x-amz-date'] || '';
    const when = Date.parse(amzDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
    if (!Number.isFinite(when) || Math.abs(state.clock().getTime() - when) > 15 * 60_000) {
      return ['RequestTimeTooSkewed', 'request time too skewed'];
    }
    const names = signedHeaders.split(';');
    for (const required of ['host', 'x-amz-date', 'x-amz-content-sha256']) {
      if (!names.includes(required)) return ['SignatureDoesNotMatch', `${required} not signed`];
    }
    for (const h of Object.keys(req.headers)) {
      if ((h.startsWith('x-amz-') || h === 'content-md5') && !names.includes(h)) {
        return ['SignatureDoesNotMatch', `${h} sent but not signed`];
      }
    }
    const canonicalHeaders = names.map((n) => `${n}:${String(req.headers[n] ?? '').trim()}\n`).join('');
    const params = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const canonicalQuery = params.map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join('&');
    const payloadHash = req.headers['x-amz-content-sha256'];
    const canonicalRequest = [req.method, url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, `${date}/${scopeRegion}/s3/aws4_request`, sha256Hex(Buffer.from(canonicalRequest))].join('\n');
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), scopeRegion), 's3'), 'aws4_request');
    const expected = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    if (expected !== signature) return ['SignatureDoesNotMatch', 'signature does not match'];
    if (payloadHash !== sha256Hex(body)) return ['XAmzContentSHA256Mismatch', 'payload hash mismatch'];
    return null;
  }

  const latest = (key) => {
    const versions = state.objects.get(key) || [];
    const top = versions[versions.length - 1];
    return top && !top.deleteMarker ? top : null;
  };
  const need = (res, cap) => {
    if (state.capabilities.has(cap)) return true;
    error(res, 403, 'AccessDenied', `application key lacks ${cap}`);
    return false;
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://fake');
      const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers };
      state.requests.push(record);

      const faultIndex = state.faults.findIndex((f) => !f.match || f.match(record));
      if (faultIndex !== -1) {
        const fault = state.faults[faultIndex];
        if (!fault.persistent) state.faults.splice(faultIndex, 1);
        if (fault.hangMs) { await new Promise((r) => setTimeout(r, fault.hangMs)); }
        if (fault.destroy) { req.socket.destroy(); return; }
        if (fault.status) return error(res, fault.status, fault.code || 'ServiceUnavailable');
      }

      const authError = verifySignature(req, url, body);
      if (authError) return error(res, 403, authError[0], authError[1]);

      const [, bucketName, ...keyParts] = url.pathname.split('/');
      if (bucketName !== bucket) return error(res, 404, 'NoSuchBucket', 'The specified bucket does not exist');
      const key = keyParts.map(decodeURIComponent).join('/');

      if (Object.keys(req.headers).some((h) => h.startsWith('x-amz-checksum-'))) {
        return error(res, 400, 'InvalidArgument', 'Unsupported header x-amz-checksum received for this API call');
      }

      if (req.method === 'PUT' && key) {
        if (!need(res, 'writeFiles')) return;
        const md5 = req.headers['content-md5'];
        if (md5 && md5 !== createHash('md5').update(body).digest('base64')) {
          return error(res, 400, 'BadDigest', 'The Content-MD5 you specified did not match what was received');
        }
        const meta = Object.fromEntries(Object.entries(req.headers).filter(([h]) => h.startsWith('x-amz-meta-')));
        const now = state.clock();
        const version = {
          versionId: randomUUID(),
          body,
          meta,
          etag: `"${createHash('md5').update(body).digest('hex')}"`,
          lastModified: now,
          lockUntil: state.lockDays ? new Date(now.getTime() + state.lockDays * 86_400_000) : null,
        };
        if (!state.objects.has(key)) state.objects.set(key, []);
        state.objects.get(key).push(version);
        return send(res, 200, '', { ETag: version.etag, 'x-amz-version-id': version.versionId });
      }

      if ((req.method === 'HEAD' || req.method === 'GET') && key) {
        if (!need(res, 'readFiles')) return;
        const v = latest(key);
        if (!v) return req.method === 'HEAD' ? send(res, 404) : error(res, 404, 'NoSuchKey', 'The specified key does not exist.');
        const headers = {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(v.body.length),
          ETag: v.etag,
          'Last-Modified': v.lastModified.toUTCString(),
          'x-amz-version-id': v.versionId,
          ...v.meta,
        };
        if (v.lockUntil && state.capabilities.has('readFileRetentions')) {
          headers['x-amz-object-lock-mode'] = state.lockMode;
          headers['x-amz-object-lock-retain-until-date'] = v.lockUntil.toISOString();
        }
        if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
        let out = v.body;
        if (state.corruptNextGet) { state.corruptNextGet = false; out = Buffer.from(out); out[out.length >> 1] ^= 0xff; }
        res.writeHead(200, headers);
        return res.end(out);
      }

      if (req.method === 'GET' && !key && url.searchParams.has('versions')) {
        if (!need(res, 'listFiles')) return;
        const prefix = url.searchParams.get('prefix') || '';
        const all = [];
        for (const k of [...state.objects.keys()].sort()) {
          if (!k.startsWith(prefix)) continue;
          const versions = state.objects.get(k);
          versions.forEach((v, i) => all.push({ key: k, v, isLatest: i === versions.length - 1 }));
        }
        const startKey = url.searchParams.get('key-marker');
        const startVersion = url.searchParams.get('version-id-marker');
        let from = 0;
        if (startKey) {
          const idx = all.findIndex((e) => e.key === startKey && e.v.versionId === startVersion);
          from = idx === -1 ? 0 : idx + 1;
        }
        const page = all.slice(from, from + pageSize);
        const truncated = from + pageSize < all.length;
        const last = page[page.length - 1];
        const items = page.map(({ key: k, v, isLatest }) => (v.deleteMarker
          ? `<DeleteMarker><Key>${xmlEscape(k)}</Key><VersionId>${v.versionId}</VersionId><IsLatest>${isLatest}</IsLatest><LastModified>${v.lastModified.toISOString()}</LastModified></DeleteMarker>`
          : `<Version><Key>${xmlEscape(k)}</Key><VersionId>${v.versionId}</VersionId><IsLatest>${isLatest}</IsLatest><LastModified>${v.lastModified.toISOString()}</LastModified><Size>${v.body.length}</Size></Version>`)).join('');
        return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult><Name>${bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextKeyMarker>${xmlEscape(last.key)}</NextKeyMarker><NextVersionIdMarker>${last.v.versionId}</NextVersionIdMarker>` : ''}${items}</ListVersionsResult>`);
      }

      if (req.method === 'DELETE' && key) {
        if (!need(res, 'deleteFiles')) return;
        const versions = state.objects.get(key) || [];
        const versionId = url.searchParams.get('versionId');
        if (versionId) {
          const v = versions.find((x) => x.versionId === versionId);
          if (v?.lockUntil && v.lockUntil > state.clock()) return error(res, 403, 'AccessDenied', 'object is locked');
          state.objects.set(key, versions.filter((x) => x.versionId !== versionId));
        } else {
          versions.push({ versionId: randomUUID(), deleteMarker: true, lastModified: state.clock(), body: Buffer.alloc(0) });
        }
        return send(res, 204);
      }

      return error(res, 405, 'MethodNotAllowed');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  return {
    endpoint,
    state,
    env: {
      B2_S3_ENDPOINT: endpoint,
      B2_REGION: region,
      B2_BUCKET: bucket,
      B2_KEY_ID: accessKeyId,
      B2_APPLICATION_KEY: secretAccessKey,
    },
    /** Make an object look older than it is — for retention audits. */
    age(key, days) {
      for (const v of state.objects.get(key) || []) {
        v.lastModified = new Date(v.lastModified.getTime() - days * 86_400_000);
        if (v.lockUntil) v.lockUntil = new Date(v.lockUntil.getTime() - days * 86_400_000);
      }
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
