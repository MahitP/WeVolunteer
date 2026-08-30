import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { fetchRoles } from '../harness/roles.mjs';
import { signInAs } from '../harness/signIn.mjs';

/**
 * Every Settings panel, not just the one that renders by default.
 *
 * ── The gap this closes, and what hid in it ──
 *
 * `Settings.jsx` picks its panel from `?section=`, defaulting to `appearance`.
 * The route sweep visits `/settings` — so for the whole of this initiative it
 * measured the Appearance panel six times and never rendered Privacy,
 * Notifications, Security or Messaging at all.
 *
 * What was hiding there: **all thirteen notification toggles had no accessible
 * name.** `<label className="premium-switch">` wrapped only the input and a
 * decorative slider span, while the visible text sat in sibling elements
 * outside the label — so every switch announced as "checkbox, not checked" and a
 * screen-reader user could not tell which notification any of them controlled.
 * A Level A failure (4.1.2), on the panel that decides whether somebody hears
 * about the shift they signed up for, invisible to a sweep that never opened it.
 *
 * That is the argument for this file: a defect does not have to be subtle to
 * survive, it only has to be somewhere nothing looked.
 */

/**
 * Derived from the navigation, not typed here.
 *
 * `SettingsSidebar.jsx`'s `SECTIONS` array is the list a person can actually
 * reach, and `src/views/settingsSections.test.js` already proves it matches the
 * renderer's `switch`. Reading it means a panel added tomorrow is swept the day
 * it is added rather than the day somebody remembers this file — the same
 * reasoning as the route inventory.
 */
import fs from 'node:fs';
import path from 'node:path';

const SIDEBAR = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../src/components/account/SettingsSidebar.jsx'),
  'utf8'
);
const SECTIONS = (() => {
  const block = SIDEBAR.match(/const SECTIONS = \[([\s\S]*?)\n\];/);
  return [...block[1].matchAll(/\bid:\s*'([^']+)'/g)].map(m => m[1]);
})();

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

async function openPanels(browser, request, baseURL) {
  const roles = await fetchRoles(request, baseURL);
  const statePath = await signInAs(browser, roles[0], baseURL);
  const ctx = await browser.newContext({ baseURL, storageState: statePath });
  return { ctx, page: await ctx.newPage() };
}

async function showPanel(page, section) {
  await page.goto(`/settings?section=${section}`);
  /* Wait for the panel, not the shell: Settings is code-split, so
     `#main-content` arrives before the section inside it. */
  await page.locator('.settings-panel, [class*="settings"]').first()
    .waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  await page.locator('#main-content').waitFor({ state: 'visible', timeout: 20000 });
  await page.addStyleTag({ content: SETTLE });
  await page.evaluate(
    () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  );
  /* The panel has to have actually rendered something, or every check below
     passes against an empty box — the vacuity this whole harness is written
     against. A mismatch between the sidebar list and the renderer's switch shows
     up here as an empty panel. */
  const text = await page.evaluate(() =>
    (document.querySelector('#main-content')?.innerText || '').trim().length);
  expect(text, `the ${section} panel rendered no text — is there a case for it?`)
    .toBeGreaterThan(40);
}

test('found the section list', () => {
  /* Guards the guard: a renamed array would make every parameterised test below
     silently disappear rather than fail. */
  expect(SECTIONS.length, 'no SECTIONS array found in SettingsSidebar.jsx').toBeGreaterThan(5);
  expect(SECTIONS).toContain('notifications');
});

test('every Settings panel is free of axe violations', async ({ browser, request, baseURL }) => {
  test.setTimeout(10 * 60 * 1000);
  const { ctx, page } = await openPanels(browser, request, baseURL);
  const findings = [];

  for (const section of SECTIONS) {
    await showPanel(page, section);
    const results = await new AxeBuilder({ page })
      .include('#main-content')
      .withTags(AXE_TAGS)
      .analyze();
    for (const v of results.violations) {
      for (const n of v.nodes) {
        findings.push(`${section}: ${v.id} (${v.impact}) — ${(n.html || '').slice(0, 100)}`);
      }
    }
  }

  await ctx.close();
  expect(findings, `WCAG 2.2 AA violations in Settings panels:\n${findings.join('\n')}`).toEqual([]);
});

