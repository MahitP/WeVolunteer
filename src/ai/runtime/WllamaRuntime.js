/**
 * Inference on the student's own device, via wllama (llama.cpp compiled to
 * WebAssembly).
 *
 * ── Why wllama and not the alternatives ──
 *
 * The decisive requirement was grammar-constrained decoding. Certificate
 * extraction and tag suggestion need JSON that parses, from models small enough
 * to run in a browser — and models this small do not reliably follow an
 * instruction to "reply only with JSON". wllama passes a JSON Schema through to
 * llama.cpp, which compiles it to a GBNF grammar enforced at the sampler, so a
 * token that would break the schema cannot be emitted. That is a structural
 * guarantee rather than a request, and it is the difference between validation
 * being a safety net and validation being the error path.
 *
 * WebLLM was rejected because it requires WebGPU with no CPU fallback, which
 * would have excluded every browser without it rather than merely slowing them
 * down. Transformers.js was rejected because it has no constrained decoding.
 *
 * ── This module is never imported at module scope ──
 *
 * It is reached only through `src/ai/index.js`, behind a dynamic import guarded
 * by the build-time flag, so a build without on-device AI does not carry the
 * 7.7 MB WebAssembly binary or the runtime. `src/ai/bundleCost.test.js` is what
 * holds that property; if you add a static import of this file anywhere, that
 * test is what will tell you.
 */

/**
 * The WebAssembly binary, served from our own origin.
 *
 * wllama ships a `wasm-from-cdn` helper that points at jsDelivr. It is
 * deliberately not used: it would need another third-party host in the CSP,
 * would break wherever a school network blocks that CDN, and would tell a third
 * party which students use the assistant. The binary is in the package already,
 * so `?url` emits it as an ordinary build asset and it comes from the same
 * origin as the rest of the application.
 */
import wasmUrl from '@wllama/wllama/esm/wasm/wllama.wasm?url';

import { AIStatus, AIRuntimeError, AIAbortError, isAbort, throwIfAborted } from './types.js';
import { checkSize, verifyModel } from '../integrity.js';
import { isDigestVerified, modelUrl } from '../models.js';
import { createCacheManager } from './opfsBackend.js';

/** Replies are bounded so a looping model cannot generate without end. */
const DEFAULT_MAX_TOKENS = 512;

/**
 * Context window actually requested, regardless of what the model supports.
 *
 * Qwen2.5 advertises 32k, but the KV cache for a 32k context costs more memory
 * than the weights of the smallest model, and nothing the assistant does needs
 * it: a question, one tool result, and a short reply fit comfortably. Asking for
 * the advertised maximum would spend a student's memory on headroom no feature
 * uses.
 */
const CONTEXT_TOKENS = 4096;

export class WllamaRuntime {
  constructor() {
    this.status = AIStatus.IDLE;
    this.model = null;
    this.lastError = null;
    this._wllama = null;
  }

  async load(model, { onProgress, signal } = {}) {
    throwIfAborted(signal);
    if (this._wllama) await this.unload();

    try {
      /**
       * The specifier is written out in full, not held in a constant. A bundler
       * can only rewrite a bare specifier in an `import()` it can read
       * statically; behind a variable the string reaches the browser untouched
       * and throws "Failed to resolve module specifier" the first time a model
       * is loaded — a failure no test that avoids downloading a model can see.
       *
       * The deep path is required because the package's `main` field names a
       * file that is not in the tarball. There is no `exports` map, so this is
       * a supported path rather than a reach into private internals.
       */
      const { Wllama, ModelManager, ModelValidationStatus } =
        await import('@wllama/wllama/esm/index.js');

      this.status = AIStatus.DOWNLOADING;

      /**
       * `allowOffline` lets a cached model load with no network, which is the
       * whole point of having downloaded it.
       *
       * `cacheManager` is supplied rather than defaulted: wllama writes to
       * cross-origin storage unless told otherwise, which silently discards
       * everything on this origin. See opfsBackend.js.
       */
      const cacheManager = await createCacheManager();
      const manager = new ModelManager({ allowOffline: true, cacheManager });
      const cached = await manager.getModelOrDownload(
        { url: modelUrl(model) },
        { progressCallback: onProgress, signal },
      );
      throwIfAborted(signal);

      /**
       * wllama's own validation compares the stored length against what the
       * server declared, which catches a download interrupted by a closed tab.
       * Re-downloading is the documented repair.
       */
      if (cached.validate() !== ModelValidationStatus.VALID) {
        await cached.refresh({ progressCallback: onProgress, signal });
        throwIfAborted(signal);
      }

      this.status = AIStatus.LOADING;

      /* Same cache manager as the download used, so the engine reads the file
         that was actually written rather than looking in cross-origin storage
         and finding nothing. */
      this._wllama = new Wllama(
        { default: wasmUrl },
        { allowOffline: true, suppressNativeLog: true, cacheManager },
      );

      /**
       * Two paths, chosen by whether we can afford to hash the file.
       *
       * Small models are opened as Blobs so their SHA-256 can be compared
       * against the digest pinned in the registry — worth doing because a third
       * party serves these bytes.
       *
       * Large models are handed to wllama as a cache handle instead, so the
       * weights stream from storage and never sit in the page as a JavaScript
       * Blob. Holding a gigabyte in order to hash it is exactly the
       * out-of-memory failure the size threshold exists to avoid, so above it
       * the check is length only — and `models.isDigestVerified` is what the UI
       * and the AI policy read so they describe this accurately.
       */
      if (isDigestVerified(model)) {
        const blobs = await cached.open();
        await verifyModel(model, blobs);
        throwIfAborted(signal);
        await this._wllama.loadModel(blobs, { n_ctx: CONTEXT_TOKENS });
      } else {
        checkSize(model, cached.size);
        await this._wllama.loadModel(cached, { n_ctx: CONTEXT_TOKENS });
      }

      this.model = model;
      this.status = AIStatus.READY;
    } catch (err) {
      /* Release whatever was half-built before rethrowing, so a failed load
         does not strand a worker holding memory. */
      await this._discard();

      if (isAbort(err)) {
        this.status = AIStatus.IDLE;
        throw new AIAbortError();
      }

      this.status = AIStatus.ERROR;
      this.lastError = err;
      throw asRuntimeError(err);
    }
  }

