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
 * How many Tabs one control may legitimately swallow before it is a trap.
 *
 * ── Why this is not a flat number ──
 *
 * A native `<input type="date">` is one element containing three SEGMENTS, and
 * Chromium moves between month, day and year with Tab before letting focus
 * leave. `document.activeElement` is the same input throughout, so the flat
 * "three Tabs that do not move focus" rule calls a perfectly escapable date
 * field a WCAG 2.1.2 keyboard trap. It is not one: a keyboard user tabs through
 * the segments and out the other side, which is the behaviour the platform
 * gives every date input on the web.
 *
 * Reported on `/hours/external`'s `#ext-date` the moment the sweep started
 * waiting for content to load — before that it measured the page while the
 * field was still a skeleton and never reached it, which is how a false
 * positive and a missing measurement hid each other.
 *
 * ── Why it still catches a real trap ──
 *
 * The allowance is a small finite number, not an exemption. A date input that
 * genuinely never releases focus keeps matching and still trips the rule; all
 * this buys is enough headroom for the segments a browser actually implements
 * (three for `date`, up to four for `datetime-local` with seconds). Everything
 * else keeps the original threshold.
 */
const SEGMENTED_INPUTS = new Set(['date', 'time', 'datetime-local', 'month', 'week']);

function allowedRepeats(step) {
  return step.tag === 'INPUT' && SEGMENTED_INPUTS.has(step.type) ? 5 : 2;
}

/**
 * Presses Tab up to `max` times, recording what focus lands on.
 *
 * Stops early when focus stops moving — a control that keeps focus on Tab is a
 * keyboard trap, and continuing would record the same element ninety times and
 * bury the finding in noise.
 */
export async function walkFocus(page, max = 150) {
  const seen = [];
  let repeats = 0;

  /* Reset the identity tracker for this page. See `sameAsLast` below. */
  await page.evaluate(() => { window.__a11yPrevFocused = null; });

  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const step = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;

      /**
       * Whether focus actually stayed put, by NODE IDENTITY.
       *
       * The first version compared a 140-character slice of `outerHTML`, and it
       * reported 25 keyboard traps that did not exist. Every `.nav-item` in the
       * rail begins with the same inline `<svg xmlns=... width="17" height="17"
       * viewBox="0 0 24 24" ...>` markup, so the label — the only part that
       * differs — falls outside the slice and four distinct navigation buttons
       * produced one identical signature. The giveaway was that the "trapped"
       * control was a different one on every route; a real trap is the same
       * control every time.
       *
       * Comparing the element itself cannot be fooled by markup that happens to
       * start the same way.
       */
      const sameAsLast = window.__a11yPrevFocused === el;
      window.__a11yPrevFocused = el;

      /**
       * Whether this element is REALLY focused, and not merely the last thing
       * `document.activeElement` remembers.
       *
       * A native `<input type="date">` holds focus across its month, day and
       * year segments. On the Tab that finally leaves it, Chromium has already
       * withdrawn `:focus` — so every focus style reverts — while
       * `document.activeElement` still reports the input for an instant. Read
       * in that window the control looks like one with no indicator at all.
       *
       * Measured on `/hours/external`: three consecutive reads of `#ext-date`
       * with `:focus` true and `box-shadow: rgb(237, 248, 242) 0 0 0 3px`, then
       * a fourth with `:focus` false and `box-shadow: none`. Only the fourth was
       * reported, as a WCAG 2.4.7 failure against a field that plainly has a
       * ring, and it cost two CSS "fixes" for a defect that never existed.
       *
       * The sweep skips the unfocused read rather than trusting it. A control
       * that is genuinely focused and genuinely ring-less is untouched by this —
       * which is how the two real findings on this same run, a dashboard button
       * and a calendar segment, were still caught.
       */
      const reallyFocused = el.matches(':focus');
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
       * The criterion fails only when the focused control is **entirely** hidden.
       * Partial obscuring is explicitly permitted at AA — that is the difference
       * between 2.4.11 (Minimum) and 2.4.12 (Enhanced, AAA), which is the one
       * that forbids partial.
       *
       * The first version sampled only the CENTRE point, which is a stricter
       * rule than the criterion states: a sticky header covering the top half of
       * a control occludes its centre while the bottom half is plainly visible,
       * and that passes 2.4.11. Reporting it would have been a false positive
       * against conformant code — and header.topbar is sticky here, so it was a
       * live risk rather than a theoretical one.
       *
       * So a grid of points across the box is sampled, and the control counts as
       * obscured only when EVERY sampled point is covered by something unrelated
       * to it. An overlay that is painted above but intercepts nothing
       * (`pointer-events: none`) is not returned by elementFromPoint at all, so
       * it correctly does not count.
       */
      let obscuredBy = null;
      if (r.width && r.height) {
        const clamp = (v, max) => Math.min(Math.max(v, 1), max - 1);
        /* Nine points: corners, edge midpoints and centre, inset slightly so a
           1px border does not decide the result. */
        const xs = [0.1, 0.5, 0.9].map(f => clamp(r.left + r.width * f, innerWidth));
        const ys = [0.1, 0.5, 0.9].map(f => clamp(r.top + r.height * f, innerHeight));
        const blockers = new Set();
        let visibleSomewhere = false;
        for (const x of xs) {
          for (const y of ys) {
            const top = document.elementFromPoint(x, y);
            if (!top || top === el || el.contains(top) || top.contains(el)) {
              visibleSomewhere = true;
            } else {
              blockers.add((top.className?.toString?.() || top.tagName).slice(0, 60));
            }
          }
        }
        /* Entirely hidden only. If any sampled point reaches the control, the
           control is at least partly visible and 2.4.11 is satisfied. */
        if (!visibleSomewhere && blockers.size) obscuredBy = [...blockers].join(', ');
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
        reallyFocused,
        visibleRing,
        obscuredBy,
        sameAsLast
      };
    });

    if (!step) break;

    if (step.sameAsLast) {
      repeats += 1;
      /* Three consecutive Tabs that do not move focus is a trap, not a slow
         widget. Recorded once, then stop — continuing would record the same
         element ninety more times and bury the finding in its own noise. */
      if (repeats >= allowedRepeats(step)) {
        seen.push({ index: i, ...step, trapped: true });
        break;
      }
    } else {
      repeats = 0;
    }
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
        /**
         * The EFFECTIVE target, not the control's own box.
         *
         * WCAG 2.5.8 measures what a pointer can activate. A native checkbox or
         * radio renders at 16x16 in Chromium, and when it sits inside a `<label>`
         * — which is the pattern this codebase uses everywhere, including the
         * Privacy switches and the Accessibility settings — clicking anywhere in
         * that label activates it. The target is therefore the label.
         *
         * Measuring the input alone reported every one of those as a 16x16
         * failure. Probed on the opportunity dialog: two checkboxes at 16x16
         * inside labels measuring 109x44 and 138x44 — comfortably conformant, and
         * reported as defects by a check that looked at the wrong box. Acting on
         * that would have meant restyling conformant controls to satisfy a
         * mismeasurement.
         *
         * Only an ancestor label counts. A `label[for=...]` sitting elsewhere in
         * the DOM is also clickable, but it is not contiguous with the control,
         * and 2.5.8 is about the size of a single target rather than the sum of
         * separated ones.
         */
        const label = el.closest('label');
        const target = label && label.contains(el) ? label : el;
        const r = target.getBoundingClientRect();
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          tag: el.tagName,
          measured: target === el ? 'self' : 'label',
          name: (el.getAttribute('aria-label') || el.textContent || label?.textContent || '')
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
