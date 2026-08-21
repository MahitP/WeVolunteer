import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { navSectionsFor } from './App.jsx';

/**
 * Every primary destination fits on the phone, for every role.
 *
 * ── The property, and why it needed writing down ──
 *
 * The mobile bar is a horizontally scrolling strip with a pinned `⋯`, and the
 * scroller is the OVERFLOW mechanism rather than the normal state: the design
 * note in `App.jsx` says five entries fit on any current phone and six or seven
 * scroll. That was true when five was the maximum, held only by an owner.
 *
 * Welly moved the baseline. Five primary destinations is now what a student,
 * an organizer and an administrator each get, and an owner has six — so the
 * case the stylesheet was tuned for is the case everybody is in, and the
 * arithmetic had exactly zero slack at 375px:
 *
 *     375px − 3.25rem (the pinned ⋯) = 323px, and 5 × 4rem = 320px
 *
 * At 360px and 320px it did not fit at all, and the reader had to discover a
 * sideways swipe to reach the fifth destination. The `min-width` floor now
 * steps down below 380px and below 340px, and this test is what stops the next
 * nav entry — or a change to those steps — silently pushing a destination off
 * the screen again.
 *
 * ── Why the stylesheet is the thing asserted ──
 *
 * jsdom performs no layout, so nothing rendered can be measured here. What
 * broke is arithmetic between two numbers in the stylesheet and one number in
 * the nav table, and all three can be read.
 */

const CSS = readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');
const ROOT_FONT_PX = 16;

/**
 * Every `@media (max-width: N)` block in the file, in source order, with any
 * blocks nested inside it removed from its body.
 *
 * The nesting matters: the whole mobile bar lives inside one
 * `@media (max-width: 700px)`, and the narrow step-downs are written inside
 * that. A scan of the 700px body that did not strip its children would find the
 * 320px declaration while asking about 360px, and report the narrowest floor at
 * every width.
 */
