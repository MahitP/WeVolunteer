import { describe, it, expect, vi } from 'vitest';
import { acquireModel, cachedBytes } from './modelCache.js';
import { IntegrityError } from '../integrity.js';
import { AIAbortError } from './types.js';
import { modelForTier, modelUrl } from '../models.js';

/**
 * The repair that makes the Advanced model startable.
 *
 * ── The failure, restated ──
 *
 * The Advanced model is 986 MB against the Balanced model's 491, and every
 * other thing about them is identical — same registry shape, same URL builder,
 * same download, same load call, both above the digest threshold. So the only
 * way one can fail while the other works is a failure whose likelihood scales
 * with size, and the one that does is an interrupted download.
 *
 * An interrupted download leaves a short file, and the application could not
 * get past it: the length check compared `model.bytes` against the length the
 * SERVER declared (`Model.size`, the sum of `metadata.originalSize`), which is
 * right whether the file is whole or half written, and wllama's `refresh()`
 * returns early whenever a file with that key already exists, so re-downloading
 * re-downloaded nothing. Every retry hit the same bytes for ever.
 *
 * These tests are written against a fake ModelManager with exactly wllama's
 * shape, because the real one downloads several hundred megabytes and the whole
 * point of the runtime interface is that the suite never does that. Every
 * behaviour asserted below is one this module is responsible for.
 */

const ADVANCED = modelForTier('advanced');
const BALANCED = modelForTier('balanced');

/**
 * A stand-in for `ModelManager` with the fields this module touches.
 *
 * `files[].size` is what is on disk; `size` is the sum of the declared sizes,
 * exactly as wllama computes it. Keeping both, and keeping them able to
 * disagree, is the whole reason this fake exists rather than a bare object.
 */
function fakeManager({ model, storedBytes, repairedBytes = null }) {
  let onDisk = storedBytes;
  const state = { downloads: 0, deletes: 0 };

  const entryFor = () => {
    if (onDisk == null) return { url: modelUrl(model), size: 0, files: [], remove: vi.fn() };
    return {
      url: modelUrl(model),
      /* Always the declared size — this is the number that used to be checked
         and that is never wrong, whatever the file on disk looks like. */
      size: model.bytes,
      files: [{ name: 'f1', size: onDisk, metadata: { originalSize: model.bytes } }],
      remove: vi.fn(async () => { onDisk = null; state.deletes += 1; }),
    };
  };

  return {
    state,
    cacheManager: {
      delete: vi.fn(async () => { onDisk = null; state.deletes += 1; }),
    },
    getModelOrDownload: vi.fn(async () => {
      if (onDisk == null) {
        state.downloads += 1;
        onDisk = repairedBytes == null ? model.bytes : repairedBytes;
      }
      return entryFor();
    }),
  };
}

describe('cachedBytes', () => {
  it('adds up the files on disk, not the sizes the server declared', () => {
    const entry = {
      size: 986048768,
      files: [{ size: 12 }, { size: 30 }],
    };
    expect(cachedBytes(entry)).toBe(42);
  });

  it('reports -1 for an entry with no files, which is how eviction shows up', () => {
    expect(cachedBytes({ size: 986048768, files: [] })).toBe(-1);
    expect(cachedBytes(null)).toBe(-1);
  });
});

describe('a model that is already cached and complete', () => {
  it('is returned without touching the network', async () => {
    const mm = fakeManager({ model: ADVANCED, storedBytes: ADVANCED.bytes });
    const entry = await acquireModel(mm, ADVANCED);

    expect(cachedBytes(entry)).toBe(ADVANCED.bytes);
    expect(mm.state.downloads).toBe(0);
    expect(mm.state.deletes).toBe(0);
  });
});

describe('a cache entry left short by an interrupted download', () => {
  /**
   * The assertion that would have caught the reported fault. The entry's
   * declared size is correct — that is what made the old check useless — and
   * the file is half there.
   */
  it('is not accepted merely because the server declared the right length', async () => {
    const mm = fakeManager({
      model: ADVANCED,
      storedBytes: Math.floor(ADVANCED.bytes / 2),
      repairedBytes: Math.floor(ADVANCED.bytes / 2),
    });

    await expect(acquireModel(mm, ADVANCED)).rejects.toThrow(IntegrityError);
  });

  /**
   * Deleted before the retry, because wllama's own download returns early when
   * a file with that key exists. Without the delete the second attempt reads
   * the same short file and the model is stuck for ever.
   */
  it('is thrown away and fetched again, which is what gets past the early return', async () => {
    const mm = fakeManager({ model: ADVANCED, storedBytes: 1024 });

    const entry = await acquireModel(mm, ADVANCED);

    expect(mm.state.deletes).toBe(1);
    expect(mm.state.downloads).toBe(1);
    expect(cachedBytes(entry)).toBe(ADVANCED.bytes);
  });

  it('gives up after one fresh download rather than looping on the connection', async () => {
    const mm = fakeManager({
      model: ADVANCED,
      storedBytes: 1024,
      repairedBytes: 2048,
    });

    await expect(acquireModel(mm, ADVANCED)).rejects.toThrow(IntegrityError);
    expect(mm.state.downloads).toBe(1);
  });
});

describe('a model evicted from the cache', () => {
  it('is downloaded again', async () => {
    const mm = fakeManager({ model: BALANCED, storedBytes: null });
    const entry = await acquireModel(mm, BALANCED);

    expect(mm.state.downloads).toBe(1);
    expect(cachedBytes(entry)).toBe(BALANCED.bytes);
  });
});

describe('cancellation', () => {
  it('is refused before anything is fetched', async () => {
    const mm = fakeManager({ model: ADVANCED, storedBytes: ADVANCED.bytes });
    const controller = new AbortController();
    controller.abort();

    await expect(acquireModel(mm, ADVANCED, { signal: controller.signal }))
      .rejects.toBeInstanceOf(AIAbortError);
    expect(mm.getModelOrDownload).not.toHaveBeenCalled();
  });

  /**
   * A reader who pressed Cancel must not have their cache deleted and the
   * download restarted on their behalf — that is the opposite of what they
   * asked for, and on the Advanced model it is nearly a gigabyte of it.
   */
  it('does not treat a cancelled download as a corrupt cache entry', async () => {
    const mm = fakeManager({ model: ADVANCED, storedBytes: null });
    mm.getModelOrDownload.mockRejectedValueOnce(new AIAbortError());

    await expect(acquireModel(mm, ADVANCED)).rejects.toBeInstanceOf(AIAbortError);
    expect(mm.state.deletes).toBe(0);
  });
});

describe('the progress callback', () => {
  it('is handed to the download so a caller can report it', async () => {
    const mm = fakeManager({ model: BALANCED, storedBytes: null });
    const onProgress = vi.fn();

    await acquireModel(mm, BALANCED, { onProgress });

    expect(mm.getModelOrDownload).toHaveBeenCalledWith(
      { url: modelUrl(BALANCED) },
      expect.objectContaining({ progressCallback: onProgress }),
    );
  });
});

describe('both offered models take this path', () => {
  /**
   * Neither model is digest-verified — 491 MB and 986 MB are both above
   * `SHA256_MAX_BYTES` — so for both of them the length check IS the integrity
   * check, and it has to be reading the file.
   */
  it('length-checks the Balanced model against its bytes on disk too', async () => {
    const mm = fakeManager({
      model: BALANCED,
      storedBytes: BALANCED.bytes - 1,
      repairedBytes: BALANCED.bytes - 1,
    });

    await expect(acquireModel(mm, BALANCED)).rejects.toThrow(IntegrityError);
  });
});
