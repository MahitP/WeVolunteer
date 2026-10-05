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
import compatWasmUrl from '@wllama/wllama-compat/wasm/wllama.wasm?url';

import { AIStatus, AIRuntimeError, AIAbortError, isAbort, throwIfAborted } from './types.js';
import { IntegrityError, verifyModel } from '../integrity.js';
import { isDigestVerified } from '../models.js';
import { createCacheManager } from './opfsBackend.js';
import { acquireModel } from './modelCache.js';
import { supportsMemory64 } from '../capability.js';

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

/**
 * How long the engine may take to take the model from storage into memory.
 *
 * A model loads in seconds (the Balanced model took 3 on a laptop), so two
 * minutes is generous for a slow phone and still ends. It exists because a
 * load that never settles is the failure a reader cannot get out of: in Safari
 * the engine aborted, wllama's handler for the abort threw before rejecting
 * anything, and Welly showed "Thinking" for good (iPhone Simulator,
 * 2026-10-05).
 */
export const LOAD_TIMEOUT_MS = 120_000;

/**
 * Run the compatibility engine, for a browser that cannot compile 64-bit
 * WebAssembly.
 *
 * The default engine is Memory64. Safari cannot compile it, yet passes the
 * check wllama makes before choosing (it only constructs a 64-bit memory from
 * JavaScript), so left alone wllama starts the engine Safari cannot run, the
 * worker aborts, and the load never settles (iPhone Simulator, 2026-10-05).
 *
 * `@wllama/wllama-compat` is wllama's own build for exactly these browsers: no
 * Memory64, Asyncify instead of JSPI, and slower. It is served from this
 * origin like the default engine, never from the CDN wllama would otherwise
 * fetch it from. The worker code is imported on demand, so nobody whose
 * browser runs the default engine downloads it.
 *
 * `getWorkerResources` is replaced rather than trusting wllama's `needCompat`,
 * which is the check Safari passes. It is public, and it is the one place
 * wllama decides which engine a worker starts.
 */
async function useCompatibilityEngine(wllama) {
  const { default: code } = await import('@wllama/wllama-compat/wasm/wllama.js?raw');
  const wasmPath = typeof location === 'undefined' ? compatWasmUrl : new URL(compatWasmUrl, location.href).href;
  wllama.setCompat?.({ wasm: compatWasmUrl, worker: { code } });
  const resources = wllama.getWorkerResources.bind(wllama);
  wllama.getWorkerResources = () => ({ ...resources(), wasmPath, jsPath: { code }, compat: true });
}

/** How long a worker that is being let go may take to answer its exit. */
const EXIT_TIMEOUT_MS = 2_000;

/** `promise`, or a rejection with `error` after `ms`. The timer never outlives it. */
function within(promise, ms, error) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(error), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

