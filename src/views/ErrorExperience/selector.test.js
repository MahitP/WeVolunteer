/**
 * The rotation selector.
 *
 * Two different claims live here and they fail for different reasons, so they
 * are tested separately: `themeForSeed` is the CHOOSING rule (pure, total), and
 * `getSeed` is the STORAGE rule (stateful, and the part that has to survive a
 * browser refusing to cooperate).
 *
 * ── The mutation tests ──
 *
 * A selector is unusually easy to test vacuously. `expect(theme).toBeTruthy()`
 * passes for a selector that always returns the board, always returns index 0,
 * or ignores the seed entirely — every one of which destroys the feature while
 * leaving a green suite. The block at the bottom pins the specific mutations
 * that would otherwise slip through.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { themeForSeed, getSeed, selectTheme, modeFor, resetSeed, SEED_KEY } from './selector';
import { THEMES, THEME_IDS, FALLBACK_THEME_ID, themesForKind } from './themes/index.js';
import { KINDS } from './kinds';

beforeEach(() => {
  sessionStorage.clear();
  resetSeed();
});
afterEach(() => vi.restoreAllMocks());

describe('the choosing rule', () => {
  it('returns a real theme for every kind, across a wide span of seeds', () => {
    for (const kind of KINDS) {
      for (let seed = 0; seed < 200; seed++) {
        const theme = themeForSeed(kind, seed);
        expect(THEME_IDS, `${kind} @ ${seed}`).toContain(theme.id);
      }
    }
  });

  it('only ever returns a theme that is eligible for the kind', () => {
    for (const kind of KINDS) {
      for (let seed = 0; seed < 200; seed++) {
        const theme = themeForSeed(kind, seed);
        expect(
          Object.keys(theme.modes),
          `${theme.id} is not honest about ${kind}`
        ).toContain(kind);
      }
    }
  });

  it('is deterministic: the same seed and kind always give the same theme', () => {
    for (const kind of KINDS) {
      const once = themeForSeed(kind, 12345);
      for (let i = 0; i < 5; i++) {
        expect(themeForSeed(kind, 12345).id).toBe(once.id);
      }
    }
  });

  it('keeps one seed on one theme across the kinds that theme covers', () => {
    // The point of storing a seed rather than a name: a session that meets two
    // failures should feel like one product, not two.
    const seed = 4;
    const chosen = new Set();
    for (const kind of KINDS) chosen.add(themeForSeed(kind, seed).id);
    // Not all one theme (eligibility forbids it), but far fewer than one each.
    expect(chosen.size).toBeLessThan(KINDS.length);
  });

  it('survives a hostile seed rather than throwing on the error page', () => {
    for (const bad of [-1, 1.5, NaN, Infinity, undefined, null, '7', {}]) {
      const theme = themeForSeed('404', bad);
      expect(THEME_IDS, `seed ${String(bad)}`).toContain(theme.id);
    }
  });

  it('falls back to the board for a kind no theme claims', () => {
    expect(themeForSeed('not-a-kind', 3).id).toBe(FALLBACK_THEME_ID);
  });
});

describe('the storage rule', () => {
  it('mints a seed once and reuses it for the rest of the session', () => {
    const first = getSeed();
    expect(sessionStorage.getItem(SEED_KEY)).toBe(String(first));
    for (let i = 0; i < 5; i++) expect(getSeed()).toBe(first);
  });

  it('honours a seed already in storage rather than reseeding', () => {
    sessionStorage.setItem(SEED_KEY, '99');
    expect(getSeed()).toBe(99);
  });

  it.each([['half-written', '12abc'], ['empty', ''], ['negative', '-3'], ['float', '2.5'], ['junk', '{}']])(
    're-mints a %s stored value instead of coercing it',
    (_label, stored) => {
      sessionStorage.setItem(SEED_KEY, stored);
      const seed = getSeed();
      // `Number('12abc') % 3` is NaN, and NaN indexes an array as `undefined` —
      // which would crash the page whose entire job is to survive a failure.
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(THEME_IDS).toContain(themeForSeed('404', seed).id);
    }
  );

  it('stays stable for the document when storage throws', () => {
    // Safari in private mode; also an embedded webview with storage denied.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied');
    });

    const first = getSeed();
    expect(Number.isInteger(first)).toBe(true);
    // The whole guarantee: a fresh random number per call would reshuffle the
    // theme on every re-render.
    for (let i = 0; i < 5; i++) expect(getSeed()).toBe(first);
  });

  it('selectTheme agrees with themeForSeed on the stored seed', () => {
    sessionStorage.setItem(SEED_KEY, '17');
    for (const kind of KINDS) {
      expect(selectTheme(kind).id).toBe(themeForSeed(kind, 17).id);
    }
  });
});

describe('modes', () => {
  it('gives every eligible theme/kind pair a real mode', () => {
    for (const theme of THEMES) {
      for (const kind of Object.keys(theme.modes)) {
        expect(typeof modeFor(theme, kind), `${theme.id}/${kind}`).toBe('string');
      }
    }
  });

  it('still returns a mode when a theme is forced onto a kind it does not claim', () => {
    const fair = THEMES.find((t) => t.id === 'fair');
    expect(typeof modeFor(fair, 'offline')).toBe('string');
  });
});

describe('the registry itself', () => {
  it('gives every kind at least one honest theme', () => {
    for (const kind of KINDS) {
      expect(themesForKind(kind).map((t) => t.id), `${kind} has no theme`).not.toEqual([]);
    }
  });

  it('has a fallback theme that really exists and covers the most kinds', () => {
    const fallback = THEMES.find((t) => t.id === FALLBACK_THEME_ID);
    expect(fallback).toBeTruthy();
    for (const theme of THEMES) {
      expect(Object.keys(fallback.modes).length).toBeGreaterThanOrEqual(
        Object.keys(theme.modes).length
      );
    }
  });

  it('has unique ids', () => {
    expect(new Set(THEME_IDS).size).toBe(THEME_IDS.length);
  });

  /**
   * No theme may draw the same picture for two different failures.
   *
   * The count said six themes and twenty screens; the contact sheet said
   * otherwise. `board` claimed six kinds and had three pictures — `500`,
   * `crash`, `chunk` and `maintenance` were all mode `rebuild`, so four of its
   * cards were pixel-identical and the only thing separating them was the
   * headline. `radio` and `ops` had the same problem at smaller scale.
   *
   * That is the failure this whole system was built to avoid, arriving through
   * the back door: not six designs wearing one hat, but one design claiming to
   * be four screens. Breadth of rotation is worth nothing if the pictures
   * repeat, so the mode table is where it gets enforced.
   */
  it('gives every kind a theme claims its own picture', () => {
    for (const theme of THEMES) {
      const modes = Object.values(theme.modes);
      const repeated = modes.filter((m, i) => modes.indexOf(m) !== i);
      expect(
        [...new Set(repeated)],
        `${theme.id} draws the same scene for more than one kind`
      ).toEqual([]);
    }
  });
});

