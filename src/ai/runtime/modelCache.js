/**
 * Getting a model's weights out of the cache and being sure they are all there.
 *
 * ── The failure this exists for ──
 *
 * Reported: "the Advanced Model isnt starting up it says Model couldnt start
 * up", while Balanced kept working. Both models take an identical code path —
 * same registry shape, same URL builder, same download, same load call, both
 * above `SHA256_MAX_BYTES` so both length-checked rather than digest-verified —
 * so nothing about the Advanced entry can be wrong on its own. The difference
 * between them is 986 MB against 491 MB, and what that buys is twice the chance
 * of the download being interrupted.
 *
 * An interrupted download leaves a SHORT FILE in OPFS, and from there the
 * application could not recover, for two reasons that compound:
 *
 *  1. The length check was reading the wrong number. `checkSize(model,
 *     cached.size)` looks correct and is inert: wllama's `Model.size` is the
 *     sum of `metadata.originalSize`, which is the `content-length` the SERVER
 *     declared, not the bytes on disk. It equals `model.bytes` whether the file
 *     is complete or half written, so the one guard standing between a
 *     truncated cache entry and the inference engine always passed. The bytes
 *     then reached llama.cpp, which failed to parse them, and the error named a
 *     GGUF problem — pointing at the model rather than at the download.
 *
 *  2. Re-downloading did not re-download. `Model.refresh()` calls
 *     `CacheManager.download`, whose first act is to return early if a file
 *     with that key already exists:
 *
 *         if (hint && (await this.sb.getSize(fileKey, hint)) !== -1) { … return }
 *
 *     A short file exists. So refresh was a no-op, every retry hit the same
 *     bytes, and the only escape was Remove in Settings — which nothing told
 *     the reader to do. That is exactly the shape of "Advanced never starts,
 *     Balanced always does": not a bad model entry, a stuck one.
 *
 * ── What this module does ──
 *
 * It answers "is the file actually all here" from the file, and when the answer
 * is no it throws the cache entry away and fetches once more from the network —
 * which is the only thing that gets past wllama's early return. Both callers go
 * through it, so Settings' download and Welly's load cannot disagree about
 * whether a model is usable.
 */

import { checkSize } from '../integrity.js';
import { modelUrl } from '../models.js';
import { isAbort, throwIfAborted } from './types.js';

/**
 * How many bytes of this model are on the device, from the files themselves.
 *
 * `entry.size` is deliberately NOT used — see the header. `CacheEntry.size` is
 * what the storage backend measured; `CacheEntry.metadata.originalSize` is what
 * the server said, and `Model.size` sums the second.
 *
 * `-1` for an entry with no files, which is how wllama reports a model that has
 * been evicted from the cache underneath us. Distinct from `0` so it cannot be
 * mistaken for an empty file.
 */
export function cachedBytes(entry) {
  const files = entry?.files;
  if (!Array.isArray(files) || files.length === 0) return -1;
  return files.reduce((sum, file) => sum + (Number(file?.size) || 0), 0);
}

/**
 * Remove whatever is cached for this model, by whichever route works.
 *
 * `Model.remove()` is tried first because it knows about every shard. It can
 * throw on precisely the entries this module exists to clean up — its first act
 * is `getAllFiles`, which throws "Model file not found" when a partial write
 * left a file whose metadata never got written — so the cache manager's
 * key-based delete is the fallback, and that one only needs the URL.
 *
 * Never throws. A failure to delete surfaces as the retry finding the same bad
 * file and reporting it, which is a better failure than an exception thrown
 * while cleaning up after another one.
 */
async function discard(manager, model, entry) {
  if (entry) {
    try {
      await entry.remove();
      return;
    } catch {
      /* Fall through to the key-based delete below. */
    }
  }
  try {
    await manager.cacheManager.delete(modelUrl(model));
  } catch {
    /* Nothing cached, or storage is unavailable. Either way there is nothing
       further to do here. */
  }
}

/**
 * The model's cache entry, verified complete, downloading it if it is not.
 *
 * Returns wllama's `Model`, which both callers then use differently — Settings
 * reads its size, the runtime hands it to `loadModel`.
 *
 * Throws `IntegrityError` when the file is still the wrong length after a fresh
 * download, `AIAbortError`/`AbortError` when cancelled, and whatever the
 * download threw when the network is the problem.
 *
 * ── One retry, not a loop ──
 *
 * The second attempt starts from an empty cache, so it is a straight download.
 * If that also comes back short, the fault is not a stale cache entry and
 * trying a third time would spend another 986 MB of somebody's connection to
 * learn the same thing.
 */
export async function acquireModel(manager, model, { onProgress, signal } = {}) {
  throwIfAborted(signal);

  const fetchOnce = () => manager.getModelOrDownload(
    { url: modelUrl(model) },
    { progressCallback: onProgress, signal },
  );

  let entry = null;
  try {
    entry = await fetchOnce();
    checkSize(model, cachedBytes(entry));
    return entry;
  } catch (err) {
    /* Cancellation is the reader's decision, not a broken cache. Re-downloading
       what they just stopped would be the opposite of what they asked for. */
    if (isAbort(err) || signal?.aborted) throw err;
  }

  await discard(manager, model, entry);
  throwIfAborted(signal);

  const fresh = await fetchOnce();
  checkSize(model, cachedBytes(fresh));
  return fresh;
}
