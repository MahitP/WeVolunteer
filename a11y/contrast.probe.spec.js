import { test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { fetchRoles } from './harness/roles.mjs';
import { signInAs } from './harness/signIn.mjs';

/**
 * Asserts nothing, deliberately — a diagnostic that turns axe's color-contrast
 * hits into the numbers needed to FIX them: the computed foreground, the
 * computed background, the measured ratio, and the inline style or class that
 * chose the colour.
 *
 * axe says "this element fails". A fix needs to know which TOKEN is wrong,
 * because recolouring an element is a patch and recolouring a token is a fix.
 *
 * Scoped to the pages the full sweep found violations on, rather than repeating
 * all 192 route/role pairs. The full sweep is the inventory; this is the
 * follow-up that makes its rows actionable, and a diagnostic nobody waits for is
 * a diagnostic nobody runs.
 */
/**
 * Kills animation and transition before measuring.
 *
 * This is not a convenience — it is the difference between a real finding and a
 * fabricated one. Entrance animations in this stylesheet run 120-300ms
 * (`--t-fast`, `--t-mid`, and several literal 200-300ms fades), and an element
 * mid-fade has a COMPOSITED colour lighter than the token it was given. Measured
 * 250ms after the landmark appeared, axe reported the primary button's
 * background as #3b8668 when the token is #0f6b45 — white on the token is
 * 6.54:1 and passes, white on the mid-fade composite is 4.29:1 and fails.
 *
 * Every one of those would have been reported as a contrast defect, and fixing
 * them would have meant darkening a palette that was already conformant. That is
 * the "optimise for the appearance of accessibility" failure in its purest form:
 * a scanner number treated as a fact about the product.
 */
const NO_MOTION = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

async function dump(page, label, out) {
  await page.addStyleTag({ content: NO_MOTION });
  /* One frame for the settled styles to apply before axe reads them. */
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  for (const v of results.violations) {
    for (const n of v.nodes) {
      const d = n.any?.[0]?.data || {};
      out.push({
        label,
        ratio: d.contrastRatio,
        needed: d.expectedContrastRatio,
        fg: d.fgColor,
        bg: d.bgColor,
        size: `${d.fontSize || '?'} ${d.fontWeight || ''}`.trim(),
        html: (n.html || '').slice(0, 150).replace(/\s+/g, ' ')
      });
    }
  }
}

test('report: contrast on the signed-out pages', async ({ browser, baseURL }) => {
  test.setTimeout(6 * 60 * 1000);
  const out = [];
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  /* These were never measured before: the sweeps sign in first, and every one of
     these redirects to the dashboard once authenticated. */
  for (const path of ['/login', '/login?mode=email', '/signup', '/welcome', '/legal', '/about']) {
    await page.goto(path);
    await page.locator('main, #main-content, [role="main"]').first()
      .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(200);
    await dump(page, `${path}::signed-out`, out);
  }
  await ctx.close();
  console.log('CONTRAST=' + JSON.stringify(out));
});

test('report: contrast on the pages the sweep flagged, signed in', async ({ browser, request, baseURL }) => {
  test.setTimeout(10 * 60 * 1000);
  const out = [];
  const roles = await fetchRoles(request, baseURL);
  for (const role of roles) {
    const statePath = await signInAs(browser, role, baseURL);
    const ctx = await browser.newContext({ baseURL, storageState: statePath });
    const page = await ctx.newPage();
    for (const path of ['/', '/welly']) {
      await page.goto(path);
      await page.locator('#main-content').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(250);
      await dump(page, `${path}::${role.key}`, out);
    }
    await ctx.close();
  }
  console.log('CONTRAST=' + JSON.stringify(out));
});