test('every control in every Settings panel has an accessible name', async ({ browser, request, baseURL }) => {
  test.setTimeout(10 * 60 * 1000);
  const { ctx, page } = await openPanels(browser, request, baseURL);
  const nameless = [];
  let checked = 0;

  for (const section of SECTIONS) {
    await showPanel(page, section);
    const result = await page.evaluate(() => {
      const out = { nameless: [], count: 0 };
      const main = document.querySelector('#main-content');
      const SEL = 'a[href], button, input:not([type="hidden"]), select, textarea,'
        + ' [role="button"], [role="switch"], [role="checkbox"], [role="radio"]';
      for (const el of main.querySelectorAll(SEL)) {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        out.count += 1;
        /* The full accessible-name computation, including `aria-labelledby`, a
           wrapping or `for=` label, and an inner image's alt text. Checking less
           than this is how a conformant control gets reported as a defect. */
        const labelledBy = el.getAttribute('aria-labelledby');
        const name = (
          el.getAttribute('aria-label')
          || (labelledBy && labelledBy.split(/\s+/)
              .map(id => document.getElementById(id)?.textContent || '').join(' '))
          || [...(el.labels || [])].map(l => l.textContent).join(' ')
          || el.textContent
          || [...el.querySelectorAll('img[alt]')].map(i => i.getAttribute('alt')).join(' ')
          || el.getAttribute('title')
          || ''
        ).trim();
        if (!name) out.nameless.push(el.outerHTML.slice(0, 120).replace(/\s+/g, ' '));
      }
      return out;
    });
    checked += result.count;
    for (const html of result.nameless) nameless.push(`${section}: ${html}`);
  }

  await ctx.close();
  /* Guards the guard: if the selector matched nothing across every panel, the
     empty result below would be meaningless rather than reassuring. */
  expect(checked, 'no controls were found in any panel at all').toBeGreaterThan(20);
  expect(
    nameless,
    `WCAG 4.1.2 — controls with no accessible name (${checked} checked):\n${nameless.join('\n')}`
  ).toEqual([]);
});

test('mutually exclusive choices expose which one is current', async ({ browser, request, baseURL }) => {
  test.setTimeout(10 * 60 * 1000);
  const { ctx, page } = await openPanels(browser, request, baseURL);
  const silent = [];

  for (const section of SECTIONS) {
    await showPanel(page, section);
    const groups = await page.evaluate(() => {
      /**
       * A group of buttons where selection is marked ONLY by a CSS class.
       *
       * This is a defect that has already happened here twice: the theme picker
       * used `.active` alone, so assistive technology met three identically
       * named buttons with no way to tell which was current. A class is a
       * colour; `aria-pressed`, `aria-current` or `aria-checked` is a state.
       */
      const out = [];
      const main = document.querySelector('#main-content');
      const byParent = new Map();
      for (const el of main.querySelectorAll('button')) {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const cls = el.className?.toString?.() || '';
        if (!/\b(active|selected|is-active|is-selected)\b/.test(cls)) continue;
        const stated = el.hasAttribute('aria-pressed')
          || el.hasAttribute('aria-current')
          || el.hasAttribute('aria-checked')
          || el.getAttribute('role') === 'radio';
        if (!stated) {
          const key = el.parentElement?.className?.toString?.().slice(0, 40) || 'unknown';
          if (!byParent.has(key)) {
            byParent.set(key, true);
            out.push(`${el.outerHTML.slice(0, 100).replace(/\s+/g, ' ')} (in .${key})`);
          }
        }
      }
      return out;
    });
    for (const g of groups) silent.push(`${section}: ${g}`);
  }

  await ctx.close();
  expect(
    silent,
    'WCAG 4.1.2 — controls marked selected by a CSS class with no corresponding '
    + `ARIA state, so nothing announces which one is current:\n${silent.join('\n')}`
  ).toEqual([]);
});
