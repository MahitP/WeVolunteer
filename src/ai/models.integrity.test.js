import { describe, it, expect } from 'vitest';
import {
  MODELS,
  TIERS,
  MODEL_BASE_URL,
  IOS_MAX_MODEL_BYTES,
  SHA256_MAX_BYTES,
  modelById,
  modelForTier,
  modelUrl,
  isDigestVerified,
  formatBytes,
} from './models.js';

/**
 * The registry is the only place that says how large a download is and what it
 * should hash to. Both are read by a student deciding whether to spend their
 * bandwidth, and by the loader deciding whether to trust what came back — so
 * these are guard tests, not documentation. An entry that cannot state its own
 * size and digest must not be addable.
 */
describe('model registry integrity', () => {
  it('gives every model an exact byte count and a full SHA-256', () => {
    for (const m of MODELS) {
      expect(Number.isInteger(m.bytes), `${m.id} bytes`).toBe(true);
      expect(m.bytes, `${m.id} bytes`).toBeGreaterThan(0);

      /* 64 lower-case hex characters. A truncated or upper-cased digest would
         compare unequal at load time and reject a perfectly good file, which
         presents as a download that never succeeds. */
      expect(m.sha256, `${m.id} sha256`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('names a licence and a licence URL for every model', () => {
    /* Someone has to be able to check what they are running under, and a model
       whose terms nobody recorded cannot be offered to minors. */
    for (const m of MODELS) {
      expect(m.license, `${m.id} license`).toBeTruthy();
      expect(m.licenseUrl, `${m.id} licenseUrl`).toMatch(/^https:\/\//);
    }
  });

  it('uses unique ids, because the id is the cache key', () => {
    const ids = MODELS.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('fills every tier exactly once', () => {
    /* The picker renders one row per tier. Two models claiming a tier would
       render one and silently hide the other. */
    for (const tier of TIERS) {
      expect(MODELS.filter(m => m.tier === tier)).toHaveLength(1);
    }
    expect(MODELS).toHaveLength(TIERS.length);
  });

  it('keeps at least one model under the iOS ceiling', () => {
    /**
     * If this ever fails, iOS and iPadOS silently lose the feature entirely —
     * `detectCapability` returns unsupported and nobody on an iPhone is ever
     * offered anything. That may one day be the right call, but it should be a
     * decision somebody made rather than a consequence of swapping a model.
     */
    const fits = MODELS.filter(m => m.bytes <= IOS_MAX_MODEL_BYTES);
    expect(fits.length).toBeGreaterThan(0);
  });

  it('digest-verifies the small models and says so about the large ones', () => {
    /* The threshold exists because WebCrypto cannot hash incrementally. What
       matters is that the answer is derived from the size rather than asserted
       per model, so the UI and the policy cannot drift from the behaviour. */
    for (const m of MODELS) {
      expect(isDigestVerified(m)).toBe(m.bytes <= SHA256_MAX_BYTES);
    }
  });
});

describe('model lookup and URLs', () => {
  it('builds download URLs from the single configured origin', () => {
    for (const m of MODELS) {
      const url = modelUrl(m);
      expect(url.startsWith(`${MODEL_BASE_URL}/`)).toBe(true);
      expect(url).toContain(`/${m.repo}/resolve/main/`);
    }
  });

  it('returns null rather than throwing for an unknown id or tier', () => {
    /* Callers include a settings screen reading a stale localStorage value from
       a build where a model existed. That should render the picker, not crash
       the page. */
    expect(modelById('no-such-model')).toBeNull();
    expect(modelForTier('enormous')).toBeNull();
  });

  it('finds each model by id and by tier', () => {
    for (const m of MODELS) {
      expect(modelById(m.id)).toBe(m);
      expect(modelForTier(m.tier)).toBe(m);
    }
  });
});

describe('formatBytes', () => {
  it('reports binary megabytes below a gigabyte', () => {
    expect(formatBytes(105454144)).toBe('101 MB');
  });

  it('switches to gigabytes above 1024 MiB', () => {
    expect(formatBytes(986048768)).toBe('940 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });
});