/**
 * ── Mutation tests ──
 *
 * Each of these fails against a specific broken selector that the assertions
 * above would happily accept.
 */
describe('the selector cannot be quietly gutted', () => {
  it('actually uses the seed — a constant selector fails here', () => {
    // Kinds with more than one eligible theme must produce more than one
    // answer across seeds. Catches `return eligible[0]` and `return board`.
    for (const kind of KINDS) {
      const eligible = themesForKind(kind);
      if (eligible.length < 2) continue;

      const seen = new Set();
      for (let seed = 0; seed < 40; seed++) seen.add(themeForSeed(kind, seed).id);
      expect(seen.size, `${kind} never varies — the seed is being ignored`).toBeGreaterThan(1);
    }
  });

  it('reaches every eligible theme, not just the first two', () => {
    // Catches `seed % 2`, and a registry entry that can never be selected.
    for (const kind of KINDS) {
      const eligible = themesForKind(kind).map((t) => t.id);
      const seen = new Set();
      for (let seed = 0; seed < 500; seed++) seen.add(themeForSeed(kind, seed).id);
      expect([...seen].sort(), `${kind} cannot reach all of its themes`).toEqual(
        [...eligible].sort()
      );
    }
  });

  it('spreads roughly evenly, so no theme is effectively unreachable', () => {
    // Catches a bucketing bug that technically reaches every theme but gives
    // one of them a handful of seeds out of thousands.
    for (const kind of KINDS) {
      const eligible = themesForKind(kind);
      if (eligible.length < 2) continue;

      const counts = new Map();
      const N = 3000;
      for (let seed = 0; seed < N; seed++) {
        const id = themeForSeed(kind, seed).id;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const expected = N / eligible.length;
      for (const [id, n] of counts) {
        expect(n, `${kind}/${id} is skewed`).toBeGreaterThan(expected * 0.7);
      }
    }
  });

  it('mints seeds across the space rather than returning a constant', () => {
    // Catches `mintSeed = () => 0`, which would make every visitor in the world
    // see the same theme while every other test stayed green.
    const seeds = new Set();
    for (let i = 0; i < 60; i++) {
      sessionStorage.clear();
      resetSeed();
      seeds.add(getSeed());
    }
    expect(seeds.size, 'minted seeds barely vary').toBeGreaterThan(20);
  });
});
