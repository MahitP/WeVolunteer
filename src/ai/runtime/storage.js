/**
 * What the assistant is occupying on this device, and how to get it back.
 *
 * ── Why this is a separate module from the runtime ──
 *
 * Settings needs to answer "how much space is this using" and "remove it"
 * without loading a model. Putting these on `WllamaRuntime` would mean
 * constructing an inference engine — and on a phone, allocating for one — in
 * order to read a number and delete a file.
 *
 * It still imports wllama, so it lives under `runtime/` and is reached only
 * through the guarded dynamic import in `src/ai/index.js`. `bundleCost.test.js`
 * names both files; a third would have to be added there deliberately.
 *
 * ── Honesty about the number ──
 *
 * Two figures could be shown and they mean different things. `bytesUsed()` is
 * what WeVolunteer's models occupy — the one a student is deciding about.
 * `storageEstimate()` is the browser's view of the whole origin, which includes
 * everything else the application has cached and is not a number this feature
 * should claim as its own. They are returned separately rather than blended.
 */

import { MODELS, modelUrl, isDigestVerified } from '../models.js';
import { checkSize, verifyModel } from '../integrity.js';
import { createCacheManager } from './opfsBackend.js';

/**
 * A ModelManager, built fresh per call — it holds no state worth reusing.
 *
 * The specifier is written out in full rather than held in a constant. A
 * bundler can only rewrite a bare specifier in an `import()` it can read
 * statically; behind a variable the string reaches the browser untouched and
 * fails at runtime with "Failed to resolve module specifier". That failure
 * appears only when the model is actually fetched, so it survives every test
 * that does not download one.
 *
 * The deep path is required because the package's `main` field names a file
 * that is not in the tarball. There is no `exports` map, so this is a supported
 * path rather than a reach into internals.
 */
async function manager() {
  const { ModelManager } = await import('@wllama/wllama/esm/index.js');
  /* The cache manager is supplied explicitly. wllama's default writes to
     cross-origin storage, which this origin does not have, and the resulting
     failure is a download that succeeds and then cannot be found. See
     opfsBackend.js. */
  return new ModelManager({ allowOffline: true, cacheManager: await createCacheManager() });
}

/**
 * Which registry models are on this device, with their real occupied size.
 *
 * Reports `bytes` from the cache rather than from the registry, because those
 * two disagreeing is the interesting case: an interrupted download leaves a
 * short file, and a student looking at Settings should see that something is
 * wrong rather than the size it was supposed to be.
 */
export async function listCachedModels() {
  const mm = await manager();
  const cached = await mm.getModels({ includeInvalid: true });
  const byUrl = new Map(cached.map(m => [m.url, m]));

  return MODELS
    .map(model => {
      const entry = byUrl.get(modelUrl(model));
      if (!entry) return null;
      return {
        model,
        bytes: entry.size,
        /* `size === -1` is wllama's marker for an entry that is gone from the
           cache underneath us. Treated as not-present rather than as a
           negative size, which would make the total nonsense. */
        present: entry.size > 0,
        complete: entry.size === model.bytes,
      };
    })
    .filter(Boolean);
}

/**
 * Fetch a model's weights without starting an inference engine.
 *
 * Settings downloads; the assistant loads. Keeping them apart means turning the
 * feature on does not allocate for a model that is about to sit unused, which
 * on a phone is the difference between a download and a crash.
 *
 * Verification runs here rather than at load time because this is where a
 * student is watching and can act on the answer. A file that arrives wrong is
 * reported now, with the download still in mind, instead of at the moment they
 * first ask a question.
 */
export async function downloadModel(model, { onProgress, signal } = {}) {
  const mm = await manager();
  const entry = await mm.getModelOrDownload(
    { url: modelUrl(model) },
    { progressCallback: onProgress, signal },
  );

  if (isDigestVerified(model)) {
    const blobs = await entry.open();
    await verifyModel(model, blobs);
  } else {
    checkSize(model, entry.size);
  }

  return { bytes: entry.size };
}

/** Total bytes WeVolunteer's models occupy on this device. */
export async function bytesUsed() {
  const cached = await listCachedModels();
  return cached.reduce((sum, c) => sum + Math.max(0, c.bytes), 0);
}

/**
 * The browser's own view of this origin's storage, or null where unsupported.
 *
 * Separate from `bytesUsed` on purpose: `usage` covers everything the
 * application has cached, not only models, and presenting it as the
 * assistant's footprint would overstate it.
 */
export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

/** Remove one model's weights. Succeeds quietly if it was not there. */
export async function removeModel(model) {
  const mm = await manager();
  const cached = await mm.getModels({ includeInvalid: true });
  const entry = cached.find(m => m.url === modelUrl(model));
  if (entry) await entry.remove();
}

/**
 * Remove every model this application put on the device.
 *
 * Iterates the registry rather than calling `ModelManager.clear()`, which would
 * empty wllama's whole cache. Today those are the same set, but they are not
 * the same claim: "delete the models WeVolunteer downloaded" must not grow into
 * "delete anything on this origin that happens to use the same library".
 */
export async function removeAllModels() {
  for (const { model } of await listCachedModels()) {
    await removeModel(model);
  }
}
