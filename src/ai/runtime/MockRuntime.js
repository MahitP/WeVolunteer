/**
 * The runtime every test uses.
 *
 * Deterministic, instant, and downloads nothing. It exists so the assistant,
 * the intent router, certificate extraction and tag suggestion can all be
 * tested for the behaviour that matters — what happens when the model returns
 * something unexpected, when a tool fails, when the user cancels — without any
 * of those tests depending on a model file, a GPU, or a network.
 *
 * It is deliberately a little pessimistic. Real small models produce imperfect
 * output, so this one can be told to as well: `queue()` scripts exact replies,
 * including malformed ones, which is how the callers' validation paths get
 * exercised. A mock that only ever returns well-formed answers would leave the
 * error handling untested and the suite would report a confidence it had not
 * earned.
 */

import { AIStatus, AIRuntimeError, AIAbortError, throwIfAborted } from './types.js';

export class MockRuntime {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.responses]   replies to return, in order
   * @param {number}   [opts.progressSteps] how many progress callbacks a load emits
   * @param {Error}    [opts.failLoadWith]  make load() reject, to test error states
   * @param {Error}    [opts.failGenerateWith]
   */
  constructor({ responses = [], progressSteps = 4, failLoadWith = null, failGenerateWith = null } = {}) {
    this._responses = [...responses];
    this._progressSteps = progressSteps;
    this._failLoadWith = failLoadWith;
    this._failGenerateWith = failGenerateWith;

    this.status = AIStatus.IDLE;
    this.model = null;
    this.lastError = null;
    /* Mirrors WllamaRuntime, so a caller reading it is exercised in tests.
       `queueTruncated()` is how a test scripts the cut-off case. */
    this.lastFinishReason = null;
    this._truncateNext = false;

    /* Call records, so tests can assert on what was asked rather than only on
       what came back — the schema a caller passed is often the thing worth
       pinning. */
    this.calls = [];
    this.loadCount = 0;
    this.unloadCount = 0;
  }

  /** Script the next reply. Returns `this` so setup reads as one expression. */
  queue(...responses) {
    this._responses.push(...responses);
    return this;
  }

  /** Script a reply that ended because it ran out of room, not because it finished. */
  queueTruncated(response) {
    this._responses.push(response);
    this._truncateNext = true;
    return this;
  }

  async load(model, { onProgress, signal } = {}) {
    throwIfAborted(signal);
    this.loadCount += 1;
    this.status = AIStatus.DOWNLOADING;

    for (let i = 1; i <= this._progressSteps; i += 1) {
      throwIfAborted(signal);
      onProgress?.({
        loaded: Math.round((model.bytes * i) / this._progressSteps),
        total: model.bytes,
      });
    }

    throwIfAborted(signal);
    this.status = AIStatus.LOADING;

    if (this._failLoadWith) {
      this.status = AIStatus.ERROR;
      this.lastError = this._failLoadWith;
      throw this._failLoadWith;
    }

    this.model = model;
    this.status = AIStatus.READY;
  }

  async generate(messages, { onToken, signal, schema, maxTokens } = {}) {
    if (this.status !== AIStatus.READY) {
      throw new AIRuntimeError(`generate() called while status is "${this.status}"`);
    }
    throwIfAborted(signal);

    this.calls.push({ messages, schema, maxTokens });
    this.status = AIStatus.GENERATING;

    try {
      if (this._failGenerateWith) {
        this.lastError = this._failGenerateWith;
        this.status = AIStatus.ERROR;
        throw this._failGenerateWith;
      }

      const reply = this._responses.length
        ? this._responses.shift()
        : defaultReply(schema);

      /* Streamed a word at a time, keeping the separator, so a caller that
         concatenates tokens reconstructs the reply exactly. A mock that dropped
         whitespace would make joining bugs invisible here and visible only in
         production. */
      let out = '';
      for (const token of reply.split(/(?<=\s)/)) {
        throwIfAborted(signal);
        out += token;
        onToken?.(token);
      }

      this.lastFinishReason = this._truncateNext ? 'length' : 'stop';
      this._truncateNext = false;
      this.status = AIStatus.READY;
      return out;
    } catch (err) {
      /* Cancellation returns the runtime to READY: the student stopped this
         reply, they did not break the assistant. */
      if (err instanceof AIAbortError) this.status = AIStatus.READY;
      throw err;
    }
  }

  async unload() {
    this.unloadCount += 1;
    this.model = null;
    this.status = AIStatus.IDLE;
  }
}

/**
 * What an unscripted call returns.
 *
 * `{}` rather than prose when a schema was requested, because every schema in
 * this codebase describes an object and a caller that asked for one should get
 * something parseable by default. A test wanting a populated object scripts it.
 */
function defaultReply(schema) {
  return schema ? '{}' : 'This is a mock response.';
}