function mediaBlocks() {
  const found = [];
  const re = /@media \(max-width: (\d+)px\) \{/g;
  let m;
  while ((m = re.exec(CSS)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const bodyStart = i + 1;
    do {
      if (CSS[i] === '{') depth += 1;
      else if (CSS[i] === '}') depth -= 1;
      i += 1;
    } while (depth > 0 && i < CSS.length);
    found.push({ limit: Number(m[1]), start: m.index, end: i, bodyStart, bodyEnd: i - 1 });
  }

  /* Each block's own declarations: its body with the full extent of any block
     nested inside it cut out. Done by position rather than by a regex, because
     a regex for "a brace-balanced block" backtracks into the rules that follow
     and quietly removes them too. */
  return found.map(block => {
    const children = found.filter(o => o !== block && o.start > block.bodyStart && o.end <= block.bodyEnd);
    let body = '';
    let cursor = block.bodyStart;
    for (const child of children.sort((a, b) => a.start - b.start)) {
      if (child.start < cursor) continue;
      body += CSS.slice(cursor, child.start);
      cursor = child.end;
    }
    body += CSS.slice(cursor, block.bodyEnd);
    return { limit: block.limit, body };
  });
}

const MEDIA = mediaBlocks();

/**
 * The last `prop` declared for `.selector` in `body`, in pixels.
 *
 * Comments come out first. A declaration preceded by a block comment is
 * preceded by `/` rather than by `;`, and this repository comments heavily
 * inside rules — the base `.mobilenav-item` floor sits directly under a
 * fourteen-line note, so a scan anchored on the separator found every
 * one-line override and missed the declaration they override.
 */
function declaredPx(selector, prop, body) {
  const plain = body.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = new RegExp(`\\.${selector}\\s*\\{([^{}]*)\\}`, 'g');
  let value = null;
  let match;
  while ((match = rule.exec(plain)) !== null) {
    const decl = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([0-9.]+)(rem|px)`).exec(match[1]);
    if (decl) value = decl[2] === 'rem' ? Number(decl[1]) * ROOT_FONT_PX : Number(decl[1]);
  }
  return value;
}

/**
 * The floor one control resolves to at `viewport`.
 *
 * Every block whose `max-width` still covers the viewport applies, and the last
 * one in SOURCE order wins — a media query adds no specificity, so the cascade
 * is decided by position in the file and not by how narrow the query is.
 */
function itemWidthAt(viewport, selector) {
  let width = null;
  for (const { limit, body } of MEDIA) {
    if (limit < viewport) continue;
    const declared = declaredPx(selector, 'min-width', body);
    if (declared !== null) width = declared;
  }
  return width;
}

const ROLES = [
  ['student', { id: 's', role: 'student', withheld: [], verified: true }],
  ['organizer', { id: 'o', role: 'organizer', withheld: [], verified: true }],
  ['admin', { id: 'a', role: 'admin', withheld: [], verified: true }],
  ['super_admin', { id: 'x', role: 'super_admin', withheld: [], verified: true }],
];

/* The widths this has to work on: iPhone SE (1st gen) through to a large
   Android. 375 and 390 are the two commonest in the wild. */
const PHONE_WIDTHS = [320, 360, 375, 390, 414];

describe('the mobile bar is sized for the destinations that exist', () => {
  it('declares a floor that steps down on narrow phones', () => {
    /* Three steps, and each narrower than the last. A single flat floor is the
       shape that could not fit five entries at 360px. */
    /* 700 is where the bar exists at all — the whole block is inside
       `@media (max-width: 700px)`. */
    const wide = itemWidthAt(700, 'mobilenav-item');
    const mid = itemWidthAt(360, 'mobilenav-item');
    const narrow = itemWidthAt(320, 'mobilenav-item');

    expect(wide, 'no min-width declared for .mobilenav-item').not.toBeNull();
    expect(mid).toBeLessThan(wide);
    expect(narrow).toBeLessThan(mid);
  });

  for (const [name, user] of ROLES) {
    const primary = navSectionsFor(user).primary;

    it(`gives ${name} ${primary.length} primary destinations`, () => {
      /* Named so a change to the nav table shows up here as a number rather
         than as an arithmetic failure three assertions later. */
      expect(primary.length).toBeGreaterThan(0);
      expect(primary.length).toBeLessThanOrEqual(6);
    });

    for (const viewport of PHONE_WIDTHS) {
      const count = primary.length;
      /* An owner's sixth entry is the one case that is allowed to scroll — the
         strip exists for it, and `data-overflow` puts a fade on the edge that
         has something behind it. Everybody else must fit outright. */
      if (count > 5) continue;

      it(`fits ${name}'s ${count} destinations at ${viewport}px`, () => {
        const item = itemWidthAt(viewport, 'mobilenav-item');
        const more = itemWidthAt(viewport, 'mobilenav-more');
        expect(item, 'no item floor resolved').not.toBeNull();
        expect(more, 'no ⋯ floor resolved').not.toBeNull();

        const needed = count * item + more;
        expect(
          needed,
          `${count} items at ${item}px plus the ⋯ at ${more}px needs ${needed}px, `
          + `which does not fit in ${viewport}px — a destination would sit off-screen`,
        ).toBeLessThanOrEqual(viewport);
      });
    }
  }
});

describe('the overflow cue is driven by measurement, not by a guess', () => {
  it('keys the fade on the measured state rather than on a width', () => {
    /* The fade was `@media (max-width: 360px)`, which is a guess about when the
       strip overflows. With five entries normal and six for an owner the guess
       is wrong in both directions — a 390px phone can overflow and get no cue,
       a 340px one shows four entries and gets a fade over nothing. */
    expect(CSS).toContain(".mobilenav-scroll[data-overflow='end']");
    expect(CSS).toContain(".mobilenav-scroll[data-overflow='start']");
    expect(CSS).toContain(".mobilenav-scroll[data-overflow='both']");

    const guessed = /@media \(max-width: 360px\) \{\s*\.mobilenav-scroll \{/.test(CSS);
    expect(guessed, 'the width-guessed fade is back').toBe(false);
  });

  it('keeps the ⋯ outside the scroller so it cannot scroll away', () => {
    /* It is how you reach what you cannot see, so it must never be the thing
       you cannot see. */
    /* The rule that positions it, which is the multi-line one — the narrow
       override declares only a width. */
    const bodies = [...CSS.matchAll(/\.mobilenav-more \{([^{}]*)\}/g)].map(m => m[1]);
    expect(bodies.length, '.mobilenav-more rule not found').toBeGreaterThan(0);
    expect(bodies.some(b => /flex:\s*0 0 auto/.test(b))).toBe(true);
  });

  it('keeps every destination a real touch target', () => {
    const item = /\.mobilenav-item \{([^{}]*)\}/.exec(CSS);
    expect(item, '.mobilenav-item rule not found').not.toBeNull();
    const height = /min-height:\s*(\d+)px/.exec(item[1]);
    expect(height, 'no min-height on .mobilenav-item').not.toBeNull();
    expect(Number(height[1])).toBeGreaterThanOrEqual(44);
  });
});
