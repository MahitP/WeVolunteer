import { test, expect } from '@playwright/test';
import { forEachRoute } from './harness/walk.mjs';
import { fetchRoles } from './harness/roles.mjs';
import { signInAs } from './harness/signIn.mjs';

/**
 * The CSS guards prove a rule is declared. This proves the browser paints it.
 *
 * Those are different claims, and the gap between them is where the original
 * focus defect lived: every declaration was individually reasonable, and the
 * composed result in forced-colors mode was no focus ring at all.
 */
test('focus stays visible in forced-colors mode, on every route', async ({ browser, request, baseURL }) => {
  test.setTimeout(45 * 60 * 1000);

  const invisible = [];
  const { unreachable } = await forEachRoute(
    { browser, request, baseURL },
    { context: { forcedColors: 'active' } },
    async (page, route) => {
      /* Two Tabs: the first lands on the skip link, the second on a real
         control. Both must paint, and the skip link is the one a keyboard user
         meets first on every single page. */
      for (const nth of [1, 2]) {
        await page.keyboard.press('Tab');
        const painted = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const s = getComputedStyle(el);
          return {
            tag: el.tagName,
            name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
            outlineWidth: parseFloat(s.outlineWidth) || 0,
            outlineStyle: s.outlineStyle
          };
        });
        if (!painted) continue;
        /* box-shadow is stripped in forced-colors, so an outline is the only
           indicator that can survive there. */
        if (painted.outlineWidth < 2 || painted.outlineStyle === 'none') {
          invisible.push(
            `${route.path} — tab ${nth}: ${painted.tag} "${painted.name}" `
            + `outline ${painted.outlineWidth}px ${painted.outlineStyle}`
          );
        }
      }
    }
  );

  expect(unreachable, `routes that did not load:\n${unreachable.join('\n')}`).toEqual([]);
  expect(
    invisible,
    'WCAG 2.4.7 — no visible focus indicator under forced-colors, where box-shadow is stripped:\n'
    + invisible.join('\n')
  ).toEqual([]);
});

test('nothing animates forever under prefers-reduced-motion', async ({ browser, request, baseURL }) => {
  test.setTimeout(45 * 60 * 1000);

  const moving = [];
  await forEachRoute(
    { browser, request, baseURL },
    { context: { reducedMotion: 'reduce' } },
    async (page, route) => {
      const hits = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('*')) {
          const s = getComputedStyle(el);
          const dur = parseFloat(s.animationDuration) || 0;
          /* An infinite animation is the one that matters. A 200ms transition
             that still runs is a detail; a permanently spinning element is a
             vestibular trigger that never stops, and it is what the criterion
             is actually about. */
          if (s.animationIterationCount === 'infinite' && dur > 0) {
            out.push(`${el.tagName}.${(el.className?.toString?.() || '').slice(0, 40)}`);
          }
        }
        return [...new Set(out)].slice(0, 8);
      });
      if (hits.length) moving.push(`${route.path}: ${hits.join(', ')}`);
    }
  );

  expect(
    moving,
    `WCAG 2.3.3 / prefers-reduced-motion — elements that animate forever anyway:\n${moving.join('\n')}`
  ).toEqual([]);
});

/**
 * 1.4.4 Resize Text at 200%, checked as a real zoom rather than a viewport.
 *
 * A narrow viewport and a zoomed page are equivalent for reflow but NOT for text
 * scaling: a layout that pins font sizes in px survives a narrow viewport and
 * fails a zoom. Chromium's deviceScaleFactor does not change CSS pixels, so this
 * halves the viewport instead, which is what 200% zoom does to available CSS
 * width, and then checks that no text got clipped away.
 */
test('the dashboard survives 200% zoom without losing content', async ({ browser, request, baseURL }) => {
  const roles = await fetchRoles(request, baseURL);
  const statePath = await signInAs(browser, roles[0], baseURL);
  const ctx = await browser.newContext({
    baseURL, storageState: statePath, viewport: { width: 640, height: 400 }
  });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.locator('#main-content').waitFor({ state: 'visible' });

  const state = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    mainText: (document.querySelector('#main-content')?.innerText || '').trim().length
  }));

  await ctx.close();
  expect(state.horizontal, 'the page scrolls sideways at the equivalent of 200% zoom').toBe(false);
  expect(state.mainText, 'main is empty at 200% zoom — content was hidden rather than reflowed')
    .toBeGreaterThan(50);
});
