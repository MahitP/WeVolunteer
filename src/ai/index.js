/**
 * The only door into the on-device AI feature.
 *
 * Everything the rest of the application needs is re-exported here, and it is
 * all wllama-free: capability detection, the model registry, the status
 * constants and the error types are ordinary modules that cost a few kilobytes
 * and can be imported anywhere.
 *
 * The runtime is different. It carries a 7.7 MB WebAssembly binary, and a build
 * that has not switched this feature on must not ship it. So there is exactly
 * one dynamic import in the codebase that reaches it — `createRuntime()` below —
 * and the flag is checked at that boundary rather than in the UI.
 *
 * ── Why the flag is read here, and why as a raw literal ──
 *
 * Vite replaces `import.meta.env.VITE_LOCAL_AI` with a literal during
 * transform. With the flag unset the comparison folds to `false`, the branch
 * becomes dead code, and the dynamic import inside it is eliminated along with
 * the chunk and the 7.66 MB asset it would have pulled in.
 *
 * The raw `import.meta.env` reference is deliberate and is NOT interchangeable
 * with the `LOCAL_AI` constant exported from `config.js`. Measured against
 * Vite 8.1 on 2026-08-15, with the flag unset:
 *
 *   guarded by `LOCAL_AI` (imported constant) …… 10,144 KB of assets
 *   guarded by `import.meta.env` directly ……………  2,652 KB of assets
 *
 * The constant version shipped the runtime and the WebAssembly binary into a
 * build with the feature switched off — because eliminating that branch needs a
 * value folded across a module boundary, while the literal folds locally. This
 * is the shape of vitejs/vite issue 22362, and it is why the property is
 * asserted by `bundleCost.test.js` rather than assumed.
 *
 * `LOCAL_AI` is still the right thing to use everywhere else; screens read it to
 * decide what to render. It is only this one import boundary that needs the
 * literal.
 */

import { LOCAL_AI } from '../config.js';

export { AIStatus, AIRuntimeError, AIAbortError, isAbort } from './runtime/types.js';
export { IntegrityError } from './integrity.js';
export { detectCapability, offerableModels } from './capability.js';
export {
  MODELS,
  TIERS,
  modelById,
  modelForTier,
  formatBytes,
  isDigestVerified,
} from './models.js';
export { forgetVerifications } from './integrity.js';

/** Whether this build was made with on-device AI at all. */
export function isLocalAIEnabled() {
  return LOCAL_AI;
}

/**
 * Construct the inference runtime, loading it on demand.
 *
 * Rejects rather than returning null when the feature is off, because every
 * caller reaches this only after `isLocalAIEnabled()` and a capability check
 * have already passed — arriving here in a build without AI is a programming
 * error, and returning null would let it surface later as a confusing failure
 * somewhere else.
 */
export async function createRuntime() {
  /**
   * The import sits INSIDE the truthy branch, not after an early return.
   *
   * This shape matters more than it looks. Written as
   * `if (!LOCAL_AI) throw; const x = await import(...)`, the import is not
   * inside dead code — it merely follows a throw that happens to be
   * unconditional — and whether it survives depends on how far the bundler is
   * willing to reason about unreachable statements. Nested inside `if (false)`
   * it is unambiguously dead, and the chunk and its 7.7 MB asset go with it.
   */
  if (import.meta.env.VITE_LOCAL_AI === 'true') {
    const { WllamaRuntime } = await import('./runtime/WllamaRuntime.js');
    return new WllamaRuntime();
  }
  throw new Error('createRuntime() called in a build without VITE_LOCAL_AI');
}

/**
 * The model-storage helpers, loaded on demand.
 *
 * Settings needs to report how much space the models occupy and to remove them,
 * neither of which should require constructing an inference engine. Same guard,
 * same reasoning, same literal — see the note above about why this cannot be
 * the imported constant.
 */
export async function aiStorage() {
  if (import.meta.env.VITE_LOCAL_AI === 'true') {
    return import('./runtime/storage.js');
  }
  throw new Error('aiStorage() called in a build without VITE_LOCAL_AI');
}

/**
 * Certificate reading, loaded on demand.
 *
 * Behind the same guard as everything else, for a different reason: this one
 * carries `pdfjs-dist`, which is over a megabyte and is pointless in a build
 * where nobody can reach the import control.
 *
 * Note that most of what this does needs no model — a PDF's text layer and a
 * set of patterns answer the common case outright. The model is asked only for
 * what those miss.
 */
export async function aiCertificate() {
  if (import.meta.env.VITE_LOCAL_AI === 'true') {
    return import('./certificate/index.js');
  }
  throw new Error('aiCertificate() called in a build without VITE_LOCAL_AI');
}
