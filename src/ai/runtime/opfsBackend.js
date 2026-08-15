/**
 * Where downloaded model weights actually live.
 *
 * ── Why this exists rather than using the library's own ──
 *
 * wllama 3.5.1 defaults every cache to cross-origin storage:
 * `CacheManager`'s constructor is `(backends = [new COSBackend()])`, and both
 * `ModelManager` and `Wllama` fall back to `new CacheManager()`. Cross-origin
 * storage needs a co-operating second origin that WeVolunteer does not have, so
 * on an ordinary origin nothing is ever written.
 *
 * The failure is quiet and misleading. The download runs to completion, the
 * bytes are discarded, and the error surfaces afterwards from a different part
 * of the library — `Model.getAllFiles` throwing "Model file not found" for a
 * file that had just been fetched. Measured in Chrome on 2026-08-15: a 101 MB
 * model downloaded, `navigator.storage.estimate()` reported 10,788 bytes used.
 *
 * The library does ship an OPFS backend, but it is not exported and the
 * published `esm/storage/` directory contains only type declarations, so it
 * cannot be imported. Hence this: a small, explicit implementation of the same
 * six-method `StorageBackend` interface, passed in deliberately rather than
 * relying on a default.
 *
 * ── Why writes do not use a worker ──
 *
 * wllama's own backend posts every chunk to a worker so it can use
 * `createSyncAccessHandle`, which is worker-only. `createWritable()` has no
 * such restriction and is available on the main thread in current Chrome, Edge
 * and Firefox — verified here before this was written. Using it directly
 * removes a worker, a message protocol and a transferable-buffer dance from the
 * path that writes several hundred megabytes.
 *
 * The cost is that a browser with OPFS but no `createWritable` reports
 * unsupported instead of falling back. That is deliberate: capability detection
 * already refuses to offer a model it cannot run, and reporting honestly is
 * better than a second write path that would almost never execute and would
 * therefore almost never be tested.
 */

/** Everything this backend owns lives under one directory, so `clear` is local. */
const CACHE_DIR = 'wev-ai-models';

export class OpfsStorageBackend {
  /**
   * @param {object} [opts]
   * @param {function} [opts.getDirectory] resolves the cache directory handle.
   *   Injectable so the logic can be tested without a real filesystem — jsdom
   *   has no OPFS, and a backend that could only be exercised in a browser
   *   would not be exercised.
   */
  constructor({ getDirectory } = {}) {
    this._getDirectory = getDirectory || defaultCacheDir;
  }

  isSupported() {
    return (
      typeof navigator !== 'undefined'
      && !!navigator.storage?.getDirectory
      && typeof FileSystemFileHandle !== 'undefined'
      && typeof FileSystemFileHandle.prototype?.createWritable === 'function'
    );
  }

  async read(key) {
    try {
      const dir = await this._getDirectory();
      const handle = await dir.getFileHandle(key);
      return await handle.getFile();
    } catch {
      /* Absent is a normal answer, not an error: the caller is asking whether
         this is cached, and null means no. */
      return null;
    }
  }

  /**
   * Stream a file in.
   *
   * A failed write deletes what it managed to produce. Leaving a partial file
   * behind would present as a cached model of the wrong size — recoverable,
   * because the size check catches it and re-downloads, but it would burn a
   * student's bandwidth twice and occupy space in the meantime.
   */
  async write(key, stream) {
    const dir = await this._getDirectory();
    const handle = await dir.getFileHandle(key, { create: true });

    let writable;
    try {
      writable = await handle.createWritable();
      await writable.truncate(0);

      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
        }
      } finally {
        reader.releaseLock?.();
      }

      await writable.close();
    } catch (err) {
      try {
        await writable?.abort?.();
      } catch {
        /* Already closed or gone. */
      }
      await this.delete(key);

      /* Quota is the one failure with a useful next step, so it is named
         rather than folded into a generic write error. */
      if (err?.name === 'QuotaExceededError') {
        const e = new Error('Not enough storage space on this device for that model.');
        e.name = 'QuotaExceededError';
        e.cause = err;
        throw e;
      }
      throw err;
    }
  }

  /** Size in bytes, or -1 when the key is not present. */
  async getSize(key) {
    const file = await this.read(key);
    return file ? file.size : -1;
  }

  async list() {
    const dir = await this._getDirectory();
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') {
        const file = await handle.getFile();
        out.push({ key: name, size: file.size });
      }
    }
    return out;
  }

  async delete(key) {
    try {
      const dir = await this._getDirectory();
      await dir.removeEntry(key);
    } catch (err) {
      /* Deleting something already absent is success, not failure. */
      if (err?.name !== 'NotFoundError') throw err;
    }
  }
}

async function defaultCacheDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(CACHE_DIR, { create: true });
}

/**
 * A CacheManager that writes where we can actually write.
 *
 * Every construction of `ModelManager` and `Wllama` must be given this. The
 * library's defaults do not work on this origin, and the way that failure
 * presents — a download that succeeds and then cannot be found — is hard enough
 * to trace that it is worth having exactly one place that gets it right.
 */
export async function createCacheManager() {
  const { CacheManager } = await import('@wllama/wllama/esm/index.js');
  return new CacheManager([new OpfsStorageBackend()]);
}
