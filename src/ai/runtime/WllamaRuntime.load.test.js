import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIStatus, AIRuntimeError, AIAbortError } from './types.js';
import { modelForTier, modelUrl } from '../models.js';

/**
 * Starting the model, and the two things that stop it.
 *
 * ── Why this file exists ──
 *
 * Reported: the Advanced model would not start while Balanced did. Every test
 * the assistant had used `MockRuntime`, deliberately — a suite that downloads a
 * gigabyte is a suite nobody runs — which meant the LOAD path, the one that was
 * broken, had no coverage at all. The interface between this runtime and wllama
 * is small and stable, so it can be faked, and the parts that were wrong are
 * all on our side of it.
 *
 * What is faked is the library. What is under test is our sequencing: what gets
 * length-checked, what is thrown away and re-fetched, what the reader is told
 * when it cannot be fixed, and whether switching models leaves an engine
 * behind.
 */

const ADVANCED = modelForTier('advanced');
const BALANCED = modelForTier('balanced');

/* Rebuilt per test by `setup()`. Declared through `vi.hoisted` because
   `vi.mock` factories are lifted above every const in the file. */
const h = vi.hoisted(() => ({
  /** Bytes on disk per model URL; null means nothing cached. */
  disk: new Map(),
  /** What a fresh download writes, per URL. Defaults to the full size. */
  downloadWrites: new Map(),
  downloads: 0,
  deletes: 0,
  loadModelImpl: null,
  exitImpl: null,
  loadedWith: [],
  exits: 0,
  progressSeen: [],
  memory64: true,
}));

vi.mock('../capability.js', async importOriginal => ({
  ...(await importOriginal()),
  supportsMemory64: () => h.memory64,
}));

vi.mock('@wllama/wllama/esm/index.js', () => {
  class Model {
    constructor(url, bytesOnDisk, declared) {
      this.url = url;
      /* wllama's own `size` is the sum of the DECLARED lengths, which is
         correct whether or not the file is whole. Faithfully reproduced,
         because it is the number the old check was reading. */
      this.size = declared;
      this.files = bytesOnDisk == null
        ? []
        : [{ name: 'f1', size: bytesOnDisk, metadata: { originalSize: declared } }];
    }
    async open() {
      return [new Blob([new Uint8Array(8)])];
    }
    async remove() {
      h.disk.set(this.url, null);
      h.deletes += 1;
    }
  }

  class ModelManager {
    constructor(params = {}) {
      this.params = params;
      this.cacheManager = {
        delete: async url => { h.disk.set(url, null); h.deletes += 1; },
      };
    }
    async getModelOrDownload({ url }, { progressCallback } = {}) {
      const declared = h.declaredFor(url);
      let onDisk = h.disk.get(url) ?? null;
      if (onDisk == null) {
        h.downloads += 1;
        onDisk = h.downloadWrites.has(url) ? h.downloadWrites.get(url) : declared;
        h.disk.set(url, onDisk);
        progressCallback?.({ loaded: Math.floor(onDisk / 2), total: declared });
        progressCallback?.({ loaded: onDisk, total: declared });
      } else {
        progressCallback?.({ loaded: onDisk, total: onDisk });
      }
      return new Model(url, onDisk, declared);
    }
  }

  class Wllama {
    constructor(pathConfig, config) {
      this.pathConfig = pathConfig;
      this.config = config;
      this.compat = null;
    }
    setCompat(compat) { this.compat = compat; }
    /* wllama's own choice, which Safari fools: it always says "default" here. */
    getWorkerResources() {
      return { wasmPath: String(this.pathConfig.default), compat: false };
    }
    async loadModel(source, params) {
      h.loadedWith.push({ source, params });
      if (h.loadModelImpl) await h.loadModelImpl(source, params);
    }
    async createChatCompletion() {
      return { choices: [{ finish_reason: 'stop', message: { content: 'ok.' } }] };
    }
    async exit() {
      h.exits += 1;
      if (h.exitImpl) await h.exitImpl();
    }
  }

  return {
    Wllama,
    ModelManager,
    Model,
    ModelValidationStatus: { VALID: 'valid', INVALID: 'invalid', DELETED: 'deleted' },
  };
});

vi.mock('./opfsBackend.js', () => ({
  createCacheManager: async () => ({ marker: 'ours' }),
  OpfsStorageBackend: class {},
}));

const { WllamaRuntime, LOAD_TIMEOUT_MS } = await import('./WllamaRuntime.js');

/** Declared length per URL — the registry's own figure. */
h.declaredFor = url => (url === modelUrl(ADVANCED) ? ADVANCED.bytes : BALANCED.bytes);

function cache(model, bytes) {
  h.disk.set(modelUrl(model), bytes);
}

