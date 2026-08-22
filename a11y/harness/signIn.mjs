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

  /* The seeded shortcut when it is offered, because it is one click and cannot
     mistype a password. Falling back to the form matters: the shortcut renders
     only when the server returns demo accounts, and a role could be seeded
     without one. */
  const shortcut = page.locator('.auth-demo-btn', { hasText: role.email.split('@')[0] }).first();
  if (await shortcut.count() > 0) {
    await shortcut.click();
  } else {
    await page.getByLabel(/email/i).first().fill(role.email);
    await page.getByLabel(/password/i).first().fill('password123');
    await page.getByRole('button', { name: /^sign in$/i }).click();
  }

  /* The signed-in shell's landmark. Waiting on a URL would pass while an error
     banner is the only thing on screen. */
  await page.locator('#main-content').waitFor({ state: 'visible', timeout: 20000 });

  await context.storageState({ path: statePath });
  await context.close();
  return statePath;
}
