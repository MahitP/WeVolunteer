import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { fetchRoles } from '../harness/roles.mjs';
import { signInAs } from '../harness/signIn.mjs';
import { interactiveRects } from '../harness/measure.mjs';

/**
 * The inside of a dialog, which no other sweep had ever measured.
 *
 * ── The gap this closes ──
 *
 * Every route sweep visits URLs. Opportunity details and opportunity signup are
 * not URLs in that sense — they are a dialog opened over `/discover` — so their
 * contents had never been through axe, the focus walk, or the target-size
 * measurement. `dialogSemantics.test.jsx` proves the shared wiring exists and
 * `Modal.jsx` guarantees Escape, containment and focus restore for every dialog
 * at once, but neither says anything about the labels, contrast or control sizes
 * of what is rendered INSIDE one.
 *
 * That mattered more than a general gap, because signing up for an opportunity is
 * the thing this application exists to do.
 *
 * ── Why the dialog is opened by CLICKING ──
 *
 * `?event=` looks like the obvious way in, and it does not work from a cold
 * navigation: App.jsx resolves the dialog's event out of `events` (the session
 * index, which holds only events this reader is involved in) merged with
 * `seenEvents` (whatever a browse surface has just rendered). A direct URL races
 * the browse response that would populate the second, so the parameter is set
 * and nothing opens.
 *
 * Clicking the card's own control is both more reliable and a better test: it is
 * the path a person takes, and it exercises the trigger whose focus has to be
 * restored when the dialog closes.
 *
 */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Kills animation so nothing is measured mid-fade. See walk.mjs for why. */
const SETTLE = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

async function openEventDialog(browser, request, baseURL) {
  const roles = await fetchRoles(request, baseURL);
  const statePath = await signInAs(browser, roles[0], baseURL);
  const ctx = await browser.newContext({ baseURL, storageState: statePath });
  const page = await ctx.newPage();
  await page.goto('/discover');
  /* The card's footer control. Its label depends on the reader's relationship to
     the event — "View shifts", "View sign-up" or "View details" — so all three
     are matched rather than assuming which the seed produces. */
  const trigger = page.getByRole('button', { name: /view (shifts|sign-up|details)/i }).first();
  await trigger.waitFor({ state: 'visible', timeout: 30000 });
  await trigger.click();
  const dialog = page.getByRole('dialog').first();
  await dialog.waitFor({ state: 'visible', timeout: 30000 });
  await page.addStyleTag({ content: SETTLE });
  await page.evaluate(
    () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  );
  return { ctx, page, dialog };
}

test('the opportunity dialog is a named modal with focus inside it', async ({ browser, request, baseURL }) => {
  const { ctx, page, dialog } = await openEventDialog(browser, request, baseURL);

  const semantics = await dialog.evaluate(el => {
    const labelledBy = el.getAttribute('aria-labelledby');
    return {
      modal: el.getAttribute('aria-modal'),
      name: (
        el.getAttribute('aria-label')
        || (labelledBy && document.getElementById(labelledBy)?.textContent)
        || ''
      ).trim(),
      focusInside: el.contains(document.activeElement),
      activeTag: document.activeElement?.tagName
    };
  });

  await ctx.close();

  expect(semantics.modal, 'the dialog is not aria-modal, so AT may not confine to it').toBe('true');
  expect(semantics.name, 'the dialog has no accessible name').not.toBe('');
  /* Focus has to be inside on open, or a keyboard user's next Tab continues
     through the page behind the dialog they cannot see past. */
  expect(
    semantics.focusInside,
    `focus is on ${semantics.activeTag} outside the dialog after it opened`
  ).toBe(true);
});

test('axe finds no violations inside the opportunity dialog', async ({ browser, request, baseURL }) => {
  const { ctx, page } = await openEventDialog(browser, request, baseURL);

  /* Scoped to the dialog: the page behind it is already covered by the route
     sweep, and including it here would double-report anything found there. */
  const results = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(AXE_TAGS)
    .analyze();

  const findings = results.violations.flatMap(v =>
    v.nodes.map(n => `${v.id} (${v.impact}) — ${v.help} — ${(n.html || '').slice(0, 120)}`)
  );

  await ctx.close();
  expect(findings, `WCAG 2.2 AA violations inside the opportunity dialog:\n${findings.join('\n')}`)
    .toEqual([]);
});

