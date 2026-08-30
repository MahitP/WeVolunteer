import { test, expect } from '@playwright/test';

/**
 * Proves the harness itself works before any accessibility assertion depends on
 * it.
 *
 * Everything downstream signs in and navigates. If sign-in silently fails, every
 * later spec audits the login page while reporting the route it meant to visit —
 * a whole run of confident, wrong results, all of them green or all of them
 * failing for one reason that looks like forty. That is the specific failure
 * this exists to make loud.
 */
test('the demo sign-in shortcut reaches a signed-in shell', async ({ page }) => {
  /* ?mode=email because /login shows a method picker first, and the seeded
     shortcuts live behind "Sign in with email" (src/views/Login.jsx:979). */
  await page.goto('/login?mode=email');

  const demo = page.locator('.auth-demo-btn').first();
  await expect(demo, 'no demo sign-in shortcut — is DEMO_MODE=true and the database seeded?')
    .toBeVisible({ timeout: 15000 });
  await demo.click();

  /* The shell's landmark, and its single h1 — which src/headingLevels.test.js
     proves every route has exactly one of. Their presence together is what
     "signed in" means structurally, where a URL check would pass while an error
     banner is the only thing on screen. */
  await expect(page.locator('#main-content')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
});

test('the skip link is the first thing a keyboard reaches in the shell', async ({ page }) => {
  await page.goto('/login?mode=email');
  await page.locator('.auth-demo-btn').first().click();
  await page.locator('#main-content').waitFor({ state: 'visible', timeout: 15000 });

  /* One Tab from a fresh document must land on the skip link: it is the first
     focusable node in App.jsx's shell (App.jsx:1627). If this ever needs two
     Tabs, something focusable was inserted above it and every keyboard user now
     passes through that first. */
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: /skip to main content/i })).toBeFocused();
});
