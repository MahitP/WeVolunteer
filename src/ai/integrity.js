/**
 * Checking that a downloaded model is the model we asked for.
 *
 * ── What wllama already does, and what it does not ──
 *
 * `ModelManager` owns the download and the cache, and its `Model.validate()`
 * compares the stored byte length against `metadata.originalSize` — which
 * catches the failure that actually happens most often, a download interrupted
 * by a closed tab leaving a truncated file behind.
 *
 * What it does not do is verify a digest. `CacheEntryMetadata.sha256` is
 * declared optional and is stored rather than enforced: it records what the
 * server said, not what the bytes hash to. Since the weights are fetched from a
 * third-party CDN, that gap is worth closing — the registry in `models.js`
 * carries a digest read from the Hugging Face metadata API, and this module is
 * what compares the file against it.
 *
 * ── Why verification is not unconditional ──
 *
 * `crypto.subtle.digest()` is one-shot: it needs its entire input resident as a
 * single buffer, and there is no incremental form (w3c/webcrypto#73, open since
 * 2016). Hashing the largest model would mean holding roughly a gigabyte in the
 * page purely to check it — on a weak device, an integrity check that causes the
 * out-of-memory crash it exists to protect against.
 *
 * So it is bounded by `SHA256_MAX_BYTES` and, within that bound, it runs when it
 * can tell you something new: the first time a file is used after being written,
 * and again after a load has failed. Re-hashing an already-verified file on
 * every launch would spend seconds of a student's time to re-confirm a fact that
 * has not changed.
 *
 * The honest summary, which the AI policy states in these terms: every model is
 * length-checked on every load, small models are additionally digest-verified,
 * and for large models the remaining assurance is TLS to an allowlisted host.
 */

import { isDigestVerified } from './models.js';

/** Raised when a file is present and readable but is not the file we expected. */
export class IntegrityError extends Error {
  constructor(message, { modelId, expected, actual } = {}) {
    super(message);
    this.name = 'IntegrityError';
    this.modelId = modelId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Where a successful verification is remembered. Cleared by "Clear AI data". */
const VERIFIED_KEY_PREFIX = 'wev-ai-verified:';

function verifiedKey(model) {
  return `${VERIFIED_KEY_PREFIX}${model.id}:${model.version}`;
}

/**
 * Storage access that cannot throw.
 *
 * Safari in private mode throws on `localStorage` access rather than returning
 * null, and the repository has been bitten by exactly this before — see the
 * wrapper around the error-scene selector. A verification *record* is an
 * optimisation; losing it costs one re-hash, so it must never be the reason a
 * model fails to load.
 */
function readVerified(model) {
  try {
    return window.localStorage.getItem(verifiedKey(model)) === model.sha256;
  } catch {
    return false;
  }
}

function writeVerified(model) {
  try {
    window.localStorage.setItem(verifiedKey(model), model.sha256);
  } catch {
    /* Ignore: re-verifying next launch is the correct degradation. */
  }
}

/** Forget every verification record. Used by "Clear AI data" in Settings. */
export function forgetVerifications() {
  try {
    const doomed = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(VERIFIED_KEY_PREFIX)) doomed.push(key);
    }
    doomed.forEach(k => window.localStorage.removeItem(k));
  } catch {
    /* Nothing to clean up if storage is unavailable. */
  }
}

/** Lower-case hex SHA-256 of a Blob. */
export async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Why a model was or was not digest-checked, in terms the UI can show without
 * restating the rules and drifting from them.
 *
 *   'verified'        hashed now, and it matched
 *   'already-checked' hashed on an earlier launch, record still good
 *   'too-large'       above the threshold; length-checked only
 *   'multi-shard'     the registry holds one digest and this model is split
 */
export function checkSize(model, totalBytes) {
  /**
   * The length check runs for every model, every time, and is the one that
   * catches a truncated cache entry. It is free, so there is no reason to
   * bound it the way the digest is bounded.
   *
   * Separated from `verifyModel` so the large-model path can use it: above
   * `SHA256_MAX_BYTES` the weights are streamed into the runtime from cache
   * rather than opened as Blobs, precisely so a gigabyte never has to sit in
   * the page. Asking for the blobs merely to measure them would undo that.
   */
  if (totalBytes !== model.bytes) {
    throw new IntegrityError(
      'The downloaded model is not the expected size. It may have been interrupted.',
      { modelId: model.id, expected: model.bytes, actual: totalBytes },
    );
  }
}

export async function verifyModel(model, blobs, { force = false } = {}) {
  checkSize(model, blobs.reduce((sum, b) => sum + b.size, 0));

  if (!isDigestVerified(model)) return { checked: false, status: 'too-large' };

  /* The registry records one digest per model, so a split model cannot be
     matched against it without per-shard digests. Say so rather than hashing
     the concatenation, which would compare unequal and read as corruption. */
  if (blobs.length !== 1) return { checked: false, status: 'multi-shard' };

  if (!force && readVerified(model)) return { checked: false, status: 'already-checked' };

  const actual = await sha256Hex(blobs[0]);
  if (actual !== model.sha256) {
    throw new IntegrityError(
      'The downloaded model does not match its published checksum.',
      { modelId: model.id, expected: model.sha256, actual },
    );
  }

  writeVerified(model);
  return { checked: true, status: 'verified' };
}
