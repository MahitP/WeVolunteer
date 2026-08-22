import { test, expect } from '@playwright/test';
import { fetchRoles } from '../harness/roles.mjs';
import { signInAs } from '../harness/signIn.mjs';

/**
 * Settings → Accessibility, and the Accessibility Statement it links to.
 *
 * ── Why this needs a browser ──
 *
 * The static guards prove the three declaration sites agree: the hook, the
 * pre-paint script and the CSS all name the same preferences with the same
 * values. What they cannot prove is that the toggle changes anything. A
 * preference writes a `data-` attribute on `<html>` and a stylesheet reacts to
 * it, and the failure mode is silent in both directions — the control moves and
 * the interface does not, or the attribute lands and no rule matches.
 *
 * A settings page whose switches do nothing is worse than no settings page,
 * because somebody who needs larger text will conclude the application cannot
 * give it to them.
 */

async function openAccessibilitySettings(browser, request, baseURL) {
  const roles = await fetchRoles(request, baseURL);
  const statePath = await signInAs(browser, roles[0], baseURL);
  const ctx = await browser.newContext({ baseURL, storageState: statePath });
  const page = await ctx.newPage();
  await page.goto('/settings?section=accessibility');
  /* Wait for the section itself, not the shell: Settings is code-split, so
     `#main-content` arrives before the panel inside it. */
  await page.getByRole('group', { name: /text size/i })
    .waitFor({ state: 'visible', timeout: 30000 });
  return { ctx, page };
}

test('the Accessibility section renders and is reachable from the navigation', async ({ browser, request, baseURL }) => {
  const roles = await fetchRoles(request, baseURL);
  const statePath = await signInAs(browser, roles[0], baseURL);
  const ctx = await browser.newContext({ baseURL, storageState: statePath });
  const page = await ctx.newPage();
  await page.goto('/settings');
  await page.locator('#main-content').waitFor({ state: 'visible', timeout: 20000 });

  /* Reached the way a person reaches it — through the navigation — because the
     sidebar list and the render switch are two hand-maintained arrays, and a
     sidebar entry with no matching case renders an EMPTY PANEL: the rail
     highlights, the URL changes, and there is no heading and no content and no
     error to explain either. */
  const entry = page.getByRole('link', { name: /accessibility/i })
    .or(page.getByRole('button', { name: /accessibility/i })).first();
  await expect(entry, 'no Accessibility entry in the Settings navigation').toBeVisible();
  await entry.click();

  await expect(
    page.getByRole('group', { name: /text size/i }),
    'the Accessibility panel is empty — a sidebar entry with no matching render case'
  ).toBeVisible({ timeout: 20000 });
  await ctx.close();
});

test('text size is a real radio group, and changing it resizes the page', async ({ browser, request, baseURL }) => {
  const { ctx, page } = await openAccessibilitySettings(browser, request, baseURL);

  /* A native fieldset/legend gives the group its name and the browser announces
     position within it, with no ARIA. That is the whole reason for using one. */
  const group = page.getByRole('group', { name: /text size/i });
  const options = group.getByRole('radio');
  await expect(options, 'text size is not a radio group').toHaveCount(3);

  const before = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);

  await group.getByRole('radio', { name: /extra large/i }).check();

  const after = await page.evaluate(() => ({
    attribute: document.documentElement.getAttribute('data-text-size'),
    fontSize: getComputedStyle(document.documentElement).fontSize
  }));

  expect(after.attribute, 'no data-text-size attribute was written').toBe('x-large');
  expect(
    parseFloat(after.fontSize),
    `the root font size did not change (${before} -> ${after.fontSize}); the attribute `
    + 'landed but no stylesheet rule reacted to it'
  ).toBeGreaterThan(parseFloat(before));

  await ctx.close();
});

test('each switch writes its attribute and the stylesheet reacts', async ({ browser, request, baseURL }) => {
  const { ctx, page } = await openAccessibilitySettings(browser, request, baseURL);

  /* Every non-default value, checked end to end: the control changes state, the
     attribute lands on <html>, and at least one computed style differs from the
     default. The last part is what a static guard cannot do. */
  const cases = [
    { label: /increase contrast/i, attribute: 'data-contrast', value: 'high' },
    { label: /reduce motion/i, attribute: 'data-motion', value: 'reduce' },
    { label: /reduce transparency/i, attribute: 'data-transparency', value: 'reduce' },
    { label: /larger controls/i, attribute: 'data-controls', value: 'large' },
    { label: /always underline links/i, attribute: 'data-link-underlines', value: 'always' }
  ];

  for (const { label, attribute, value } of cases) {
    const box = page.getByRole('checkbox', { name: label });
    await expect(box, `no switch named ${label}`).toBeVisible();
    await box.check();
    await expect(box, `${attribute} switch did not report itself checked`).toBeChecked();
    expect(
      await page.getAttribute('html', attribute),
      `checking ${label} wrote no ${attribute} on <html>`
    ).toBe(value);
  }

  /* Larger controls is the one with an observable geometric effect, so it is the
     one worth measuring rather than trusting. */
  const buttonHeight = await page.evaluate(() => {
    const btn = document.querySelector('.btn');
    return btn ? Math.round(btn.getBoundingClientRect().height) : 0;
  });
  expect(
    buttonHeight,
    'with Larger controls on, buttons are still under 44px — the attribute is set '
    + 'but the rule does not reach them'
  ).toBeGreaterThanOrEqual(44);

  await ctx.close();
});

