/**
 * Layout facts jsdom cannot produce.
 *
 * Every existing accessibility guard in this repo reads source text, and
 * src/touchTargets.test.js explains why: getBoundingClientRect is zero in jsdom,
 * so a rendered assertion there is vacuous in exactly the way that looks
 * convincing. This module is the other half.
 */

/** The selector for "things a keyboard or pointer can operate". */
export const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea,'
  + ' [role="button"], [role="link"], [role="tab"], [role="checkbox"],'
  + ' [role="radio"], [role="switch"], [role="menuitem"], [role="option"],'
  + ' [tabindex]:not([tabindex="-1"])';

/**
 * Presses Tab up to `max` times, recording what focus lands on.
 *
 * Stops early when focus stops moving — a control that keeps focus on Tab is a
 * keyboard trap, and continuing would record the same element ninety times and
 * bury the finding in noise.
 */
export async function walkFocus(page, max = 150) {
  const seen = [];
  let lastSignature = null;
  let repeats = 0;

  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const step = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();

      /* An indicator is a real outline OR a real box-shadow. Both are legitimate
         here — `--focus` is a two-ring box-shadow by construction — so requiring
         an outline would fail the whole application for a design decision, and a
         check that fails everything is a check nobody reads. */
      const visibleRing =
        ((parseFloat(s.outlineWidth) || 0) >= 1 && s.outlineStyle !== 'none')
        || (!!s.boxShadow && s.boxShadow !== 'none');

      /**
       * 2.4.11 Focus Not Obscured (Minimum), new at AA in WCAG 2.2.
       *
       * header.topbar is sticky and carries a backdrop-filter, which is the
       * classic way a focused control ends up underneath something. Sampling the
       * centre of the focused element and asking what the browser thinks is on
       * top is the cheapest honest test: if the answer is neither the element nor
       * related to it, something is covering it.
       *
       * An overlay with pointer-events: none is excluded — it is painted above
       * but intercepts nothing, so it does not obscure in the sense the
       * criterion means.
       */
      let obscuredBy = null;
      if (r.width && r.height) {
        const cx = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
        const cy = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
        const top = document.elementFromPoint(cx, cy);
        if (top && top !== el && !el.contains(top) && !top.contains(el)) {
          obscuredBy = (top.className?.toString?.() || top.tagName).slice(0, 60);
        }
      }

      const name = (
        el.getAttribute('aria-label')
        || el.getAttribute('title')
        || el.textContent
        || el.getAttribute('placeholder')
        || ''
      ).trim().replace(/\s+/g, ' ').slice(0, 60);

      return {
        tag: el.tagName,
        type: el.getAttribute('type') || '',
        name,
        outerHTML: el.outerHTML.slice(0, 140).replace(/\s+/g, ' '),
        offScreen: r.bottom < 0 || r.top > innerHeight,
        visibleRing,
        obscuredBy
      };
    });

    if (!step) break;

    const signature = step.outerHTML;
    if (signature === lastSignature) {
      repeats += 1;
      /* Three consecutive Tabs that do not move focus is a trap, not a slow
         widget. Recorded once, then stop. */
      if (repeats >= 2) {
        seen.push({ index: i, ...step, trapped: true });
        break;
      }
    } else {
      repeats = 0;
    }
    lastSignature = signature;
    seen.push({ index: i, ...step, trapped: false });
  }
  return seen;
}

/** Every interactive element with its rendered box, for target-size checks. */
export function interactiveRects(page) {
  return page.evaluate(sel => {
    return [...document.querySelectorAll(sel)]
      .filter(el => {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map(el => {
        const r = el.getBoundingClientRect();
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          tag: el.tagName,
          name: (el.getAttribute('aria-label') || el.textContent || '')
            .trim().replace(/\s+/g, ' ').slice(0, 50),
          outerHTML: el.outerHTML.slice(0, 120).replace(/\s+/g, ' ')
        };
      });
  }, INTERACTIVE);
}

/** True when the document scrolls on the cross axis — a 1.4.10 failure. */
export function scrollsHorizontally(page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    /* One pixel of tolerance: sub-pixel layout rounding produces a 0.5px
       overflow on perfectly correct pages, and failing those trains people to
       ignore the check. */
    return d.scrollWidth > d.clientWidth + 1;
  });
}

/** The widest elements when the document overflows, so the cause is nameable. */
export function overflowingElements(page) {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width > limit + 1 || r.right > limit + 1) {
        out.push({
          tag: el.tagName,
          cls: (el.className?.toString?.() || '').slice(0, 50),
          w: Math.round(r.width),
          right: Math.round(r.right)
        });
      }
    }
    /* Widest first, and only a handful: an overflowing ancestor drags every
       descendant into this list, and the widest one is the cause. */
    return out.sort((a, b) => b.right - a.right).slice(0, 6);
  });
}