  async generate(messages, { onToken, signal, schema, maxTokens = DEFAULT_MAX_TOKENS } = {}) {
    if (this.status !== AIStatus.READY || !this._wllama) {
      throw new AIRuntimeError(`generate() called while status is "${this.status}"`);
    }
    throwIfAborted(signal);

    this.status = AIStatus.GENERATING;

    const params = {
      messages,
      abortSignal: signal,
      max_tokens: maxTokens,
      temperature: schema ? 0.2 : 0.65,
      temp: schema ? 0.2 : 0.65,
      top_p: 0.9,
      top_k: 40,
      penalty_repeat: 1.18,
      penalty_last_n: 64,
      penalty_freq: 0.1,
      penalty_present: 0.1,
    };

    if (schema) {
      /* strict:true is what turns the schema into an enforced grammar rather
         than a suggestion in the prompt. */
      params.response_format = {
        type: 'json_schema',
        json_schema: { name: 'result', schema, strict: true },
      };
    }

    try {
      if (onToken) {
        let out = '';
        await this._wllama.createChatCompletion({
          ...params,
          stream: true,
          onData: chunk => {
            const piece = chunk?.choices?.[0]?.delta?.content;
            if (piece) { out += piece; onToken(piece); }
          },
        });
        this.status = AIStatus.READY;
        return out;
      }

      const res = await this._wllama.createChatCompletion(params);
      this.status = AIStatus.READY;
      return res?.choices?.[0]?.message?.content ?? '';
    } catch (err) {
      /* Cancellation leaves the model loaded and usable — the student ended one
         reply, not the session. Anything else is a real failure. */
      if (isAbort(err)) {
        this.status = AIStatus.READY;
        throw new AIAbortError();
      }
      this.status = AIStatus.ERROR;
      this.lastError = err;
      throw asRuntimeError(err);
    }
  }

  async unload() {
    await this._discard();
    this.model = null;
    this.status = AIStatus.IDLE;
  }

  /** Tear down the worker without touching status, so callers decide the state. */
  async _discard() {
    const instance = this._wllama;
    this._wllama = null;
    if (!instance) return;
    try {
      await instance.exit();
    } catch {
      /* Already gone, or the worker died with it. Nothing left to release. */
    }
  }
}

/**
 * Turn whatever the runtime threw into something showable.
 *
 * Out-of-memory is separated out because it is the one failure with a useful
 * next step — a smaller model — and because the raw message is a WebAssembly
 * allocation error that means nothing to a student.
 */
function asRuntimeError(err) {
  if (err instanceof AIRuntimeError) return err;

  const text = String(err?.message || err);
  if (/memory|allocat|OOM/i.test(text)) {
    return new AIRuntimeError(text, {
      userMessage:
        'This device ran out of memory loading that model. Try a smaller one from Settings.',
      cause: err,
    });
  }
  if (/fetch|network|Failed to fetch/i.test(text)) {
    return new AIRuntimeError(text, {
      userMessage:
        'The model could not be downloaded. Check your connection and try again.',
      cause: err,
    });
  }
  return new AIRuntimeError(text, { cause: err });
}
