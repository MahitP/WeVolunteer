import { test, expect } from '@playwright/test';
import { forEachRoute } from './harness/walk.mjs';
import { interactiveRects, scrollsHorizontally, overflowingElements } from './harness/measure.mjs';

/**
 * WCAG 2.2 2.5.8 Target Size (Minimum) — 24x24 CSS px, Level AA.
 *
 * Not 44. src/touchTargets.test.js cites "WCAG 2.1 §2.5.5" and enforces 44px;
 * 2.5.5 Target Size (Enhanced) is Level AAA. The AA criterion is 2.5.8, new in
 * 2.2, at 24x24. That guard is therefore STRICTER than conformance requires,
 * which is a good thing and is not being loosened — it just is not the number
 * this file fails on, and conflating the two would report a house rule as a
 * conformance failure.
 */
const AA_MIN = 24;

/** The house rule, reported separately so the two are never confused. */
const HOUSE_MIN = 44;

test('interactive targets meet the 24x24 AA minimum', async ({ browser, request, baseURL }) => {
  test.setTimeout(45 * 60 * 1000);
  const tooSmall = [];
  const { unreachable } = await forEachRoute({ browser, request, baseURL }, {}, async (page, route) => {
    for (const el of await interactiveRects(page)) {
      /* 2.5.8 excepts a link whose target is inline in a sentence: its height is
         the line height and enlarging it would break the paragraph. */
      if (el.tag === 'A' && el.h < AA_MIN && el.w > AA_MIN * 2) continue;
      if (el.w < AA_MIN || el.h < AA_MIN) {
        tooSmall.push(`${route.path} — ${el.w}x${el.h} ${el.tag} "${el.name}" ${el.outerHTML}`);
      }
    }
  });
  expect(unreachable, `routes that did not load:\n${unreachable.join('\n')}`).toEqual([]);
  expect(tooSmall, `WCAG 2.5.8 — below the 24x24 AA floor:\n${tooSmall.join('\n')}`).toEqual([]);
});

/**
 * Asserts nothing, deliberately — the 44px floor is a house rule ABOVE Level AA,
 * so a shortfall here is not a conformance defect, and failing the build on it
 * before the inventory exists would stall the audit on something no criterion
 * requires. src/touchTargets.test.js keeps enforcing the rule where it matters,
 * on the controls it names. The audit document records what this prints.
 */
test('report: touch targets measured against the 44px house rule', async ({ browser, request, baseURL }) => {
  test.setTimeout(45 * 60 * 1000);
  const tooSmall = [];
  await forEachRoute(
    { browser, request, baseURL },
    { context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
    async (page, route) => {
      for (const el of await interactiveRects(page)) {
        if (el.tag === 'A' && el.w > HOUSE_MIN * 2) continue;
        if (el.w < HOUSE_MIN || el.h < HOUSE_MIN) {
          tooSmall.push(`${route.path} — ${el.w}x${el.h} ${el.tag} "${el.name}"`);
        }
      }
    }
  );
  console.log(`below the 44px house rule (${tooSmall.length}):\n${tooSmall.join('\n')}`);
});

/**
 * WCAG 1.4.10 Reflow — 320 CSS px with no two-axis scrolling.
 *
 * 320px is the criterion's own number: 1280 at 400% zoom. Tested by viewport
 * rather than by zoom because they are equivalent for layout and a viewport is
 * reproducible where a zoom factor is not.
 */
test('no route scrolls horizontally at 320px', async ({ browser, request, baseURL }) => {
  test.setTimeout(45 * 60 * 1000);
  const overflowing = [];
  await forEachRoute(
    { browser, request, baseURL },
    { context: { viewport: { width: 320, height: 512 } } },
    async (page, route) => {
      if (await scrollsHorizontally(page)) {
        const culprits = await overflowingElements(page);
        const w = await page.evaluate(() => document.documentElement.scrollWidth);
        overflowing.push(
          `${route.path} — scrollWidth ${w} at 320: `
          + culprits.map(c => `${c.tag}.${c.cls}(w=${c.w},right=${c.right})`).join(' ')
        );
      }
    }
  );
  expect(overflowing, `WCAG 1.4.10 Reflow failures:\n${overflowing.join('\n')}`).toEqual([]);
});

/**
 * WCAG 1.4.12 Text Spacing — the exact four values the criterion names, applied
 * with !important because a user stylesheet doing precisely that is what the
 * criterion describes. Scrollable containers are excluded: scrollable is not
 * clipped.
 *
 * Asserts nothing, deliberately — `scrollHeight > clientHeight` is a heuristic
 * for clipping, not proof of it, and telling a genuinely clipped label from a
 * container that is merely taller than its box needs a person looking at it. The
 * audit document records what this prints and triages it into findings.
 */
test('report: content clipping under the 1.4.12 text-spacing overrides', async ({ browser, request, baseURL }) => {
  test.setTimeout(45 * 60 * 1000);
  const clipped = [];
  await forEachRoute({ browser, request, baseURL }, {}, async (page, route) => {
    await page.addStyleTag({ content: `
      * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
      p { margin-bottom: 2em !important; }
    ` });

    const hits = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        const s = getComputedStyle(el);
        /**
         * Only the VERTICAL axis decides whether enlarged text is lost, because
         * that is the direction text grows when its spacing increases.
         *
         * `overflow-y: visible` means content escapes the box and stays on
         * screen — not clipped, so not a 1.4.12 concern however far it overflows.
         * `auto`/`scroll` means it is reachable by scrolling — also not lost.
         * Only `hidden` and `clip` remove it.
         *
         * The first version tested `s.overflow` as a whole, which reported
         * `.err` as clipping even after it was changed to `clip visible` —
         * horizontal clipping only, which is what it needed and which loses
         * nothing vertically. A detector that cannot see a fix is worse than no
         * detector, because it argues for changes that are already made.
         */
        if (s.overflowY === 'visible' || s.overflowY === 'auto' || s.overflowY === 'scroll') continue;
        if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2) {
          out.push(`${el.tagName}.${(el.className?.toString?.() || '').slice(0, 40)} ${el.clientHeight}<${el.scrollHeight}`);
        }
      }
      return out.slice(0, 10);
    });
    if (hits.length) clipped.push(`${route.path}: ${hits.join('; ')}`);
  });
  console.log(`possible 1.4.12 clipping (${clipped.length}):\n${clipped.join('\n')}`);
});
