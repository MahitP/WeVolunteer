/**
 * What this device can actually run, decided before anything is offered.
 *
 * ── Why detection comes before the picker, not after the download ──
 *
 * The failure this exists to prevent is not a slow model. It is Safari killing
 * the tab when a page exceeds its memory allowance: uncatchable, unreportable,
 * and indistinguishable from the application crashing. A student on an iPad
 * would experience "I tried the AI thing and WeVolunteer broke".
 *
 * So the question "will this fit" is answered before a size is ever shown, and
 * a model that will not fit is not offered at all. Offering it with a warning
 * would be pushing an unrecoverable failure onto the person least able to
 * diagnose it.
 *
 * ── This is capability detection, not fingerprinting ──
 *
 * Everything below is read locally, used to pick a default, and never
 * transmitted. It is deliberately coarse — three tiers and a byte ceiling — and
 * the values are never combined into anything that would distinguish one device
 * from another. Nothing here reaches the server, the analytics SDK, or a log.
 * If a future change wants to send any of it anywhere, that is a privacy
 * decision and not a refactor.
 */

import { IOS_MAX_MODEL_BYTES, MODELS } from './models.js';

/**
 * iPadOS 13 and later identify as Macintosh, deliberately, to receive desktop
 * pages. The touch-point count is what separates a real Mac from an iPad
 * claiming to be one — a Mac reports 0 or 1, an iPad reports 5.
 *
 * Getting this wrong in the permissive direction is the expensive mistake: an
 * iPad treated as a Mac is offered a model that kills the tab.
 */
function detectIOS(nav) {
  const ua = nav.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Mac/.test(ua) && Number(nav.maxTouchPoints || 0) > 1;
}

/**
 * The recommended tier for a device whose memory we can and cannot see.
 *
 * `navigator.deviceMemory` is Chromium-only. Safari and Firefox report nothing,
 * which covers a large share of the users this has to serve, so "unknown" is a
 * normal case rather than an edge one and must not simply fall through to the
 * largest option.
 *
 * When memory is unknown the fallback leans on two weaker signals together —
 * a working WebGPU adapter and a healthy core count — and still stops at the
 * middle tier. A machine that can genuinely run the largest model is one
 * setting away from it; a machine that cannot is spared a download it will not
 * survive. The asymmetry is intentional: the cost of guessing low is a smaller
 * model, and the cost of guessing high is a dead tab.
 */
function recommendTier({ deviceMemoryGB, webgpu, cores }) {
  if (deviceMemoryGB != null) {
    if (deviceMemoryGB >= 8) return 'advanced';
    if (deviceMemoryGB >= 4) return 'balanced';
    return 'fast';
  }
  if (webgpu && cores >= 8) return 'balanced';
  return 'fast';
}


/**
 * Whether one model can be offered to this device, for conversation.
 *
 * The single predicate, used by both the capability check and the picker.
 * They used to apply different rules, and the gap had a real consequence: a
 * 2 GB machine passed `supported` on the byte ceiling and then got an empty
 * picker, because the memory floor was only applied in the second place. One
 * function means "supported" and "here are your options" cannot disagree.
 */
function fitsDevice(model, { maxBytes, deviceMemoryGB }) {
  /* Only models fit to speak to a student. The smallest is a capable
     extraction engine and a poor conversationalist, and is withheld here
     rather than deleted — see the note on its registry entry. */
  if (!model.conversational) return false;
  if (model.bytes > maxBytes) return false;
  /* Absence of evidence is not evidence of a small machine; the tier
     recommendation is already conservative when memory is unknown. */
  if (deviceMemoryGB == null) return true;
  return deviceMemoryGB >= model.minDeviceMemoryGB;
}

/**
 * Inspect the device.
 *
 * `nav` is injectable so the tiers can be tested across device profiles without
 * a browser; production callers pass nothing and get `navigator`.
 *
 * Returns:
 *   supported        can anything be offered at all
 *   reason           plain language, set only when something is being withheld
 *   recommendedTier  which model to preselect, or null when unsupported
 *   maxBytes         the hard ceiling; a model above it is never offered
 *   webgpu           whether inference will be accelerated
 *   isIOS            whether the ceiling above is the iOS one
 */
export function detectCapability(nav = typeof navigator !== 'undefined' ? navigator : null) {
  if (!nav || typeof WebAssembly !== 'object') {
    return {
      supported: false,
      reason: 'This browser cannot run WebAssembly, which the on-device assistant needs.',
      recommendedTier: null,
      maxBytes: 0,
      webgpu: false,
      isIOS: false,
      deviceMemoryGB: null,
    };
  }

  const isIOS = detectIOS(nav);
  const webgpu = Boolean(nav.gpu);
  const cores = Number(nav.hardwareConcurrency || 0);
  const deviceMemoryGB = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;

  const maxBytes = isIOS ? IOS_MAX_MODEL_BYTES : Number.POSITIVE_INFINITY;
  const fits = MODELS.filter(m => fitsDevice(m, { maxBytes, deviceMemoryGB }));

  if (fits.length === 0) {
    return {
      supported: false,
      /* Currently the iPhone and iPad answer: the only model under the iOS
         memory ceiling is the one withheld from conversation. Stated as a
         device limit because that is what it is from here. */
      reason: 'The assistant needs more memory than this device can give a web page, so it is not available here.',
      recommendedTier: null,
      maxBytes,
      webgpu,
      isIOS,
      deviceMemoryGB,
    };
  }

  /* Recommend a tier, then pull it back to something that actually fits. On
     iOS the ceiling does the deciding and the memory heuristic is advisory. */
  const wanted = recommendTier({ deviceMemoryGB, webgpu, cores });
  const recommendedTier = fits.some(m => m.tier === wanted) ? wanted : fits[0].tier;

  let reason = null;
  if (isIOS) {
    /**
     * Unreachable today, and kept rather than deleted.
     *
     * Reaching here needs `fits` to be non-empty, and on iOS it never is:
     * `fitsDevice` rejects a model that is not `conversational`, and the only
     * model under `IOS_MAX_MODEL_BYTES` (200 MB) is the 105 MB `fast` tier,
     * which is withheld from conversation. So every iPhone and iPad takes the
     * `fits.length === 0` return above instead, and is told the assistant is
     * not available here — not this sentence.
     *
     * Left in place because it is defensive rather than dead: raising the
     * ceiling, or adding a small conversational model, makes it both reachable
     * and correct on the same day. What is recorded here is that it does not
     * describe what an iOS reader sees today, so nobody concludes from reading
     * it that they are offered the Fast model.
     */
    reason =
      'On iPhone and iPad, Safari limits how much memory a page may use, so only '
      + 'the smallest model is offered here.';
  } else if (!webgpu) {
    reason =
      'This browser has no graphics acceleration available for AI, so responses '
      + 'will be slower.';
  }

  return { supported: true, reason, recommendedTier, maxBytes, webgpu, isIOS, deviceMemoryGB };
}

/**
 * The models this device may be shown, largest-fitting first excluded.
 *
 * Filtered on the byte ceiling AND on the model's own memory floor, because the
 * two catch different devices: the ceiling stops an iPad loading something that
 * kills the tab, and the floor stops a low-memory laptop being recommended
 * something that will thrash. A device that reports no memory is not excluded
 * by the floor — absence of evidence is not evidence of a small machine, and
 * the tier recommendation is already conservative in that case.
 */
export function offerableModels(capability) {
  if (!capability.supported) return [];
  return MODELS.filter(m => fitsDevice(m, {
    maxBytes: capability.maxBytes,
    deviceMemoryGB: capability.deviceMemoryGB,
  }));
}