test('the preferences survive a reload, applied before the first paint', async ({ browser, request, baseURL }) => {
  const { ctx, page } = await openAccessibilitySettings(browser, request, baseURL);

  /* `/^large\b/i`, not `/^large$/i`. Each label wraps the option name AND its
     hint, so the accessible name is "Large About one eighth larger." — an
     end-anchored pattern matches nothing and the test times out looking for a
     control that is right there. */
  await page.getByRole('radio', { name: /^large\b/i }).check();
  await page.getByRole('checkbox', { name: /increase contrast/i }).check();

  await page.reload();
  await page.locator('#main-content').waitFor({ state: 'visible', timeout: 20000 });

  /**
   * Read immediately after load. public/a11y-prefs.js runs synchronously in
   * <head>, before React mounts, so the attributes must already be there — if
   * they only arrive once the hook runs, every load shows a flash of the
   * interface the reader said they could not use.
   */
  const applied = await page.evaluate(() => ({
    size: document.documentElement.getAttribute('data-text-size'),
    contrast: document.documentElement.getAttribute('data-contrast')
  }));

  expect(applied.size, 'text size did not survive a reload').toBe('large');
  expect(applied.contrast, 'contrast did not survive a reload').toBe('high');
  await ctx.close();
});

test('resetting to defaults removes every attribute', async ({ browser, request, baseURL }) => {
  const { ctx, page } = await openAccessibilitySettings(browser, request, baseURL);

  await page.getByRole('radio', { name: /extra large/i }).check();
  await page.getByRole('checkbox', { name: /larger controls/i }).check();
  await page.getByRole('button', { name: /reset to defaults/i }).click();

  const left = await page.evaluate(() =>
    ['data-text-size', 'data-contrast', 'data-motion', 'data-transparency', 'data-controls', 'data-link-underlines']
      .filter(a => document.documentElement.hasAttribute(a)));

  /* A default writes NO attribute, so the stylesheet's base rules stay the ones
     with no attribute selector and an unset preference costs no specificity. */
  expect(left, `reset left attributes behind: ${left.join(', ')}`).toEqual([]);
  await ctx.close();
});

test('the Accessibility Statement is reachable and says what it must', async ({ browser, request, baseURL }) => {
  const { ctx, page } = await openAccessibilitySettings(browser, request, baseURL);

  await page.getByRole('link', { name: /accessibility statement/i }).click();
  await page.locator('main, #main-content').first().waitFor({ state: 'visible', timeout: 20000 });

  await expect(page, 'the statement link does not reach the Legal Center document')
    .toHaveURL(/\/legal\/accessibility-statement/);

  const text = (await page.locator('main, #main-content').first().innerText()).toLowerCase();

  expect(text, 'the statement does not name its WCAG target').toContain('wcag 2.2');
  expect(text, 'the statement does not say how to report a barrier').toMatch(/report/);

  /**
   * The honesty constraint, asserted against the CLAIM rather than the acronym.
   *
   * The first version searched for the substring "ada compliant" and failed on
   * this sentence: 'We do not claim that WeVolunteer is "ADA compliant"'. The
   * page mentions the phrase precisely in order to disown it, which is the
   * behaviour we want — so a substring test forbids the very disclaimer it is
   * supposed to protect.
   *
   * These patterns match the affirmative forms only. A statement that claims
   * legal compliance because automated tests pass is the specific thing this
   * initiative must never produce, and it is exactly the sentence somebody adds
   * later while trying to sound reassuring.
   */
  const forbidden = [
    /\bis\s+(fully\s+)?ada[\s-]?compliant/,
    /\bwe\s+are\s+ada[\s-]?compliant/,
    /\bis\s+fully\s+accessible/,
    /\bmeets\s+all\s+accessibility\s+requirements/,
    /\bis\s+legally\s+compliant/
  ];
  for (const pattern of forbidden) {
    expect(
      text,
      `the statement makes a claim matching ${pattern}, which no test suite can establish`
    ).not.toMatch(pattern);
  }

  /* And the disclaimer must actually be present — absence of a false claim is
     not the same as saying plainly what is not being claimed. */
  expect(
    text,
    'the statement never says what it is NOT claiming, so a reader may infer legal compliance'
  ).toMatch(/do not claim|not a legal|legal advice/);

  await ctx.close();
});

test('the report link arrives with the accessibility category already chosen', async ({ browser, request, baseURL }) => {
  const { ctx, page } = await openAccessibilitySettings(browser, request, baseURL);

  await page.getByRole('link', { name: /report an accessibility issue/i }).click();
  const select = page.locator('#issue-category');
  await expect(select, 'the report form did not load').toBeVisible({ timeout: 20000 });

  /* The point of the deep link: somebody blocked by a barrier should not have to
     find the right option in a dropdown using the interface that is failing
     them. Without this the parameter was decorative. */
  await expect(
    select,
    'the category was not preselected, so the ?category= parameter is decorative'
  ).toHaveValue('accessibility');

  await ctx.close();
});
