import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * No text field zooms the page on an iPhone.
 *
 * Safari on iOS zooms the whole page when a focused field's text is under
 * 16px, and leaves the reader to pinch back out. The stylesheet already knew:
 * the coarse-pointer block sets `.input`, `.select` and `.textarea` to 1rem,
 * "wherever a phone keyboard can open". But the fields students type in most
 * have classes of their own, and none was in that block. Trying Welly AI in
 * the iPhone Simulator on 2026-10-05, tapping the Welly composer (15px) zoomed
 * the page; measured at phone width, so did the message composer (15px) and
 * the Messages search (13px).
 *
 * So this reads the stylesheet: every rule that styles a text field below
 * 16px must be followed by a coarse-pointer rule that brings the same selector
 * back to at least 1rem. "Followed by", because both rules usually have one
 * class, and then the later one wins.
 *
 * Parsed, not rendered: jsdom has no media queries or layout, so a rendered
 * check would pass by measuring nothing (the reasoning `touchTargets.test.js`
 * gives). The browser check is done by hand at 375px with touch emulation.
 */

const CSS = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8')
  /* Comments become spaces of the same length, so positions stay true. */
  .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length));

/** A text field's selector, as opposed to a button's or a checkbox's. */
const TEXT_FIELD = /(^|[\s>+~])(input|textarea|select)\b|[.-](input|textarea)\b|\.select\b/;
const NOT_TEXT = /::?(placeholder|before|after|-webkit)|\[type=.?(checkbox|radio|range|file|color)/;

/**
 * Fields that are below 16px on purpose, each with the reason.
 * A new entry needs one too.
 */
const EXEMPT = {
  '.share-link-input': 'read-only: it opens no keyboard, so Safari does not zoom',
  '.demobar select': 'demo builds only, and widening it worsens the 320px overflow the revamp hand-over records',
};

/** Every rule, with where it starts and whether it sits in a coarse-pointer block. */
function rules() {
  const media = [];
  const mediaOpen = /@media[^{]*\{/g;
  for (let m = mediaOpen.exec(CSS); m; m = mediaOpen.exec(CSS)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < CSS.length && depth > 0; i++) {
      if (CSS[i] === '{') depth++;
      else if (CSS[i] === '}') depth--;
    }
    media.push({ start: m.index, end: i, coarse: /pointer:\s*coarse/.test(m[0]) });
  }

  const out = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = rule.exec(CSS); m; m = rule.exec(CSS)) {
    const selectors = m[1].split(',').map(s => s.trim()).filter(s => s && !s.startsWith('@'));
    const size = m[2].match(/font-size\s*:\s*([0-9.]+)(rem|px|em)\b/);
    if (!size || selectors.length === 0) continue;
    const px = size[2] === 'px' ? Number(size[1]) : Number(size[1]) * 16;
    const coarse = media.some(b => b.coarse && m.index > b.start && m.index < b.end);
    out.push({ selectors, px, at: m.index, coarse });
  }
  return out;
}

/** The field a selector styles, ignoring an ancestor added only for weight. */
const field = selector => selector.split(/\s+/).slice(-1)[0];
const sameField = (a, b) => a === b || (field(a) === field(b) && field(a).startsWith('.'));

describe('text fields on a phone', () => {
  const all = rules();

  it('finds the fields it is meant to check', () => {
    const small = all.flatMap(r => r.selectors.filter(s => TEXT_FIELD.test(s) && r.px < 16));
    expect(small).toEqual(expect.arrayContaining(['.input', '.welly-textarea', '.composer-input', '.search-bar input']));
  });

  it('brings every text field to 16px for a touch screen', () => {
    const missing = [];
    for (const r of all.filter(x => !x.coarse && x.px < 16)) {
      for (const selector of r.selectors.filter(s => TEXT_FIELD.test(s) && !NOT_TEXT.test(s))) {
        if (EXEMPT[selector]) continue;
        const floor = all.find(x => x.coarse && x.px >= 16 && x.at > r.at
          && x.selectors.some(s => sameField(s, selector)));
        if (!floor) missing.push(`${selector} (${r.px}px)`);
      }
    }
    expect(missing, 'below 16px on a phone, so Safari zooms the page when it is tapped').toEqual([]);
  });
});
