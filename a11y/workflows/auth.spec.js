import { test, expect } from '@playwright/test';

/**
 * The authentication journey, keyboard only, signed out.
 *
 * Auth is where an accessibility failure is total: everything else in the
 * application is behind it, and it is the one place a person cannot work around
 * a defect by going somewhere else. It is also where security mechanisms are
 * most tempted to break accessibility.
 *
 * These run signed out on purpose. The route sweeps sign in first, which means
 * they measure /login AFTER its redirect — the defect recorded in walk.mjs — so
 * this file is the only thing that audits the sign-in page as a visitor meets it.
 */

/** The email step, which /login does not show first. */
const EMAIL_STEP = '/login?mode=email';

test('sign-in is completable with the keyboard alone', async ({ page }) => {
  await page.goto(EMAIL_STEP);

  /* Fields are reached by accessible name, never by counting Tabs. A count
     encodes the current layout, breaks on any change, and teaches people to
     delete the test instead of reading it. */
  const email = page.getByRole('textbox', { name: /email/i }).first();
  await expect(email, 'no field on the email step is named "email"').toBeVisible({ timeout: 15000 });

  await email.focus();
  await expect(email, 'the email field cannot take focus').toBeFocused();
  await page.keyboard.type('leo.chen@example.com');

  /* Tab, not click: this is the assertion that the password field is the next
     stop and that nothing unreachable sits between them. */
  await page.keyboard.press('Tab');
  await page.keyboard.type('password123');
  await page.keyboard.press('Enter');

  await expect(
    page.locator('#main-content'),
    'Enter in the password field did not submit the form — a keyboard user has to find the button'
  ).toBeVisible({ timeout: 20000 });
});

test('the password field accepts paste, so a password manager works', async ({ page }) => {
  await page.goto(EMAIL_STEP);
  const pw = page.locator('input[type="password"]').first();
  await expect(pw).toBeVisible({ timeout: 15000 });

  const blocked = await pw.evaluate(el => {
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    /* defaultPrevented is what WCAG 2.2 3.3.8 cares about here: a handler that
       cancels paste is what breaks a password manager, and a password manager is
       how a great many people with disabilities sign in at all. */
    return ev.defaultPrevented;
  });

  expect(
    blocked,
    'a handler cancelled the paste event. This breaks password managers and is a '
    + 'WCAG 2.2 3.3.8 Accessible Authentication failure'
  ).toBe(false);
});

test('the password field is autofillable', async ({ page }) => {
  await page.goto(EMAIL_STEP);
  /* Wait for the field before reading its attributes. Without this the evaluate
     raced the render, getElementById returned null, and the test reported "no
     autocomplete token" about a field that has one — a failure of the test that
     reads exactly like a defect in the app. */
  await page.locator('#login-password').waitFor({ state: 'visible', timeout: 15000 });
  /* 1.3.5 Identify Input Purpose, and the practical half of 3.3.8: without
     autocomplete tokens a password manager cannot reliably fill these, so the
     person is back to typing a long secret by hand. */
  /* The identifier field is `type="text" name="username"` — this form accepts a
     username as well as an address. Selecting on type=email found nothing, so the
     first version of this test failed for its own reason rather than the app's. */
  const tokens = await page.evaluate(() => ({
    identifier: document.getElementById('login-identifier')?.getAttribute('autocomplete'),
    password: document.getElementById('login-password')?.getAttribute('autocomplete')
  }));

  expect(tokens.password, 'the password field has no autocomplete token').toBe('current-password');
  expect(tokens.identifier, 'the identifier field has no autocomplete token').toBe('username');
});

test('Tab goes from the identifier straight to the password field', async ({ page }) => {
  /**
   * WCAG 2.4.3 Focus Order, and the reason this file earns its place.
   *
   * The "Forgot?" control sits in the password field's LABEL ROW, which put it
   * between the two inputs in DOM order. Typing an email, pressing Tab, typing a
   * password and pressing Enter — the sequence every keyboard user performs —
   * landed on "Forgot?", swallowed the password keystrokes, then activated it:
   * the person arrives on "Reset your password" having lost what they typed, with
   * no error and no explanation of what happened.
   *
   * Found by a keyboard test doing exactly that and ending up on the wrong page.
   * Nothing else would have caught it: every control is named, every field is
   * labelled, and axe has nothing to say about the order two correct elements
   * appear in.
   */
  await page.goto(EMAIL_STEP);
  await page.getByRole('textbox', { name: /email/i }).first().focus();
  await page.keyboard.press('Tab');

  const landed = await page.evaluate(() => ({
    id: document.activeElement?.id || '',
    tag: document.activeElement?.tagName,
    name: (document.activeElement?.textContent || '').trim().slice(0, 30)
  }));

  expect(
    landed.id,
    `Tab from the identifier landed on ${landed.tag} "${landed.name}" instead of the `
    + 'password field. A keyboard user typing their password now types it into '
    + 'nothing, and Enter leaves the sign-in flow.'
  ).toBe('login-password');
});

