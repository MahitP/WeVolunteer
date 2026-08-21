import { describe, it, expect, beforeEach } from 'vitest';
import { OpfsStorageBackend } from './opfsBackend.js';

/**
 * A stand-in for an OPFS directory.
 *
 * jsdom has no Origin Private File System, and a storage backend that could
 * only be exercised in a real browser would not be exercised — which is exactly
 * how the library's own default came to discard every byte it was given without
 * anything failing. The directory handle is injectable so the logic is testable
 * here, and the parts that genuinely need a browser (does `createWritable`
 * exist, does the quota hold) are verified in one.
 */
function fakeDirectory({ failWrite = null } = {}) {
  const files = new Map();

  const makeHandle = name => ({
    kind: 'file',
    async getFile() {
      const bytes = files.get(name);
      if (bytes === undefined) throw notFound();
      return new Blob([bytes]);
    },
    async createWritable() {
      const chunks = [];
      return {
        async truncate() { chunks.length = 0; },
        async write(chunk) {
          if (failWrite) throw failWrite;
          chunks.push(chunk);
        },
        async close() {
          files.set(name, concat(chunks));
        },
        async abort() { /* discard */ },
      };
    },
  });

  return {
    files,
    async getFileHandle(name, opts) {
      if (!files.has(name) && !opts?.create) throw notFound();
      if (!files.has(name) && opts?.create) files.set(name, new Uint8Array());
      return makeHandle(name);
    },
    async removeEntry(name) {
      if (!files.has(name)) throw notFound();
      files.delete(name);
    },
    async *entries() {
      for (const name of files.keys()) yield [name, makeHandle(name)];
    },
  };
}

function notFound() {
  const e = new Error('not found');
  e.name = 'NotFoundError';
  return e;
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const streamOf = (...chunks) => new ReadableStream({
  start(controller) {
    chunks.forEach(c => controller.enqueue(new Uint8Array(c)));
    controller.close();
  },
});

let dir;
let backend;

beforeEach(() => {
  dir = fakeDirectory();
  backend = new OpfsStorageBackend({ getDirectory: async () => dir });
});

describe('writing and reading back', () => {
  it('stores a streamed file and returns it whole', async () => {
    await backend.write('model.gguf', streamOf([1, 2, 3], [4, 5]));

    const blob = await backend.read('model.gguf');
    expect(blob).toBeTruthy();
    expect(blob.size).toBe(5);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
  });

  it('reassembles chunks in order', async () => {
    /* A model arrives as hundreds of chunks. Order is the whole file. */
    await backend.write('m', streamOf([1], [2], [3], [4]));
    const blob = await backend.read('m');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  it('replaces rather than appends when written twice', async () => {
    await backend.write('m', streamOf([1, 2, 3]));
    await backend.write('m', streamOf([9]));

    expect((await backend.read('m')).size).toBe(1);
  });
});

describe('absent keys', () => {
  it('reads as null rather than throwing', async () => {
    /* The caller is asking whether something is cached. "No" is an answer. */
    expect(await backend.read('missing')).toBeNull();
  });

  it('reports a size of -1', async () => {
    expect(await backend.getSize('missing')).toBe(-1);
  });

  it('deletes successfully', async () => {
    await expect(backend.delete('missing')).resolves.toBeUndefined();
  });
});

describe('a failed write', () => {
  it('leaves nothing behind', async () => {
    /**
     * A partial file presents as a cached model of the wrong size. The size
     * check would catch it and re-download, but that spends a student's
     * bandwidth twice and occupies the space in between.
     */
    const failing = new OpfsStorageBackend({
      getDirectory: async () => fakeDirectory({ failWrite: new Error('disk gone') }),
    });

    await expect(failing.write('m', streamOf([1, 2, 3]))).rejects.toThrow('disk gone');
    expect(await failing.read('m')).toBeNull();
  });

  it('names a quota failure, because that one has a next step', async () => {
    const quota = Object.assign(new Error('nope'), { name: 'QuotaExceededError' });
    const failing = new OpfsStorageBackend({
      getDirectory: async () => fakeDirectory({ failWrite: quota }),
    });

    const err = await failing.write('m', streamOf([1])).catch(e => e);
    expect(err.name).toBe('QuotaExceededError');
    expect(err.message).toMatch(/not enough storage space/i);
    /* The original is kept, so a log has the real reason. */
    expect(err.cause).toBe(quota);
  });
});

describe('listing', () => {
  it('reports every stored file with its size', async () => {
    await backend.write('a', streamOf([1, 2]));
    await backend.write('b', streamOf([3]));

    const list = await backend.list();
    expect(list).toEqual(
      expect.arrayContaining([{ key: 'a', size: 2 }, { key: 'b', size: 1 }]),
    );
  });

  it('is empty before anything is written', async () => {
    expect(await backend.list()).toEqual([]);
  });

  it('stops listing a file once it is deleted', async () => {
    await backend.write('a', streamOf([1]));
    await backend.delete('a');
    expect(await backend.list()).toEqual([]);
  });
});

describe('support detection', () => {
  it('reports unsupported where there is no OPFS', () => {
    /* jsdom has none, which is the honest answer here — and the one that makes
       capability detection refuse to offer a model rather than download one it
       cannot keep. */
    expect(new OpfsStorageBackend().isSupported()).toBe(false);
  });
});