test('every control inside the opportunity dialog is named and big enough', async ({ browser, request, baseURL }) => {
  const { ctx, page } = await openEventDialog(browser, request, baseURL);

  const problems = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const out = { nameless: [] };
    for (const el of dialog.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea')) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const labelledBy = el.getAttribute('aria-labelledby');
      const name = (
        el.getAttribute('aria-label')
        || (labelledBy && document.getElementById(labelledBy)?.textContent)
        || el.labels?.[0]?.textContent
        || el.textContent
        || el.getAttribute('title')
        || ''
      ).trim();
      if (!name) out.nameless.push(el.outerHTML.slice(0, 110).replace(/\s+/g, ' '));
    }
    return out;
  });

  /* 2.5.8 inside the dialog. The close control is the one that historically got
     this wrong — touchTargets.test.js records `.modal-close` at 30x37px — so it
     is measured here rather than assumed from the CSS. */
  const tooSmall = (await interactiveRects(page))
    .filter(el => el.w < 24 || el.h < 24)
    .filter(el => !(el.tag === 'A' && el.h < 24 && el.w > 48))
    .map(el => `${el.w}x${el.h} ${el.tag} "${el.name}"`);

  await ctx.close();

  expect(problems.nameless, `WCAG 4.1.2 — unnamed controls inside the dialog:\n${problems.nameless.join('\n')}`)
    .toEqual([]);
  expect(tooSmall, `WCAG 2.5.8 — controls under 24x24 while the dialog is open:\n${tooSmall.join('\n')}`)
    .toEqual([]);
});

test('Escape closes the dialog and gives focus back to the page', async ({ browser, request, baseURL }) => {
  const { ctx, page, dialog } = await openEventDialog(browser, request, baseURL);

  await page.keyboard.press('Escape');
  await expect(dialog, 'Escape did not close the dialog').toBeHidden({ timeout: 10000 });

  const after = await page.evaluate(() => ({
    tag: document.activeElement?.tagName || 'BODY',
    inDialog: !!document.querySelector('[role="dialog"]')?.contains(document.activeElement)
  }));

  await ctx.close();

  /* Focus must not be left on the body: the next Tab would restart at the top of
     the page, which for somebody who opened a dialog from halfway down a list
     means finding their place again by hand. */
  expect(
    after.tag,
    'focus fell to the document body after the dialog closed, so the keyboard user '
    + 'loses their place in the list they opened it from'
  ).not.toBe('BODY');
  expect(after.inDialog, 'focus is still inside a dialog that has closed').toBe(false);
});

test('the dialog reflows at 320px without losing its controls', async ({ browser, request, baseURL }) => {
  const roles = await fetchRoles(request, baseURL);
  const statePath = await signInAs(browser, roles[0], baseURL);
  const ctx = await browser.newContext({
    baseURL, storageState: statePath, viewport: { width: 320, height: 512 }
  });
  const page = await ctx.newPage();
  await page.goto('/discover');
  await page.getByRole('button', { name: /view (shifts|sign-up|details)/i }).first()
    .click({ timeout: 30000 });
  await page.getByRole('dialog').first().waitFor({ state: 'visible', timeout: 30000 });

  const state = await page.evaluate(() => {
    const d = document.documentElement;
    const dialog = document.querySelector('[role="dialog"]');
    const controls = [...dialog.querySelectorAll('button, a[href]')].filter(el => {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    });
    return {
      horizontal: d.scrollWidth > d.clientWidth + 1,
      controls: controls.length,
      /**
       * A dialog taller than the viewport must be scrollable SOMEWHERE, or its
       * bottom — where the primary action lives — is unreachable at this width.
       *
       * "Somewhere" is the important word. This dialog is `overflow: hidden` with
       * a `max-height`, and the element that actually scrolls is its inner
       * `.modal-body`. Checking only the dialog reported it as unscrollable and
       * its primary action as unreachable, which was false: probed at 320px the
       * dialog is 650px of content in a 512px box with `DIV.modal-body` as the
       * scroller. So the question is whether ANY element in the subtree can
       * scroll the overflow, not whether the outermost one does.
       */
      scrollable: dialog.scrollHeight <= dialog.clientHeight
        || [dialog, ...dialog.querySelectorAll('*')].some(el => {
          const s = getComputedStyle(el);
          return (s.overflowY === 'auto' || s.overflowY === 'scroll')
            && el.scrollHeight > el.clientHeight + 1;
        })
    };
  });

  await ctx.close();

  expect(state.horizontal, 'the page scrolls sideways with the dialog open at 320px').toBe(false);
  expect(state.controls, 'the dialog has no controls at 320px').toBeGreaterThan(0);
  expect(
    state.scrollable,
    'the dialog is taller than its box and does not scroll, so its primary action '
    + 'is unreachable at 320px'
  ).toBe(true);
});
