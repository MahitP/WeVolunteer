/**
 * The models WeVolunteer will offer to run on a student's own device, and the
 * facts about each one that have to be true before it is offered.
 *
 * ── Why every number here is measured rather than estimated ──
 *
 * A student is being asked to spend several hundred megabytes of a possibly
 * metered connection. The size shown in the picker is the only basis they have
 * for that decision, so an approximate figure is not a rounding convenience —
 * it is a wrong answer to the one question being asked.
 *
 * Every `bytes` and `sha256` below was read from the Hugging Face metadata API
 * on 2026-08-15:
 *
 *   curl "https://huggingface.co/api/models/<repo>?blobs=true"
 *
 * which returns, per file, an exact `size` and an `lfs.sha256`. Nothing here is
 * derived from a model card, a blog post, or arithmetic on a parameter count.
 * `models.integrity.test.js` refuses an entry that is missing either.
 *
 * ── Tiers are provisional ──
 *
 * `tier` is which slot a model occupies in the picker, not a claim about how
 * well it performs. The three entries below are the best-licensed candidates at
 * each size, chosen so Phase 1 has something real to load. Which model actually
 * earns each tier is a question for `src/ai/bench/`, and every entry carries
 * `provisional: true` until that measurement exists. Do not put quality claims
 * in the UI while that flag is set.
 *
 * ── Licensing ──
 *
 * All three are Apache-2.0. This was a selection criterion, not a coincidence:
 * Llama-3.2-1B is a strong candidate at this size and was rejected because the
 * Llama Community License carries attribution and acceptable-use terms that
 * would have to be surfaced to every student, for no capability this set does
 * not already provide.
 */

/**
 * Where model files are fetched from.
 *
 * The single constant that knows this. Self-hosting the weights — which keeps
 * `connect-src` at same-origin and stops a third party learning that a given
 * student uses the feature — is this line plus the matching CSP entry in
 * `server/app.js`. Nothing else in the codebase encodes the origin.
 */
export const MODEL_BASE_URL = 'https://huggingface.co';

/**
 * The largest model that may be offered on iOS and iPadOS, at all.
 *
 * ── Why iOS gets a hard ceiling instead of a warning ──
 *
 * When Safari exceeds its per-tab memory allowance it kills the tab. That is not
 * an exception — there is nothing to catch, no event, no chance to release the
 * buffer and retry, and nothing to report. From the student's side the
 * application simply vanishes mid-download, which reads as the app being broken
 * rather than as the device being too small.
 *
 * Because the failure cannot be detected, it has to be avoided, and avoiding it
 * means refusing to offer what will not fit. The figure is deliberately
 * conservative: it admits the 135M model and nothing else. It is derived from
 * reported failures rather than measured on hardware, so it is a starting
 * position to be revised once real devices have been tested — revised with
 * evidence, and downward as readily as upward.
 */
export const IOS_MAX_MODEL_BYTES = 200 * 1024 * 1024;

/**
 * Above this size a model is verified by length alone, not by digest.
 *
 * WebCrypto has no incremental digest. `crypto.subtle.digest()` is one-shot and
 * needs its entire input resident as a single buffer, and the request for a
 * streaming form (w3c/webcrypto#73) has been open since 2016. So hashing a
 * 940 MB model means holding 940 MB in the page specifically in order to check
 * it — on the weakest devices, an integrity check that causes the crash it was
 * added to protect against.
 *
 * The honest resolution is to say plainly which files are digest-verified and
 * which are not, rather than to imply a guarantee that is not being provided.
 * Byte length is compared for every file on every load, which is free and
 * catches the failure that actually happens: a truncated or partially written
 * cache entry. Above this threshold that is the whole check, and the remaining
 * assurance is TLS to an allowlisted host.
 *
 * If this becomes unacceptable, the fix is not a bigger threshold — it is
 * serving pre-split weights we control, which restores per-chunk digests at a
 * size that is safe to hash.
 */
export const SHA256_MAX_BYTES = 256 * 1024 * 1024;

/** Models that may be offered as the assistant's voice. See `conversational`. */
export const conversationalModels = () => MODELS.filter(m => m.conversational);

