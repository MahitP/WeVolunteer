import { describe, it, expect } from 'vitest';
import { detectCapability, offerableModels } from './capability.js';
import { IOS_MAX_MODEL_BYTES, MODELS } from './models.js';

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
    expect(cap.maxBytes).toBe(IOS_MAX_MODEL_BYTES);
  });

  it('does not mistake a real Mac for an iPad', () => {
    /* The mirror of the above, and the reason the touch check is `> 1` rather
       than `> 0`: a Mac with a touch-capable peripheral still reports 0 or 1. */
    expect(detectCapability(nav({ ua: MAC, touch: 0, memory: 16 })).isIOS).toBe(false);
    expect(detectCapability(nav({ ua: MAC, touch: 1, memory: 16 })).isIOS).toBe(false);
  });
});

describe('what iOS is offered', () => {
  it('caps at the iOS ceiling and recommends the smallest model', () => {
    const cap = detectCapability(nav({ ua: IPHONE, touch: 5, memory: 8, cores: 8, gpu: true }));

    /* Reported memory and a working GPU would otherwise earn the largest tier.
       On iOS the ceiling overrides both, because the constraint is Safari's
       per-tab allowance rather than the hardware. */
    expect(cap.maxBytes).toBe(IOS_MAX_MODEL_BYTES);
    expect(cap.recommendedTier).toBe('fast');
    expect(cap.reason).toMatch(/iPhone and iPad/);
  });

  it('offers only models that fit under the ceiling', () => {
    const cap = detectCapability(nav({ ua: IPHONE, touch: 5 }));
    const offered = offerableModels(cap);

    expect(offered.length).toBeGreaterThan(0);
    for (const m of offered) expect(m.bytes).toBeLessThanOrEqual(IOS_MAX_MODEL_BYTES);
    expect(offered.length).toBeLessThan(MODELS.length);
  });
});

describe('tier recommendation on desktop', () => {
  it('scales with reported device memory', () => {
    expect(detectCapability(nav({ memory: 16, gpu: true })).recommendedTier).toBe('advanced');
    expect(detectCapability(nav({ memory: 8, gpu: true })).recommendedTier).toBe('advanced');
    expect(detectCapability(nav({ memory: 4, gpu: true })).recommendedTier).toBe('balanced');
    expect(detectCapability(nav({ memory: 2, gpu: true })).recommendedTier).toBe('fast');
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

  it('falls to the smallest tier when there is neither memory nor a GPU', () => {
    expect(detectCapability(nav({ gpu: false, cores: 16 })).recommendedTier).toBe('fast');
    expect(detectCapability(nav({ gpu: true, cores: 2 })).recommendedTier).toBe('fast');
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
    expect(offered).toHaveLength(MODELS.length);
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
