import fs from 'node:fs';
import path from 'node:path';

const AUTH_DIR = path.resolve(import.meta.dirname, '../.auth');

/**
 * Signs one role in and saves the cookie jar.
 *
 * Reused across every route rather than re-authenticating per page: with ~48
 * routes times several roles, a sign-in per visit is the difference between a
 * harness people run and one they stop running.
 *
 * The password is the seed's published one. It only ever reaches a scratch
 * database — the gate in guard.mjs is what guarantees that.
 */
export async function signInAs(browser, role, baseURL) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const statePath = path.join(AUTH_DIR, `${role.key}.json`);

  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  /* ?mode=email, not /login.
   *
   * /login renders a METHOD PICKER first — Google, Microsoft, Apple, then "Sign
   * in with email" — and the email form and the seeded demo shortcuts live
   * behind it, inside `if (mode === 'email')` (src/views/Login.jsx:979).
   * Navigating to /login and looking for a password field finds nothing and
   * times out, which reads as "sign-in is broken" rather than "you are on the
   * wrong screen". setMode('email') writes exactly this query parameter, so this
   * is the app's own way of naming that step. */
  await page.goto('/login?mode=email');
  /* Belt and braces: if the picker renders anyway, click through it. */
  const picker = page.getByRole('button', { name: /sign in with email/i });
  if (await picker.count() > 0) await picker.first().click();

  /**
   * The form, always — not the seeded one-click shortcut.
   *
   * Two reasons. The shortcut's visible text is the account's display name
   * ("Leo Chen"), which this function does not have; it has the email, so
   * matching on it was matching nothing and silently falling through. And using
   * the real form means every run exercises the login path an actual person
   * uses, which is the thing being audited.
   *
   * Locators are role-precise on purpose. getByLabel(/email/i) matched
   * `<main aria-labelledby="email-heading">` — the landmark is legitimately
   * NAMED "email" on this screen, so a label-text match finds the region before
   * the field and then fails with "Element is not an <input>". Asking for the
   * textbox by its accessible name cannot make that mistake.
   */
  await page.getByRole('textbox', { name: /email/i }).first().fill(role.email);
  await page.locator('input[type="password"]').first().fill('password123');
  await page.getByRole('button', { name: /^sign in$/i }).first().click();

  /* The signed-in shell's landmark. Waiting on a URL would pass while an error
     banner is the only thing on screen. */
  await page.locator('#main-content').waitFor({ state: 'visible', timeout: 20000 });

  await context.storageState({ path: statePath });
  await context.close();
  return statePath;
}