beforeEach(() => {
  h.disk.clear();
  h.downloadWrites.clear();
  h.downloads = 0;
  h.deletes = 0;
  h.exits = 0;
  h.loadedWith = [];
  h.progressSeen = [];
  h.loadModelImpl = null;
  h.exitImpl = null;
  h.memory64 = true;
  vi.useRealTimers();
});

describe('loading a model that is on the device and complete', () => {
  it('reaches READY without downloading anything', async () => {
    cache(ADVANCED, ADVANCED.bytes);
    const runtime = new WllamaRuntime();

    await runtime.load(ADVANCED);

    expect(runtime.status).toBe(AIStatus.READY);
    expect(runtime.model).toBe(ADVANCED);
    expect(h.downloads).toBe(0);
  });

  it('asks for the context window the runtime chose, not the model’s maximum', async () => {
    cache(ADVANCED, ADVANCED.bytes);
    await new WllamaRuntime().load(ADVANCED);

    expect(h.loadedWith).toHaveLength(1);
    expect(h.loadedWith[0].params.n_ctx).toBe(4096);
  });

  /**
   * Above `SHA256_MAX_BYTES` the weights are handed over as a cache handle so a
   * gigabyte never sits in the page as a Blob. Both offered models are above it.
   */
  it('hands the large model over as a cache handle rather than as blobs', async () => {
    cache(ADVANCED, ADVANCED.bytes);
    await new WllamaRuntime().load(ADVANCED);

    expect(Array.isArray(h.loadedWith[0].source)).toBe(false);
    expect(h.loadedWith[0].source.url).toBe(modelUrl(ADVANCED));
  });
});

describe('the failure that kept the Advanced model from starting', () => {
  /**
   * A download interrupted by a closed tab leaves a short file whose DECLARED
   * length is still right. That combination used to pass the length check and
   * reach llama.cpp, which failed to parse it — and wllama's own re-download
   * returns early over an existing key, so it could never be repaired.
   */
  it('repairs a short cache entry and starts', async () => {
    cache(ADVANCED, Math.floor(ADVANCED.bytes / 3));
    const runtime = new WllamaRuntime();

    await runtime.load(ADVANCED);

    expect(h.deletes).toBe(1);
    expect(h.downloads).toBe(1);
    expect(runtime.status).toBe(AIStatus.READY);
  });

  it('never hands a short file to the inference engine', async () => {
    cache(ADVANCED, 4096);
    h.downloadWrites.set(modelUrl(ADVANCED), 4096);

    await expect(new WllamaRuntime().load(ADVANCED)).rejects.toThrow(AIRuntimeError);
    expect(h.loadedWith).toHaveLength(0);
  });

  it('says what to do when a second download is short as well', async () => {
    cache(ADVANCED, 4096);
    h.downloadWrites.set(modelUrl(ADVANCED), 4096);
    const runtime = new WllamaRuntime();

    const err = await runtime.load(ADVANCED).catch(e => e);

    expect(runtime.status).toBe(AIStatus.ERROR);
    expect(err.userMessage).toMatch(/incomplete/i);
    expect(err.userMessage).toMatch(/remove it in settings/i);
    /* Never a file path, a URL or a stack — see AIRuntimeError. */
    expect(err.userMessage).not.toMatch(/https?:|\.gguf/);
  });
});

describe('what the reader is told when the load fails for another reason', () => {
  const messageFor = async (thrown, model = ADVANCED) => {
    cache(model, model.bytes);
    h.loadModelImpl = async () => { throw thrown; };
    const err = await new WllamaRuntime().load(model).catch(e => e);
    return err.userMessage;
  };

  it('names memory, and a smaller model, for an allocation failure', async () => {
    expect(await messageFor(new Error('Aborted(). Build with -sASSERTIONS: out of memory')))
      .toMatch(/ran out of memory/i);
  });

  it('names the connection for a failed fetch', async () => {
    expect(await messageFor(new Error('Failed to fetch')))
      .toMatch(/could not be downloaded/i);
  });

  /**
   * A GGUF parse error reads as if the model itself were wrong. It is not — the
   * bytes on this device are — and the remedy is specific enough to state.
   */
  it('names a damaged copy for a GGUF parse failure', async () => {
    const message = await messageFor(new Error('load_error: failed to load model from models/model-00001-of-00001.gguf'));
    expect(message).toMatch(/could not be read on this device/i);
    expect(message).toMatch(/remove it in settings/i);
  });

  it('names space for a quota failure', async () => {
    const quota = new Error('Not enough storage space on this device for that model.');
    quota.name = 'QuotaExceededError';
    expect(await messageFor(quota)).toMatch(/not enough space/i);
  });

  it('leaves nothing loaded behind a failed start', async () => {
    cache(ADVANCED, ADVANCED.bytes);
    h.loadModelImpl = async () => { throw new Error('load_error: bad magic'); };
    const runtime = new WllamaRuntime();

    await runtime.load(ADVANCED).catch(() => {});

    expect(h.exits).toBe(1);
    expect(runtime._wllama).toBeNull();
  });
});

