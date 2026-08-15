/**
 * The contract between WeVolunteer and whatever is doing the inference.
 *
 * ── Why there is an interface at all ──
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * The first is ordinary: the browser-inference landscape moves quickly, and the
 * runtime chosen today should be replaceable without rewriting the assistant.
 *
 * The second is that the test suite must never download a model. A suite that
 * fetched several hundred megabytes would be unrunnable in CI, unrunnable
 * offline, and slow enough that people would stop running it — and this
 * repository's testing philosophy rests on a suite fast enough to run before
 * every push. `MockRuntime` is what keeps every AI test deterministic and
 * instant, and this file is the shape both implementations agree on.
 *
 * ── The interface ──
 *
 *   load(model, { onProgress, signal })  → Promise<void>
 *   generate(messages, options)          → Promise<string>
 *   unload()                             → Promise<void>
 *   status                               → one of AIStatus
 *
 * `generate` options:
 *   onToken(text)   called per token when streaming
 *   signal          an AbortSignal that genuinely stops generation
 *   schema          JSON Schema; when present the reply is constrained to it
 *   maxTokens       hard ceiling on reply length
 *
 * ── Cancellation is part of the contract, not a nicety ──
 *
 * `signal` must actually stop the work, not merely stop reporting it. A
 * "Stop" button that hides the output while the worker keeps consuming a
 * student's battery and memory is worse than no button, because it silently
 * teaches them the control does something it does not.
 *
 * ── Schema is a structural guarantee, not a request ──
 *
 * When `schema` is given the reply MUST parse against it. The real runtime
 * achieves this by compiling the schema to a grammar enforced at the sampler,
 * so invalid tokens cannot be produced. Any implementation that cannot make
 * that guarantee must reject rather than hope — the callers that pass a schema
 * (certificate extraction, tag suggestion) validate the result again anyway,
 * and a runtime that returns prose where JSON was promised turns a validation
 * failure into a user-visible error for no reason.
 */

/** Every state the assistant can be in. Rendered, so it is deliberately small. */
export const AIStatus = Object.freeze({
  /** This device cannot run local inference at all. */
  UNSUPPORTED: 'unsupported',
  /** Supported, nothing loaded. The resting state before a model is chosen. */
  IDLE: 'idle',
  /** Fetching weights. Has a determinate percentage. */
  DOWNLOADING: 'downloading',
  /** Weights are present; the runtime is initialising. No useful percentage. */
  LOADING: 'loading',
  /** Loaded and idle. */
  READY: 'ready',
  /** Producing a reply. */
  GENERATING: 'generating',
  /** Something failed. `lastError` says what. */
  ERROR: 'error',
});

/**
 * A runtime failure worth showing somebody.
 *
 * `userMessage` is separate from `message` on purpose. The technical text is
 * for the console and belongs nowhere near a student; the user-facing text has
 * to say what happened and what they can do about it, and must never contain a
 * file path, a URL, or a stack.
 */
export class AIRuntimeError extends Error {
  constructor(message, { userMessage, cause } = {}) {
    super(message);
    this.name = 'AIRuntimeError';
    this.userMessage = userMessage
      || 'The assistant could not start. You can try again from Settings.';
    this.cause = cause;
  }
}

/**
 * Raised when the caller cancelled.
 *
 * Distinct from AIRuntimeError because cancellation is not a failure and must
 * not surface as one — a student who pressed Stop should see the reply end, not
 * an error telling them something went wrong.
 */
export class AIAbortError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'AIAbortError';
  }
}

/** True for the one error type that should be swallowed rather than reported. */
export function isAbort(err) {
  return err instanceof AIAbortError
    || err?.name === 'AbortError'
    || err?.name === 'AIAbortError';
}

/** Throws AIAbortError if the signal is already aborted. */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw new AIAbortError();
}
