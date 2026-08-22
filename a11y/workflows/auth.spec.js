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
  /* 1.3.5 Identify Input Purpose, and the practical half of 3.3.8: without
     autocomplete tokens a password manager cannot reliably fill these, so the
     person is back to typing a long secret by hand. */
  const tokens = await page.evaluate(() => ({
    email: document.querySelector('input[type="email"], input[name*="email" i]')?.getAttribute('autocomplete'),
    password: document.querySelector('input[type="password"]')?.getAttribute('autocomplete')
  }));

  expect(tokens.password, 'the password field has no autocomplete token').toBeTruthy();
  expect(tokens.email, 'the email field has no autocomplete token').toBeTruthy();
});

test('a rejected sign-in explains itself in text, not only in colour', async ({ page }) => {
  await page.goto(EMAIL_STEP);
  await page.getByRole('textbox', { name: /email/i }).first().fill('nobody@example.org');
  await page.locator('input[type="password"]').first().fill('definitely-wrong');
  await page.getByRole('button', { name: /^sign in$/i }).first().click();

  /* A live region, so it is announced without the reader having to go looking —
     4.1.3 Status Messages. A red border alone tells a screen-reader user
     nothing, and tells a colour-blind user nothing either. */
  const announced = page.locator('[role="alert"], [aria-live="assertive"], [aria-live="polite"]')
    .filter({ hasText: /\S/ }).first();
  await expect(
    announced,
    'no live region carried the sign-in error, so nothing announces the failure'
  ).toBeVisible({ timeout: 15000 });

  const text = ((await announced.textContent()) || '').trim();
  expect(text.length, 'the live region is present but empty').toBeGreaterThan(10);
});

test('focus is not lost when sign-in fails', async ({ page }) => {
  await page.goto(EMAIL_STEP);
  await page.getByRole('textbox', { name: /email/i }).first().fill('nobody@example.org');
  await page.locator('input[type="password"]').first().fill('definitely-wrong');
  await page.getByRole('button', { name: /^sign in$/i }).first().press('Enter');

  await page.locator('[role="alert"], [aria-live]').filter({ hasText: /\S/ }).first()
    .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

  const focused = await page.evaluate(() => ({
    tag: document.activeElement?.tagName || 'BODY',
    name: (document.activeElement?.getAttribute('aria-label')
      || document.activeElement?.textContent || '').trim().slice(0, 40)
  }));

  /* Focus falling to the body means the next Tab starts from the top of the
     document — the keyboard user has to walk the whole page again to retry a
     password. */
  expect(
    focused.tag,
    'focus fell to the document body after a failed sign-in, so the keyboard user restarts from the top'
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
      .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const wide = await page.evaluate(() => {
      const d = document.documentElement;
      return d.scrollWidth > d.clientWidth + 1 ? d.scrollWidth : 0;
    });
    if (wide) overflowing.push(`${path} — scrollWidth ${wide} at a 320 viewport`);
  }

  await ctx.close();
  expect(overflowing, `WCAG 1.4.10 Reflow on the auth screens:\n${overflowing.join('\n')}`).toEqual([]);
});
