import { test, expect } from '@playwright/test';
import { forEachRoute } from '../harness/walk.mjs';
import { fetchRoles } from '../harness/roles.mjs';
import { signInAs } from '../harness/signIn.mjs';

/** A phone, and the breakpoint where the bottom bar replaces the rail. */
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

/**
 * Mobile accessibility, which is not the same as a narrow desktop.
 *
 * The geometry sweep already measures target size and reflow at phone widths.
 * What it does not check is that the mobile SHELL is usable: at this breakpoint
 * `.sidebar` is `display: none` and `.mobilenav` takes over, so the navigation a
 * keyboard or screen-reader user meets is a different set of elements from the
 * one every other sweep looked at. A defect confined to the bottom bar is
 * invisible at desktop width.
 */
test('the mobile bottom bar is a named landmark of real controls', async ({ browser, request, baseURL }) => {
  const roles = await fetchRoles(request, baseURL);
  const statePath = await signInAs(browser, roles[0], baseURL);
  const ctx = await browser.newContext({ baseURL, storageState: statePath, ...PHONE });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.locator('#main-content').waitFor({ state: 'visible', timeout: 20000 });

  const bar = await page.evaluate(() => {
    const nav = document.querySelector('.mobilenav');
    if (!nav) return { missing: true };
    const s = getComputedStyle(nav);
    const labelledBy = nav.getAttribute('aria-labelledby');
    const items = [...nav.querySelectorAll('a[href], button')].filter(el => {
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    });
    return {
      displayed: s.display !== 'none',
      name: (
        nav.getAttribute('aria-label')
        || (labelledBy && document.getElementById(labelledBy)?.textContent)
        || ''
      ).trim(),
      /* The rail is hidden here, so this bar is the only navigation — and one of
         its items must say it is the current page or there is no way to tell
         where you are. */
      hasCurrent: !!nav.querySelector('[aria-current]'),
      nameless: items.filter(
        el => !(el.getAttribute('aria-label') || el.textContent || '').trim()
      ).map(el => el.outerHTML.slice(0, 100).replace(/\s+/g, ' ')),
      count: items.length
    };
  });

  const railHidden = await page.evaluate(() => {
    const rail = document.querySelector('.sidebar');
    return !rail || getComputedStyle(rail).display === 'none';
  });

  await ctx.close();

  expect(bar.missing, '.mobilenav is gone — was it renamed?').toBeFalsy();
  expect(railHidden, 'the desktop rail is still displayed at 390px, so this is not the mobile shell').toBe(true);
  expect(bar.displayed, '.mobilenav is not displayed at 390px, so there is no navigation at all').toBe(true);
  expect(bar.name, 'the mobile navigation landmark has no accessible name').not.toBe('');
  expect(bar.count, 'the mobile navigation has no items').toBeGreaterThan(1);
  expect(bar.hasCurrent, 'nothing in the mobile navigation is marked aria-current, so there is no way to tell which page you are on').toBe(true);
  expect(bar.nameless, `WCAG 4.1.2 — unnamed mobile navigation controls:\n${bar.nameless.join('\n')}`).toEqual([]);
});

test('the skip link still comes first on a phone', async ({ browser, request, baseURL }) => {
  const roles = await fetchRoles(request, baseURL);
  const statePath = await signInAs(browser, roles[0], baseURL);
  const ctx = await browser.newContext({ baseURL, storageState: statePath, ...PHONE });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.locator('#main-content').waitFor({ state: 'visible', timeout: 20000 });

  /* The mobile shell renders a different tree, and the skip link is the one
     control that has to be first in every one of them. */
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: /skip to main content/i }),
    'the skip link is not the first tab stop on a phone'
  ).toBeFocused();
  await ctx.close();
});

test('every route reaches its main content on a phone', async ({ browser, request, baseURL }) => {
  test.setTimeout(45 * 60 * 1000);

  /**
   * The mobile equivalent of the structure sweep, reduced to the one question
   * that matters at this width: did the page render its content at all.
   *
   * A layout that collapses to nothing on a phone passes every colour, name and
   * focus check while showing the user an empty screen, because all of those
   * measure elements rather than whether anything is visible.
   */
  const empty = [];
  const { unreachable } = await forEachRoute(
    { browser, request, baseURL },
    { context: PHONE },
    async (page, route) => {
      const text = await page.evaluate(() => {
        const main = document.querySelector('#main-content, main, [role="main"]');
        return (main?.innerText || '').trim().length;
      });
      /* This found something real the first time it ran: on twelve
         permission-denied routes `main` had ZERO characters, because App.jsx
         returns the error before it builds the shell and the error content sat
         outside every landmark. The check is phrased as "main is empty" rather
         than "the page is empty" precisely so that case fails here — a page with
         content nobody can reach by landmark is the defect. */
      if (text < 20) empty.push(`${route.path} — main has ${text} characters of text at 390px`);
    }
  );

  expect(unreachable, `routes that did not load on a phone:\n${unreachable.join('\n')}`).toEqual([]);
  expect(empty, `routes whose main content is empty on a phone:\n${empty.join('\n')}`).toEqual([]);
});
