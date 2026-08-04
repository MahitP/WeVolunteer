/**
 * The copy contract.
 *
 * Tone is the thing most likely to drift as themes are added — it is a taste
 * judgement made by whoever writes the next block of strings, at the moment
 * they are enjoying writing it. These assertions turn the two rules that
 * actually matter into build failures.
 */
import { describe, it, expect } from 'vitest';
import { COPY, copyFor } from './errorCopy';
import { THEMES } from './themes/index.js';
import { SERIOUS, REASSURANCE, KINDS } from './kinds';

const PAIRS = THEMES.flatMap((t) => Object.keys(t.modes).map((kind) => [t.id, kind]));

describe('every eligible pair has real copy', () => {
  it.each(PAIRS)('%s / %s', (theme, kind) => {
    const c = COPY[theme]?.[kind];
    expect(c, `${theme}/${kind} has no copy`).toBeTruthy();
    for (const field of ['eyebrow', 'title', 'body']) {
      expect(typeof c[field], `${theme}/${kind}.${field}`).toBe('string');
      expect(c[field].trim().length, `${theme}/${kind}.${field} is empty`).toBeGreaterThan(3);
    }
  });

  it('has no copy for a pair the registry does not allow', () => {
    // Dead copy is a signal the registry and the strings have drifted apart.
    const allowed = new Set(PAIRS.map(([t, k]) => `${t}/${k}`));
    const orphans = [];
    for (const [theme, kinds] of Object.entries(COPY)) {
      for (const kind of Object.keys(kinds)) {
        if (!allowed.has(`${theme}/${kind}`)) orphans.push(`${theme}/${kind}`);
      }
    }
    expect(orphans, 'copy for a theme/kind the registry will never render').toEqual([]);
  });
});

describe('the tone ladder', () => {
  const seriousPairs = PAIRS.filter(([, kind]) => SERIOUS.includes(kind));

  it('covers at least one theme for every serious kind', () => {
    for (const kind of SERIOUS) {
      expect(
        seriousPairs.filter(([, k]) => k === kind).length,
        `${kind} is unreachable`
      ).toBeGreaterThan(0);
    }
  });

  /**
   * "Did I just lose my hours?" is the actual question when a page dies
   * mid-signup, and it outranks explaining what broke.
   */
  it.each(seriousPairs)('%s / %s answers the data question', (theme, kind) => {
    expect(COPY[theme][kind].body).toMatch(REASSURANCE);
  });

  /**
   * A joke told to somebody who may have just lost work reads as not
   * understanding what happened to them. The exclamation mark is the cheapest
   * detectable proxy for reaching for one.
   */
  it.each(seriousPairs)('%s / %s stays flat', (theme, kind) => {
    const { eyebrow, title, body } = COPY[theme][kind];
    for (const [field, text] of Object.entries({ eyebrow, title, body })) {
      expect(text, `${theme}/${kind}.${field} is exclaiming`).not.toMatch(/!/);
    }
  });
});

describe('the copy is not generic', () => {
  const banned = [
    /page not found/i,
    /access denied/i,
    /something went wrong/i,
    /\boops\b/i,
    /\bunknown error\b/i,
    /\berror \d{3}\b/i,
  ];

  it.each(PAIRS)('%s / %s avoids the stock phrases', (theme, kind) => {
    const { eyebrow, title, body } = COPY[theme][kind];
    const all = `${eyebrow} ${title} ${body}`;
    for (const pattern of banned) {
      expect(all, `${theme}/${kind} uses ${pattern}`).not.toMatch(pattern);
    }
  });

  it.each(PAIRS)('%s / %s prints no raw status code', (theme, kind) => {
    const { eyebrow, title, body } = COPY[theme][kind];
    expect(`${eyebrow} ${title} ${body}`).not.toMatch(/\b(404|403|500|503)\b/);
  });

  /**
   * Rotation is only worth having if the screens are actually different. Two
   * themes sharing a headline is the exact failure this system is designed to
   * avoid — one design wearing six hats.
   */
  it('gives no two pairs the same headline', () => {
    const titles = PAIRS.map(([t, k]) => COPY[t][k].title);
    const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
    expect([...new Set(dupes)], 'duplicated headlines').toEqual([]);
  });
});

describe('copyFor', () => {
  it('returns the theme’s own words when it has them', () => {
    expect(copyFor('fair', '404')).toBe(COPY.fair[404]);
  });

  it('falls back to the board when a theme is forced past its eligibility', () => {
    expect(copyFor('fair', '500')).toBe(COPY.board[500]);
  });

  it('still returns something for a kind nothing covers', () => {
    expect(copyFor('nope', 'not-a-kind').title.length).toBeGreaterThan(0);
  });

  it('resolves for every registered kind', () => {
    for (const kind of KINDS) {
      expect(copyFor('board', kind), kind).toBeTruthy();
    }
  });
});