test('a rejected sign-in explains itself in text, and says which field', async ({ page }) => {
  /**
   * 3.3.1 Error Identification, satisfied by ASSOCIATION rather than by a live
   * region — which is what this form does, and is the stronger choice.
   *
   * The first version of this test demanded `[role="alert"]` and failed. The test
   * was wrong. Login moves focus to the field that failed, and that field's
   * `aria-describedby` points at the error text, so a screen reader announces the
   * field, its label and the reason together. For a single-field error that beats
   * announcing into a live region elsewhere on the page, because it also puts the
   * cursor where the fix has to happen.
   *
   * So what matters is: the error exists as text, and it is programmatically tied
   * to the field it is about.
   */
  await page.goto(EMAIL_STEP);
  await page.getByRole('textbox', { name: /email/i }).first().fill('nobody@example.org');
  await page.locator('#login-password').fill('definitely-wrong');
  await page.getByRole('button', { name: /^sign in$/i }).first().click();

  const described = page.locator('[aria-invalid="true"][aria-describedby]').first();
  await expect(
    described,
    'no field was marked aria-invalid with a description after a rejected sign-in, '
    + 'so nothing connects the error to the field it is about'
  ).toBeVisible({ timeout: 15000 });

  const message = await described.evaluate(el => {
    const id = el.getAttribute('aria-describedby');
    return (document.getElementById(id)?.textContent || '').trim();
  });
  expect(message.length, 'the error description is empty, so the association points at nothing')
    .toBeGreaterThan(5);
});

test('focus lands somewhere useful when sign-in fails', async ({ page }) => {
  /**
   * Submitting disables the button (`disabled={loading}`), and a disabled element
   * loses focus — so without something deliberately taking it, focus falls to the
   * document body and the next Tab starts from the top of the page. Login handles
   * that by focusing the field that failed.
   *
   * Asserted as "not the body" rather than naming a field, because focusing the
   * identifier is equally correct when that is what was wrong. The failure worth
   * catching is focus going nowhere.
   */
  await page.goto(EMAIL_STEP);
  await page.getByRole('textbox', { name: /email/i }).first().fill('nobody@example.org');
  await page.locator('#login-password').fill('definitely-wrong');
  await page.getByRole('button', { name: /^sign in$/i }).first().press('Enter');

  /* Wait for the form to have finished failing, so this does not race the
     re-render that re-enables the button. */
  await page.locator('[aria-invalid="true"]').first()
    .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

  const focused = await page.evaluate(() => ({
    tag: document.activeElement?.tagName || 'BODY',
    id: document.activeElement?.id || ''
  }));

  expect(
    focused.tag,
    'focus fell to the document body after a failed sign-in, so the keyboard user '
    + 'restarts from the top of the page to try again'
  ).not.toBe('BODY');
});

test('every auth screen names its own controls', async ({ page }) => {
  for (const path of ['/login', EMAIL_STEP, '/signup', '/welcome']) {
    await page.goto(path);
    await page.locator('main, #main-content, [role="main"]').first()
      .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

    const findings = await page.evaluate(() => {
      const out = { nameless: [], headings: 0 };
      for (const el of document.querySelectorAll('a[href], button, input:not([type="hidden"])')) {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const labelledBy = el.getAttribute('aria-labelledby');
        const name = (
          el.getAttribute('aria-label')
          || (labelledBy && document.getElementById(labelledBy)?.textContent)
          || (el.labels?.[0]?.textContent)
          || el.textContent
          || el.getAttribute('title')
          || ''
        ).trim();
        if (!name) out.nameless.push(el.outerHTML.slice(0, 110).replace(/\s+/g, ' '));
      }
      out.headings = document.querySelectorAll('h1').length;
      return out;
    });

    expect(
      findings.nameless,
      `WCAG 4.1.2 — unnamed controls on ${path}:\n${findings.nameless.join('\n')}`
    ).toEqual([]);
    /* These views render OUTSIDE the signed-in shell, so each must carry its own
       h1 — src/headingLevels.test.js allowlists them for exactly that reason. */
    expect(findings.headings, `${path} has ${findings.headings} h1 elements, expected 1`).toBe(1);
  }
});

test('the signed-out pages reflow at 320px', async ({ browser, baseURL }) => {
  /* Auth at 320 is not a corner case: it is a phone in a school corridor, and it
     is the one page somebody cannot skip. */
  const ctx = await browser.newContext({ baseURL, viewport: { width: 320, height: 512 } });
  const page = await ctx.newPage();
  const overflowing = [];

  for (const path of ['/login', EMAIL_STEP, '/signup', '/welcome']) {
    await page.goto(path);
    await page.locator('main, #main-content, [role="main"]').first()
      .waitFor({ state: 'visible', timeout: 15000 });
    /* An empty document trivially has scrollWidth === clientWidth, so without
       this the test reported "no overflow" — and passed — on a page that failed
       to render at all. The swallowed wait above used to make that silent. */
    const state = await page.evaluate(() => {
      const d = document.documentElement;
      const main = document.querySelector('main, #main-content, [role="main"]');
      return {
        wide: d.scrollWidth > d.clientWidth + 1 ? d.scrollWidth : 0,
        text: (main?.innerText || '').trim().length
      };
    });
    expect(state.text, `${path} rendered no text at 320px, so its reflow result is meaningless`)
      .toBeGreaterThan(20);
    if (state.wide) overflowing.push(`${path} — scrollWidth ${state.wide} at a 320 viewport`);
  }

  await ctx.close();
  expect(overflowing, `WCAG 1.4.10 Reflow on the auth screens:\n${overflowing.join('\n')}`).toEqual([]);
});