describe('cancelling a load', () => {
  it('reports an abort rather than a failure, and leaves nothing running', async () => {
    cache(ADVANCED, ADVANCED.bytes);
    const controller = new AbortController();
    controller.abort();
    const runtime = new WllamaRuntime();

    await expect(runtime.load(ADVANCED, { signal: controller.signal }))
      .rejects.toBeInstanceOf(AIAbortError);
    expect(runtime.status).toBe(AIStatus.IDLE);
  });
});

describe('progress', () => {
  it('is reported while the weights are being fetched', async () => {
    const seen = [];
    await new WllamaRuntime().load(BALANCED, { onProgress: p => seen.push(p) });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toEqual({ loaded: BALANCED.bytes, total: BALANCED.bytes });
  });

  it('reports a cached model as already complete rather than as a transfer', async () => {
    cache(BALANCED, BALANCED.bytes);
    const seen = [];
    await new WllamaRuntime().load(BALANCED, { onProgress: p => seen.push(p) });

    expect(seen.every(p => p.loaded === p.total)).toBe(true);
  });
});

describe('switching between the two models', () => {
  it('goes Balanced, then Advanced, then back, leaving one engine each time', async () => {
    cache(BALANCED, BALANCED.bytes);
    cache(ADVANCED, ADVANCED.bytes);
    const runtime = new WllamaRuntime();

    await runtime.load(BALANCED);
    expect(runtime.model).toBe(BALANCED);

    await runtime.load(ADVANCED);
    expect(runtime.model).toBe(ADVANCED);
    /* The previous engine is torn down before the next is built — otherwise the
       first model's weights stay resident and unreachable, which on these sizes
       is most of a gigabyte leaked inside a browser tab. */
    expect(h.exits).toBe(1);

    await runtime.load(BALANCED);
    expect(runtime.model).toBe(BALANCED);
    expect(h.exits).toBe(2);

    await runtime.unload();
    expect(h.exits).toBe(3);
    expect(runtime.status).toBe(AIStatus.IDLE);
  });

  it('answers after returning to Advanced', async () => {
    cache(BALANCED, BALANCED.bytes);
    cache(ADVANCED, ADVANCED.bytes);
    const runtime = new WllamaRuntime();

    await runtime.load(BALANCED);
    await runtime.load(ADVANCED);

    const text = await runtime.generate([{ role: 'user', content: 'hello' }]);
    expect(text).toBe('ok.');
    expect(runtime.status).toBe(AIStatus.READY);
    expect(runtime.lastFinishReason).toBe('stop');
  });
});

/**
 * Safari, found in the iPhone Simulator on 2026-10-05.
 *
 * The engine build is 64-bit WebAssembly, which that Safari cannot compile.
 * The worker aborted, wllama's handler for the abort threw before it rejected
 * anything, and `loadModel` never settled: the student watched "Thinking" for
 * good. The capability check now keeps such a browser from being offered the
 * download; these are the two layers behind it.
 */
describe('an engine that cannot start', () => {
  it('runs the self-hosted compatibility engine in a browser that cannot compile the default one', async () => {
    h.memory64 = false;
    cache(BALANCED, BALANCED.bytes);
    const runtime = new WllamaRuntime();

    await runtime.load(BALANCED);

    const resources = runtime._wllama.getWorkerResources();
    expect(resources.compat).toBe(true);
    expect(resources.wasmPath).toMatch(/wllama-compat/);
    expect(resources.wasmPath).not.toMatch(/^https?:\/\/(?!localhost)/);
    expect(resources.jsPath.code.length).toBeGreaterThan(1000);
    expect(runtime.status).toBe(AIStatus.READY);
  });

  it('leaves a browser that can compile it on the default engine', async () => {
    cache(BALANCED, BALANCED.bytes);
    const runtime = new WllamaRuntime();

    await runtime.load(BALANCED);

    expect(runtime._wllama.getWorkerResources().compat).toBe(false);
    expect(runtime._wllama.compat).toBeNull();
  });

  it('fails at a time limit instead of loading for ever, and lets the engine go', async () => {
    vi.useFakeTimers();
    cache(BALANCED, BALANCED.bytes);
    h.loadModelImpl = () => new Promise(() => {});
    /* A wedged worker may not answer its exit message either. */
    h.exitImpl = () => new Promise(() => {});
    const runtime = new WllamaRuntime();

    const outcome = runtime.load(BALANCED).catch(e => e);
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS + 10000);
    const err = await outcome;

    expect(err).toBeInstanceOf(AIRuntimeError);
    expect(err.userMessage).toMatch(/could not start/i);
    expect(runtime.status).toBe(AIStatus.ERROR);
    expect(h.exits).toBe(1);
  });
});