/** Tier identifiers, ordered smallest to largest. */
export const TIERS = ['fast', 'balanced', 'advanced'];

export const MODELS = [
  {
    id: 'smollm2-135m-instruct-q4km',
    version: 1,
    tier: 'fast',
    label: 'Fast',
    provisional: true,

    repo: 'unsloth/SmolLM2-135M-Instruct-GGUF',
    file: 'SmolLM2-135M-Instruct-Q4_K_M.gguf',
    bytes: 105454144,
    sha256: 'ed5fa30c487b282ec156c29062f1222e5c20875a944ac98289dbd242e947f747',

    parameters: '135M',
    contextWindow: 8192,
    quantisation: 'Q4_K_M',
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct',
    minDeviceMemoryGB: 2,

    /**
     * Not offered for conversation. Three measurements, all on 2026-08-15:
     *
     *   asked for hours   "inYou have 0 hours of work."
     *   asked with zero   "You could not find anything."  ← its own instructions,
     *                     turning a correct result into an apparent failure
     *   asked for tags    5 of 8 were the two words it was told to avoid
     *
     * The same model is reliable under a grammar: certificate extraction
     * returned correct, schema-valid JSON on every attempt. So it is kept in the
     * registry rather than deleted — it is a good extraction engine and a bad
     * conversationalist, and the honest thing is to stop offering it for the
     * second while keeping the entry for the first.
     *
     * ── What this costs ──
     *
     * This is the only model under `IOS_MAX_MODEL_BYTES`, so withdrawing it from
     * conversation means iPhone and iPad currently get no assistant at all.
     * That is worse than it sounds and better than the alternative: a student on
     * an iPad reading "You could not find anything." when they have hours is a
     * failure of the product, not a limitation of it.
     *
     * Reversing this needs a small model that converses acceptably, not a
     * change of mind.
     */
    conversational: false,
  },
  {
    id: 'qwen2.5-0.5b-instruct-q4km',
    version: 1,
    tier: 'balanced',
    label: 'Balanced',
    provisional: true,

    repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
    file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    bytes: 491400032,
    sha256: '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db',

    conversational: true,
    parameters: '0.5B',
    contextWindow: 32768,
    quantisation: 'Q4_K_M',
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct',

    minDeviceMemoryGB: 4,
  },
  {
    id: 'qwen2.5-1.5b-instruct-q4km',
    version: 1,
    tier: 'advanced',
    label: 'Advanced',
    provisional: true,

    repo: 'bartowski/Qwen2.5-1.5B-Instruct-GGUF',
    file: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    bytes: 986048768,
    sha256: '1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370',

    conversational: true,
    parameters: '1.5B',
    contextWindow: 32768,
    quantisation: 'Q4_K_M',
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct',

    minDeviceMemoryGB: 8,
  },
];

/** The model with this id, or null. Never throws — callers get to decide. */
export function modelById(id) {
  return MODELS.find(m => m.id === id) || null;
}

/** The model occupying a tier, or null. */
export function modelForTier(tier) {
  return MODELS.find(m => m.tier === tier) || null;
}

/**
 * The URL a model's weights are downloaded from.
 *
 * Built from the registry rather than stored, so a repo or filename cannot drift
 * out of step with the digest recorded beside it.
 */
export function modelUrl(model) {
  return `${MODEL_BASE_URL}/${model.repo}/resolve/main/${encodeURIComponent(model.file)}`;
}

/**
 * Whether a model's digest is checked on load.
 *
 * Exported so the UI and the policy can describe the behaviour accurately
 * instead of each restating the threshold and one of them going stale.
 */
export function isDigestVerified(model) {
  return model.bytes <= SHA256_MAX_BYTES;
}

/**
 * A human-readable size, for the one place it matters most — the moment before
 * somebody agrees to download it.
 *
 * Binary units, because that is what a browser's storage estimate reports; a
 * picker saying 105 MB beside a quota reading 100 MiB invites the reader to
 * conclude one of them is lying.
 */
export function formatBytes(bytes) {
  const mib = bytes / (1024 * 1024);
  if (mib < 1024) return `${Math.round(mib)} MB`;
  return `${(mib / 1024).toFixed(1)} GB`;
}
