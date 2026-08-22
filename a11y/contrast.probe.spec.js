import { test } from '@playwright/test';
import { forEachRoute } from './harness/walk.mjs';
import AxeBuilder from '@axe-core/playwright';

/**
 * Asserts nothing, deliberately — this is a diagnostic that turns axe's
 * color-contrast hits into the numbers needed to FIX them: the computed
 * foreground, the computed background, the measured ratio, the required ratio,
 * and the CSS custom property behind the colour.
 *
 * axe reports "this element fails". A fix needs to know which TOKEN is wrong,
 * because recolouring an element is a patch and recolouring a token is a fix.
 */
async function dumpContrast(page, label, out) {
  const results = await new AxeBuilder({ page })
    .withRules(['color-contrast'])
    .analyze();

  for (const v of results.violations) {
    for (const n of v.nodes) {
      const data = n.any?.[0]?.data || {};
      const selector = Array.isArray(n.target) ? n.target.join(' ') : String(n.target);
      const declared = await page.evaluate(sel => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const s = getComputedStyle(el);
        /* The inline style is where a var() reference survives; the computed
           style has already resolved it to rgb(). Both matter: one names the
           token, the other gives the value that failed. */
        return {
          inline: el.getAttribute('style') || '',
          cls: (el.className?.toString?.() || '').slice(0, 70),
          color: s.color,
          background: s.backgroundColor,
          size: `${s.fontSize}/${s.fontWeight}`
        };
      }, selector).catch(() => null);

      out.push({
        label,
        selector,
        ratio: data.contrastRatio,
        needed: data.expectedContrastRatio,
        fg: data.fgColor,
        bg: data.bgColor,
        cls: declared?.cls,
        inline: declared?.inline,
        size: declared?.size
      });
    }
  }
}

test('report: contrast detail, signed in', async ({ browser, request, baseURL }) => {
  test.setTimeout(20 * 60 * 1000);
  const out = [];
  const { redirected } = await forEachRoute(
    { browser, request, baseURL },
    { roles: 'all' },
    async (page, route, role) => dumpContrast(page, `${route.path}::${role.key}`, out)
  );
  console.log('REDIRECTED (not measured):\n' + redirected.join('\n'));
  console.log('\nCONTRAST=' + JSON.stringify(out));
});

test('report: contrast detail, signed out', async ({ browser, request, baseURL }) => {
  test.setTimeout(20 * 60 * 1000);
  const out = [];
  const { unreachable, redirected, visited } = await forEachRoute(
    { browser, request, baseURL },
    { signedOut: true },
    async (page, route) => dumpContrast(page, `${route.path}::signed-out`, out)
  );
  console.log('signed-out visited: ' + visited.join(', '));
  console.log('signed-out unreachable: ' + unreachable.join(', '));
  console.log('signed-out redirected: ' + redirected.join(', '));
  console.log('\nCONTRAST=' + JSON.stringify(out));
});