export class WllamaRuntime {
  constructor() {
    this.status = AIStatus.IDLE;
    this.model = null;
    this.lastError = null;
    /**
     * Why the last generation ended: `'stop'` when the model finished, or
     * `'length'` when it hit `max_tokens` and was cut off mid-sentence.
     *
     * A property rather than a return value because every caller wants the
     * text and only one wants this, and because `generate()` refuses to run
     * while the status is GENERATING — so two generations cannot interleave and
     * overwrite each other's answer. It is read in the same continuation as the
     * `await` that set it.
     */
    this.lastFinishReason = null;
    this._wllama = null;
    /**
     * The generation currently in flight worker-side, if any.
     *
     * Cancelling rejects our promise but does not stop the worker, which keeps
     * decoding the abandoned reply. Asking the next question before it finishes
     * lands on a busy worker, and the request comes back as an abort that was
     * never ours — so the reader pressed Stop once and saw "Stopped." twice,
     * the second time in answer to a new question.
     *
     * Awaiting this before starting serialises the two, which is what the
     * worker requires anyway. The cost lands only on somebody who cancels and
     * immediately asks again.
     */
    this._inFlight = null;
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
      const { Wllama, ModelManager } =
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

      /**
       * ── Why this is not `getModelOrDownload` plus `validate()`/`refresh()` ──
       *
       * It was, and that pair could not repair the one thing it was there to
       * repair. `validate()` compares the file's length against the length the
       * SERVER declared, and `refresh()` calls a download that returns early
       * whenever a file with that key already exists — so an interrupted
       * download left a short file that failed validation forever and was never
       * re-fetched. The reader saw a model that would not start, on every
       * attempt, with no way out but Remove in Settings.
       *
       * Both halves of that live in `modelCache.js` now: the length comes from
       * the bytes on disk, and a bad entry is deleted before the second
       * attempt, which is what gets past wllama's early return.
       */
      const cached = await acquireModel(manager, model, { onProgress, signal });
      throwIfAborted(signal);

      this.status = AIStatus.LOADING;

      /* Same cache manager as the download used, so the engine reads the file
         that was actually written rather than looking in cross-origin storage
         and finding nothing. */
      this._wllama = new Wllama(
        { default: wasmUrl },
        { allowOffline: true, suppressNativeLog: true, cacheManager },
      );
      if (!supportsMemory64()) await useCompatibilityEngine(this._wllama);

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
       *
       * The length check for BOTH paths has already run, in `acquireModel`,
       * against the bytes on disk. It used to be repeated here as
       * `checkSize(model, cached.size)`, which read the length the server
       * declared rather than the length of the file — see modelCache.js.
       */
      const notStarting = new AIRuntimeError(
        `The engine did not finish loading ${model.id} within ${LOAD_TIMEOUT_MS / 1000}s.`,
      );
      if (isDigestVerified(model)) {
        const blobs = await cached.open();
        await verifyModel(model, blobs);
        throwIfAborted(signal);
        await within(this._wllama.loadModel(blobs, { n_ctx: CONTEXT_TOKENS }), LOAD_TIMEOUT_MS, notStarting);
      } else {
        await within(this._wllama.loadModel(cached, { n_ctx: CONTEXT_TOKENS }), LOAD_TIMEOUT_MS, notStarting);
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

  /**
   * ── Why this does not stream, and how that was established ──
   *
   * wllama's streaming delivery intermittently withholds the final chunk of a
   * generation and hands it to the NEXT request. Roughly half of all replies
   * lost their last characters and the reply after them opened with the
   * remains:
   *
   *     "The capital of Spain is Madrid"     no full stop
   *     ".The capital of Kenya is"           there it is
   *     "Nairobi.The capital of Peru"        and again
   *
   * This is the true source of the stray leading characters, and of short
   * replies missing their terminal punctuation. Two generations of "cleanup"
   * code were written against the symptom — `formatResponseText` stripping
   * leading punctuation, `sanitizeHistory` appending a full stop — and both
   * damaged correct replies to hide it.
   *
   * Six fixes were tried on the streaming path and measured. None worked:
   *
   *   `cache_prompt: false`         prompt-prefix reuse is not the mechanism
   *   a six-second pause            not a queued message waiting to be read
   *   the async-iterator form       the loop still ends a chunk early
   *   `break` (iterator `return()`) the generator discards nothing
   *   draining after cancellation   the stream had already ended
   *   upgrading to wllama 3.6.0     which added a `req_id` per `get_result`
   *                                 and a `cancelRequest` on early exit —
   *                                 precisely the machinery a JavaScript cause
   *                                 would live in, and it changed nothing
   *
   * The seventh attempt is the one that worked, and it is not a fix so much as
   * a route around: the SAME four questions through the non-streaming call came
   * back complete, every time. So the model, its context and the prompt were
   * never at fault; the streaming delivery path alone is, and not using it is
   * the remedy. Verified through the interface, six consecutive questions, all
   * six ending in a full stop with no leading fragment.
   *
   * ── What it costs, measured ──
   *
   * Progressive display, in exchange for text that is right and for a
   * `finish_reason` that actually arrives — under streaming it never did,
   * because the chunk carrying it is the one being dropped, so the "ran out of
   * room" notice could not fire at all.
   *
   * The cost is small because CHAT_PROMPT asks for short answers. On the 0.5B
   * model: a one-sentence reply 280–530 ms, two paragraphs 2.2 s. Only a
   * deliberately long request reached 14 s, and that one reports
   * `finish_reason: 'length'`, which the interface labels. The thinking
   * indicator covers the wait.
   *
   * Worth revisiting if wllama fixes the streaming path; worth reporting there
   * either way.
   */
  async generate(messages, { onToken, signal, schema, maxTokens = DEFAULT_MAX_TOKENS } = {}) {
    if (this.status !== AIStatus.READY || !this._wllama) {
      throw new AIRuntimeError(`generate() called while status is "${this.status}"`);
    }
    throwIfAborted(signal);

    /* A cancelled generation is still running in the worker. Let it finish
       before starting another — see `_inFlight`. */
    if (this._inFlight) {
      try { await this._inFlight; } catch { /* it was abandoned; that is the point */ }
      this._inFlight = null;
      throwIfAborted(signal);
    }

    this.status = AIStatus.GENERATING;

    const params = {
      messages,
      abortSignal: signal,
      max_tokens: maxTokens,
      /**
       * ── `temp`, not `temperature` ──
       *
       * wllama's `SamplingParams` names it `temp`; `temperature` is the
       * OAI-compatibility alias on `ChatCompletionParams`, and both are
       * forwarded verbatim to llama.cpp, where `temp` wins. Setting one and
       * meaning the other is how a sampler ends up at a value nobody chose, so
       * only the name the sampler reads is set here.
       *
       * Grammar-constrained work (certificate extraction, tag suggestion) wants
       * the likeliest token; conversation wants a little room. 0.45 is that
       * room. It was briefly 0.65, which at this model size mostly buys
       * invented detail — the failure CHAT_PROMPT's grounding line exists to
       * limit — and 0.3 before that.
       */
      temp: schema ? 0.2 : 0.45,
      top_p: 0.9,
      top_k: 40,
      /**
       * ── Why the repetition penalties are off ──
       *
       * They were on: `penalty_repeat: 1.18` over a 64-token window, plus
       * frequency and presence penalties of 0.1 each. All three were added to
       * stop a small model looping, which it does.
       *
       * llama.cpp applies them to EVERY token in the window, and the tokens a
       * fluent English sentence repeats most are `.`, `,`, `the`, `to`, `you`.
       * A penalty stack tuned to discourage repetition therefore discourages
       * punctuation and function words first, and the observable result is
       * exactly what was reported: replies that trail off without a full stop,
       * commas that go missing, sentences that read as if a word were dropped.
       * The repairs in `assistant.js` were then written against that damage.
       *
       * llama.cpp's own defaults are 1.0 / 0.0 / 0.0 — the penalty sampler
       * disabled — and that is what these values restore.
       *
       * Looping is still caught, after the fact and without touching grammar:
       * `hasRepetitiveLoop` in prompts/welly.js rejects a reply that repeats a
       * phrase, and the deterministic sentence is shown instead. That check
       * costs nothing when the model behaves and cannot corrupt a reply that is
       * fine, which is the difference between the two approaches.
       */
      penalty_repeat: 1.0,
      penalty_freq: 0,
      penalty_present: 0,
    };

    if (schema) {
      /* strict:true is what turns the schema into an enforced grammar rather
         than a suggestion in the prompt. */
      params.response_format = {
        type: 'json_schema',
        json_schema: { name: 'result', schema, strict: true },
      };
    }

    this.lastFinishReason = null;

    try {
      /**
       * ── One call, and it is the non-streaming one ──
       *
       * wllama's streaming delivery intermittently withholds the final chunk of
       * a generation and hands it to the NEXT one, so roughly half of all
       * replies lost their last characters and the reply after them opened with
       * the remains:
       *
       *     "The capital of Spain is Madrid"    no full stop
       *     ".The capital of Kenya is"          there it is
       *
       * The same four questions through the non-streaming call, back to back,
       * came back "The capital of France is Paris." / "…Italy is Rome." /
       * "…Spain is Madrid." / "…Kenya is Nairobi." — every one complete. So the
       * model and its context were never the problem, and neither was
       * `cache_prompt`, the async-iterator form, `break`, draining, or the
       * request-scoping rewrite in wllama 3.6.0. It is the streaming path
       * specifically, and not calling it is the fix.
       *
       * ── What it costs, measured ──
       *
       * Progressive display. In exchange the text is right, and `finish_reason`
       * arrives — in streaming it never did, because the chunk carrying it is
       * the one being dropped, so the "ran out of room" notice could not fire
       * at all.
       *
       * The cost is small because CHAT_PROMPT now asks for short answers.
       * Measured on the 0.5B model: a one-sentence answer 280–530 ms, a
       * two-paragraph answer 2.2 s. Only a deliberately long request reached
       * 14 s, and that one is `finish_reason: 'length'`, which the interface
       * now labels. The thinking indicator covers the wait.
       *
       * `onToken` is still honoured, once, with the finished text — callers get
       * the same contract (what was emitted concatenates to what is returned),
       * and `MockRuntime` still emits word by word, so every test that pins
       * fragment reassembly keeps exercising it.
       */
      const pending = this._wllama.createChatCompletion(params);
      this._inFlight = pending;
      const res = await pending;
      this._inFlight = null;

      this.lastFinishReason = res?.choices?.[0]?.finish_reason ?? null;
      const text = res?.choices?.[0]?.message?.content ?? '';
      if (onToken && text) onToken(text);
      this.status = AIStatus.READY;
      return text;
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
      /* Bounded: a worker wedged enough to stop a load may not answer this
         either, and letting it go must not become the next thing that hangs. */
      await within(instance.exit(), EXIT_TIMEOUT_MS, new Error('exit timed out'));
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

  /**
   * The file is present and is not the file we asked for — after a fresh
   * download, because `acquireModel` has already thrown the first copy away and
   * fetched again. So this is not "retry", it is "that transfer is not
   * completing", and the sentence says which model so a reader with two
   * installed knows which one to remove.
   */
  if (err instanceof IntegrityError) {
    return new AIRuntimeError(text, {
      userMessage:
        'The model file on this device is incomplete, and downloading it again '
        + 'did not finish either. Remove it in Settings and set it up once more '
        + 'on a connection you can leave open.',
      cause: err,
    });
  }

  /**
   * Out of room. A model this size can exhaust a browser's storage allowance
   * on a nearly full device, and the write is abandoned rather than half kept
   * — so the next step is space, not a retry.
   */
  if (err?.name === 'QuotaExceededError' || /quota|storage space/i.test(text)) {
    return new AIRuntimeError(text, {
      userMessage:
        'There is not enough space in this browser for that model. Free some up, '
        + 'or choose a smaller model in Settings.',
      cause: err,
    });
  }

  /**
   * llama.cpp could not read the weights. Named separately from the generic
   * failure because it has a specific and unobvious remedy — the bytes are
   * wrong, so removing them and downloading again is the whole fix — and
   * because the raw text is a GGUF parse message that reads as if the model
   * itself were at fault.
   */
  if (/gguf|load_error|failed to load model|invalid model|magic/i.test(text)) {
    return new AIRuntimeError(text, {
      userMessage:
        'That model could not be read on this device. Remove it in Settings and '
        + 'set it up again — the copy stored here is damaged.',
      cause: err,
    });
  }

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
