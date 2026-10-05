import { describe, it, expect } from 'vitest';
import { detectCapability, offerableModels } from './capability.js';
import { IOS_MAX_MODEL_BYTES, IOS_EXPERIMENTAL_MAX_BYTES, MODELS } from './models.js';

/** A stand-in for `navigator`, so device profiles can be tested without one. */
function nav({ ua = 'Mozilla/5.0 (X11; Linux x86_64)', touch = 0, gpu = false, memory, cores = 4 } = {}) {
  const n = { userAgent: ua, maxTouchPoints: touch, hardwareConcurrency: cores };
  if (gpu) n.gpu = {};
  if (memory !== undefined) n.deviceMemory = memory;
  return n;
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
const IPADOS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome';

describe('iOS detection', () => {
  it('recognises an iPhone by user agent', () => {
    expect(detectCapability(nav({ ua: IPHONE, touch: 5 })).isIOS).toBe(true);
  });

  it('recognises an iPad that is claiming to be a Mac', () => {
    /**
     * The case this function exists for. iPadOS 13+ reports a Macintosh user
     * agent on purpose, so user-agent matching alone reads an iPad as a desktop
     * and offers it a model that will kill the tab. Touch points are what
     * separate them.
     */
    const cap = detectCapability(nav({ ua: IPADOS, touch: 5 }));
    expect(cap.isIOS).toBe(true);
    expect(cap.experimental).toBe(true);
  });

  it('does not mistake a real Mac for an iPad', () => {
    /* The mirror of the above, and the reason the touch check is `> 1` rather
       than `> 0`: a Mac with a touch-capable peripheral still reports 0 or 1. */
    expect(detectCapability(nav({ ua: MAC, touch: 0, memory: 16 })).isIOS).toBe(false);
    expect(detectCapability(nav({ ua: MAC, touch: 1, memory: 16 })).isIOS).toBe(false);
  });
});

describe('what iOS is offered', () => {
  /**
   * The Balanced model, as an experiment the student opts into (ruling 7).
   *
   * The only model under the iOS memory ceiling is SmolLM2-135M, and it was
   * withdrawn from conversation after it answered a student who had zero hours
   * by repeating its own instructions back. So iPhone and iPad got nothing at
   * all — for a phone-first student app, the largest gap in the feature (A13).
   *
   * The 200 MB ceiling that rules Balanced out was "derived from reported
   * failures rather than measured on hardware". The owner ruled: offer Balanced
   * on these devices behind a clear "experimental on this device" warning. The
   * ceiling stays as the size known to be safe; Advanced, at nearly a gigabyte,
   * is still not offered.
   */
  it('offers the Balanced model, marked experimental, and says why', () => {
    const cap = detectCapability(nav({ ua: IPHONE, touch: 5, memory: 8, cores: 8, gpu: true }));

    expect(cap.supported).toBe(true);
    expect(cap.experimental).toBe(true);
    expect(cap.recommendedTier).toBe('balanced');
    expect(cap.reason).toMatch(/experimental/i);
    expect(offerableModels(cap).map(m => m.tier)).toEqual(['balanced']);
  });

  it('never offers the Advanced model on iOS', () => {
    const cap = detectCapability(nav({ ua: IPHONE, touch: 5 }));
    expect(offerableModels(cap).some(m => m.tier === 'advanced')).toBe(false);
    expect(cap.maxBytes).toBe(IOS_EXPERIMENTAL_MAX_BYTES);
    expect(IOS_EXPERIMENTAL_MAX_BYTES).toBeGreaterThan(IOS_MAX_MODEL_BYTES);
  });

  it('is not experimental anywhere else', () => {
    expect(detectCapability(nav({ ua: MAC, touch: 0, memory: 16, gpu: true })).experimental).toBe(false);
  });
});

describe('tier recommendation on desktop', () => {
  it('scales with reported device memory', () => {
    expect(detectCapability(nav({ memory: 16, gpu: true })).recommendedTier).toBe('advanced');
    expect(detectCapability(nav({ memory: 8, gpu: true })).recommendedTier).toBe('advanced');
    expect(detectCapability(nav({ memory: 4, gpu: true })).recommendedTier).toBe('balanced');
  });

  it('offers nothing to a device under the smallest conversational floor', () => {
    /**
     * The second cost of withdrawing the 135M model. The smallest remaining
     * conversational model needs 4 GB, so a 2 GB machine — a low-end Chromebook,
     * say — is now told the assistant is unavailable rather than being given
     * one that will thrash or speak badly.
     */
    const cap = detectCapability(nav({ memory: 2, gpu: true }));
    expect(cap.supported).toBe(false);
    expect(offerableModels(cap)).toEqual([]);
  });

  it('stops at the middle tier when memory is unreported', () => {
    /**
     * `navigator.deviceMemory` is Chromium-only, so Safari and Firefox land
     * here — a large share of users, not an edge case. Guessing high costs a
     * dead tab; guessing low costs a smaller model. It guesses low.
     */
    const cap = detectCapability(nav({ ua: MAC, gpu: true, cores: 16 }));
    expect(cap.deviceMemoryGB).toBeNull();
    expect(cap.recommendedTier).toBe('balanced');
  });

  it('falls to the smallest OFFERABLE tier when there is neither memory nor a GPU', () => {
    /* The heuristic still says "fast"; the picker no longer has one, so the
       recommendation lands on the smallest model that may actually be shown. */
    expect(detectCapability(nav({ gpu: false, cores: 16 })).recommendedTier).toBe('balanced');
    expect(detectCapability(nav({ gpu: true, cores: 2 })).recommendedTier).toBe('balanced');
  });

  it('warns when there is no graphics acceleration, without refusing', () => {
    const cap = detectCapability(nav({ memory: 16, gpu: false }));
    expect(cap.supported).toBe(true);
    expect(cap.webgpu).toBe(false);
    expect(cap.reason).toMatch(/slower/);
  });

  it('says nothing when there is nothing to warn about', () => {
    expect(detectCapability(nav({ memory: 16, gpu: true })).reason).toBeNull();
  });
});

describe('offerableModels', () => {
  it('excludes models whose memory floor the device is under', () => {
    const cap = detectCapability(nav({ memory: 4, gpu: true }));
    const offered = offerableModels(cap);

    expect(offered.some(m => m.tier === 'advanced')).toBe(false);
    expect(offered.some(m => m.tier === 'balanced')).toBe(true);
  });

  it('does not apply the memory floor when memory is unknown', () => {
    /* Absence of evidence is not evidence of a small machine. The conservative
       tier recommendation already covers this case; excluding models outright
       would hide the largest option from every Safari and Firefox user. */
    const offered = offerableModels(detectCapability(nav({ ua: MAC, gpu: true, cores: 16 })));
    expect(offered).toHaveLength(MODELS.filter(m => m.conversational).length);
    expect(offered.every(m => m.conversational)).toBe(true);
  });

  it('returns nothing when the device is unsupported', () => {
    expect(offerableModels({ supported: false })).toEqual([]);
  });
});

describe('unsupported environments', () => {
  it('reports unsupported rather than throwing when there is no navigator', () => {
    const cap = detectCapability(null);
    expect(cap.supported).toBe(false);
    expect(cap.recommendedTier).toBeNull();
    expect(cap.maxBytes).toBe(0);
    expect(cap.reason).toMatch(/WebAssembly/);
  });
});

/**
 * A browser that cannot compile the default engine runs the compatibility one.
 *
 * Found in the iPhone Simulator on 2026-10-05: Safari accepted the 469 MB
 * download, then hung on "Thinking" for good. The default engine is 64-bit
 * WebAssembly (Memory64), and Safari cannot compile it while passing the check
 * wllama itself makes. `WllamaRuntime` now runs wllama's compatibility engine
 * there, self-hosted; it answered in the Simulator, more slowly. So such a
 * browser is still offered the models, and told what to expect.
 */
describe('a browser without Memory64', () => {
  it('is offered the models, marked as using the slower engine, and told so', () => {
    const cap = detectCapability(nav({ ua: MAC, memory: 16 }), { memory64: false });
    expect(cap.supported).toBe(true);
    expect(cap.compat).toBe(true);
    expect(offerableModels(cap).length).toBeGreaterThan(0);
    expect(cap.reason).toMatch(/slower/i);
  });

  it('on an iPhone, is still ruling 7\'s experiment, warning included', () => {
    const cap = detectCapability(nav({ ua: IPHONE, touch: 5 }), { memory64: false });
    expect(cap.supported).toBe(true);
    expect(cap.experimental).toBe(true);
    expect(cap.reason).toMatch(/experimental/i);
  });

  it('is decided by compiling a 64-bit module, which this Node can, so it uses the default engine', () => {
    /* Not the JavaScript-API probe wllama uses: that one passes in the Safari
       that then fails to compile. */
    expect(detectCapability(nav({ ua: MAC, memory: 16 })).compat).toBe(false);
  });
});
