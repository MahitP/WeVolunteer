import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DatabaseSync } from 'node:sqlite';
import { fetchRoles } from '../harness/roles.mjs';
import { signInAs } from '../harness/signIn.mjs';

/**
 * The legal change notice and the dialog that cannot be dismissed.
 *
 * ── Why these need their own spec ──
 *
 * Neither surface is a URL, and neither appears for a seeded account: the
 * banner and the dialog are both consequences of a published revision that the
 * signed-in reader is behind on, and the demo seed publishes none. So the route
 * sweep visits every page in the product without either of them ever having
 * been rendered, let alone measured.
 *
 * That gap matters more for these two than for most. The banner is new markup
 * in the shell, above every page. The dialog invented a treatment — a brand
 * green header band on `--ink-inv` — and a colour pairing nobody has run
 * through a contrast checker is exactly the kind of thing that ships looking
 * fine to the person who chose it.
 *
 * The dialog also takes a deliberate exception to the APG's modal pattern: it
 * does not close on Escape, because there is nothing to close to. An exception
 * like that is only defensible while the two real answers stay operable from
 * the keyboard, so the cases below assert the exception AND the thing that
 * makes it safe.
 *
 * ── Why the fixture writes to the database ──
 *
 * Publishing a revision through the product needs `legal.edit` and a step-up
 * re-authentication, which is a great deal of machinery to arrange in order to
 * arrive at a banner. `WEV_DB_PATH` is a scratch database — `guard.mjs` refuses
 * to start otherwise — and `legal_document_revisions` is the table the editor
 * writes, so inserting a row is the same state by a shorter path.
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

/**
 * The scratch database the harness is running against.
 *
 * Opened per call rather than held: the server owns this file and the spec is
 * a second writer, so the shorter the handle lives the better.
 */
function withDb(fn) {
  const path = process.env.WEV_DB_PATH;
  expect(path, 'WEV_DB_PATH must be set — bin/a11y-audit.mjs passes it').toBeTruthy();
  const db = new DatabaseSync(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Puts one account behind on one document.
 *
 * `effectiveAt` decides which surface carries it, which is the whole point of
 * the two cases below: a date in the past on a MAJOR version is the mandatory
 * dialog, and anything else is the banner.
 */
function publishAndFallBehind(userId, { slug, version, effectiveAt }) {
  withDb((db) => {
    const now = new Date().toISOString();
    db.prepare('DELETE FROM legal_document_revisions WHERE slug = ?').run(slug);
    db.prepare('DELETE FROM legal_change_notices WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM legal_acceptances WHERE user_id = ? AND document_slug = ?')
      .run(userId, slug);

    db.prepare(`INSERT INTO legal_acceptances
      (id, user_id, document_slug, version, content_hash, accepted_at, method, context)
      VALUES (?, ?, ?, '1.0', ?, ?, 'signup', 'a11y-fixture')`)
      .run(`acc-a11y-${slug}-${userId}`, userId, slug, `hash-${slug}-1.0`, now);

    db.prepare(`INSERT INTO legal_document_revisions
      (slug, version, body, content_hash, effective_at, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, NULL)`)
      .run(
        slug, version,
        'We may now share your attendance record with your school district '
        + 'so that it can verify service hours directly.',
        `hash-${slug}-${version}`, effectiveAt, now
      );
  });
}

function clearFixture(userId, slug) {
  withDb((db) => {
    db.prepare('DELETE FROM legal_document_revisions WHERE slug = ?').run(slug);
    db.prepare('DELETE FROM legal_change_notices WHERE user_id = ?').run(userId);
    db.prepare("DELETE FROM legal_acceptances WHERE context = 'a11y-fixture'").run();
    db.prepare("DELETE FROM legal_acceptances WHERE method = 'reconsent'").run();
  });
}

/**
 * A signed-in student page, with the fixture in place.
 *
 * `quietLocation` pre-dismisses the location opt-in for the tab. The notice
 * slot shows ONE banner at a time in priority order, so with a legal change
 * pending the location offer is suppressed — and reappears the moment the legal
 * notice is dismissed. That is the designed behaviour and it is asserted on its
 * own below; a test measuring the empty slot has to silence the offer first or
 * it is measuring the wrong banner. (Found the hard way: the first version of
 * the gap case waited for `.app-notice` to detach and timed out staring at
 * `region "Use your location"`.)
 */
async function openWith(browser, request, baseURL, fixture, { quietLocation = false } = {}) {
  const roles = await fetchRoles(request, baseURL);
  const role = roles.find(r => /student/i.test(r.key)) ?? roles[0];
  const statePath = await signInAs(browser, role, baseURL);

  const ctx = await browser.newContext({ baseURL, storageState: statePath });
  if (quietLocation) {
    /* The key `LocationContext` writes on "not now". Per tab, deliberately, so
       an init script is the right place for it. */
    await ctx.addInitScript(() => {
      try { sessionStorage.setItem('wv_location_dismissed', 'true'); } catch { /* private mode */ }
    });
  }
  const page = await ctx.newPage();

  /* The id, from the application rather than from a literal: seeded ids are
     strings like `user-student-1` and a guess that misses would leave the
     fixture attached to nobody and every assertion below vacuous. */
  await page.goto('/');
  const userId = await page.evaluate(async () => {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    return (await res.json()).id;
  });
  expect(userId, 'the signed-in account has no id').toBeTruthy();

  publishAndFallBehind(userId, fixture);

  await page.goto('/');
  await page.addStyleTag({ content: SETTLE });
  return { ctx, page, userId };
}

test.describe('the ordinary change notice', () => {
  const FIXTURE = { slug: 'privacy-policy', version: '1.1.0', effectiveAt: '2026-01-01' };

  test('is a named region that axe is happy with, with reachable controls', async ({ browser, request, baseURL }) => {
    const { ctx, page, userId } = await openWith(browser, request, baseURL, FIXTURE);

    try {
      const banner = page.locator('.app-notice');
      await banner.waitFor({ state: 'visible', timeout: 30000 });

      /* A landmark, and named — an unlabelled `region` is dropped from most
         screen readers' landmark lists, which would make the banner
         unreachable by the navigation method it depends on. */
      expect(await banner.getAttribute('role')).toBe('region');
      expect(await banner.getAttribute('aria-label')).toBeTruthy();

      const results = await new AxeBuilder({ page })
        .withTags(AXE_TAGS)
        .include('.app-notices')
        .analyze();
      expect(
        results.violations.map(v => `${v.id}: ${v.nodes.length} node(s)`),
        JSON.stringify(results.violations, null, 2)
      ).toEqual([]);

      /**
       * Both controls, and the `X` in particular.
       *
       * It renders a 15px icon and reaches a usable target only because of
       * `btn-icon`, which carries the 44px WIDTH floor on a phone. This was a
       * 37x44 sliver at 320px before that class was added, and the static
       * touch-target guard could not see it — the class that fixes it was
       * simply absent, so there was nothing for a stylesheet check to measure.
       */
      const controls = await page.evaluate(() =>
        [...document.querySelectorAll('.app-notices a, .app-notices button')].map((el) => {
          const r = el.getBoundingClientRect();
          return {
            name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
        }));

      expect(controls.length, 'the banner has no interactive controls').toBeGreaterThan(1);
      for (const c of controls) {
        expect(c.h, `"${c.name}" is ${c.w}x${c.h}`).toBeGreaterThanOrEqual(24);
        expect(c.w, `"${c.name}" is ${c.w}x${c.h}`).toBeGreaterThanOrEqual(24);
      }
    } finally {
      clearFixture(userId, FIXTURE.slug);
      await ctx.close();
    }
  });

  test('gives way to the location offer once it is dismissed', async ({ browser, request, baseURL }) => {
    /**
     * The priority ladder, in the browser.
     *
     * A legal change outranks the location opt-in, and one banner shows at a
     * time — two strips above every page is the pile this feature exists to
     * avoid. The offer is delayed rather than lost, and "delayed" means exactly
     * this: it is there as soon as the louder notice has been dealt with.
     */
    const { ctx, page, userId } = await openWith(browser, request, baseURL, FIXTURE);

    try {
      const banner = page.locator('.app-notice');
      await banner.waitFor({ state: 'visible', timeout: 30000 });
      expect(await banner.count()).toBe(1);
      expect(await banner.getAttribute('aria-label')).toBe('Legal document update');

      await page.getByRole('button', { name: /I have seen/i }).click();

      await expect(page.locator('.app-notice')).toHaveAttribute('aria-label', 'Use your location');
      expect(await page.locator('.app-notice').count(), 'still one banner, not two').toBe(1);
    } finally {
      clearFixture(userId, FIXTURE.slug);
      await ctx.close();
    }
  });

  test('leaves no gap above the page once the slot is empty', async ({ browser, request, baseURL }) => {
    /**
     * The layout property, measured rather than asserted from CSS.
     *
     * The spacing between the notice slot and the page belongs to the slot, and
     * the slot is removed entirely when it has nothing in it. So the page's
     * content has to sit at exactly `main.page`'s padding edge afterwards — the
     * same place it sits when there was never a banner at all. An empty
     * `.app-notices` still carrying its bottom margin is the awkward strip.
     */
    const { ctx, page, userId } = await openWith(
      browser, request, baseURL, FIXTURE, { quietLocation: true }
    );

    try {
      await page.locator('.app-notice').waitFor({ state: 'visible', timeout: 30000 });

      const before = await page.evaluate(() => {
        const main = document.querySelector('main.page');
        return {
          slots: document.querySelectorAll('.app-notices').length,
          contentTop: Math.round(main.lastElementChild.getBoundingClientRect().top),
        };
      });
      expect(before.slots).toBe(1);

      await page.getByRole('button', { name: /I have seen/i }).click();
      await page.locator('.app-notice').waitFor({ state: 'detached', timeout: 30000 });

      const after = await page.evaluate(() => {
        const main = document.querySelector('main.page');
        const cs = getComputedStyle(main);
        return {
          slots: document.querySelectorAll('.app-notices').length,
          paddingTop: parseFloat(cs.paddingTop),
          mainTop: Math.round(main.getBoundingClientRect().top),
          contentTop: Math.round(main.lastElementChild.getBoundingClientRect().top),
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        };
      });

      /* No node, so no margin left behind. */
      expect(after.slots).toBe(0);
      expect(after.contentTop).toBeLessThan(before.contentTop);
      expect(
        after.contentTop,
        "the page content must sit exactly at main.page's padding edge"
      ).toBe(after.mainTop + Math.round(after.paddingTop));
      expect(after.horizontalOverflow).toBe(false);
    } finally {
      clearFixture(userId, FIXTURE.slug);
      await ctx.close();
    }
  });
});

test.describe('the location opt-in, in the same slot', () => {
  /**
   * The banner that set the visual language, re-measured after it moved onto
   * the shared primitive.
   *
   * Its markup and classes changed — `.location-prompt*` became `.app-notice*`
   * inside `NoticeBanner` — and the bottom margin it used to carry itself moved
   * to the slot. Nothing about how it looks changed, which is precisely why a
   * regression here would be invisible in review: the same two lines and the
   * same X, with the space above the dashboard left behind.
   */
  test('disappears the same way when the permission is GRANTED, not dismissed', async ({ browser, request, baseURL }) => {
    /**
     * The second of the two ways this banner goes away, and the one a unit test
     * cannot reach.
     *
     * `dismissPrompt` and a successful `getCurrentPosition` both clear
     * `showPrompt`, so they share a code path — but "they share a code path" is
     * an argument, not a measurement, and the brief asks about both. Playwright
     * can grant the permission and supply a position, so the real one is
     * available: the banner is offered while the permission is unresolved,
     * pressing "Use my location" resolves it, and the page has to move up to the
     * topbar exactly as it does on a dismissal.
     */
    const roles = await fetchRoles(request, baseURL);
    const role = roles.find(r => /student/i.test(r.key)) ?? roles[0];
    const statePath = await signInAs(browser, role, baseURL);

    /* Deliberately created WITHOUT the permission: granted at load time,
       `LocationContext` uses the position silently and never offers the banner,
       which is a different (also correct) behaviour. */
    const ctx = await browser.newContext({ baseURL, storageState: statePath });
    const page = await ctx.newPage();

    try {
      await page.goto('/');
      await page.addStyleTag({ content: SETTLE });

      const banner = page.locator('.app-notice');
      await banner.waitFor({ state: 'visible', timeout: 30000 });
      expect(await banner.getAttribute('aria-label')).toBe('Use your location');

      const before = await page.evaluate(() => Math.round(
        document.querySelector('main.page').lastElementChild.getBoundingClientRect().top
      ));

      /* Somewhere in the seed's own county, so distance sorting has something
         sensible to do with it. The value does not matter to this assertion. */
      await ctx.grantPermissions(['geolocation'], { origin: baseURL });
      await ctx.setGeolocation({ latitude: 40.7357, longitude: -74.1724 });

      await page.getByRole('button', { name: /use my location/i }).click();
      await page.locator('.app-notices').waitFor({ state: 'detached', timeout: 30000 });

      const after = await page.evaluate(() => {
        const main = document.querySelector('main.page');
        return {
          slots: document.querySelectorAll('.app-notices').length,
          paddingTop: parseFloat(getComputedStyle(main).paddingTop),
          mainTop: Math.round(main.getBoundingClientRect().top),
          contentTop: Math.round(main.lastElementChild.getBoundingClientRect().top),
        };
      });

      expect(after.slots).toBe(0);
      expect(after.contentTop).toBeLessThan(before);
      expect(after.contentTop).toBe(after.mainTop + Math.round(after.paddingTop));
    } finally {
      await ctx.close();
    }
  });

  test('disappears cleanly, with the page moving up to meet the topbar', async ({ browser, request, baseURL }) => {
    const roles = await fetchRoles(request, baseURL);
    const role = roles.find(r => /student/i.test(r.key)) ?? roles[0];
    const statePath = await signInAs(browser, role, baseURL);
    const ctx = await browser.newContext({ baseURL, storageState: statePath });
    const page = await ctx.newPage();

    try {
      await page.goto('/');
      await page.addStyleTag({ content: SETTLE });

      const banner = page.locator('.app-notice');
      await banner.waitFor({ state: 'visible', timeout: 30000 });
      expect(await banner.getAttribute('aria-label')).toBe('Use your location');

      /* The banner carries no bottom margin of its own — that belongs to the
         slot, which is what makes it impossible to leave behind. */
      expect(await banner.evaluate(el => getComputedStyle(el).marginBottom)).toBe('0px');

      const before = await page.evaluate(() => Math.round(
        document.querySelector('main.page').lastElementChild.getBoundingClientRect().top
      ));

      await page.getByRole('button', { name: /not now/i }).click();
      await page.locator('.app-notices').waitFor({ state: 'detached', timeout: 30000 });

      const after = await page.evaluate(() => {
        const main = document.querySelector('main.page');
        return {
          paddingTop: parseFloat(getComputedStyle(main).paddingTop),
          mainTop: Math.round(main.getBoundingClientRect().top),
          contentTop: Math.round(main.lastElementChild.getBoundingClientRect().top),
        };
      });

      expect(after.contentTop).toBeLessThan(before);
      expect(after.contentTop).toBe(after.mainTop + Math.round(after.paddingTop));

      /* And navigating does not bring the strip back: the dismissal is
         remembered for the tab, so the slot stays absent rather than
         reappearing empty. */
      await page.goto('/discover');
      await page.locator('#main-content').waitFor({ state: 'visible', timeout: 30000 });
      expect(await page.locator('.app-notices').count()).toBe(0);
    } finally {
      await ctx.close();
    }
  });
});

test.describe('the mandatory acceptance dialog', () => {
  const FIXTURE = { slug: 'terms-of-service', version: '2.0.0', effectiveAt: '2026-01-01' };

  test('is an alertdialog axe is happy with, named and described by its own text', async ({ browser, request, baseURL }) => {
    const { ctx, page, userId } = await openWith(browser, request, baseURL, FIXTURE);

    try {
      const dialog = page.locator('[role="alertdialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 30000 });

      const semantics = await dialog.evaluate((el) => {
        const labelledBy = el.getAttribute('aria-labelledby');
        const describedBy = el.getAttribute('aria-describedby');
        return {
          modal: el.getAttribute('aria-modal'),
          name: labelledBy ? document.getElementById(labelledBy)?.textContent : null,
          description: describedBy ? document.getElementById(describedBy)?.textContent : null,
          focusInside: el.contains(document.activeElement),
          activeTag: document.activeElement?.tagName,
        };
      });

      expect(semantics.modal).toBe('true');
      expect(semantics.name).toMatch(/Please accept the updated Terms of Service/);
      expect(semantics.description).toMatch(/we need your agreement/i);
      expect(semantics.focusInside).toBe(true);
      /* The heading, not the first button — otherwise arriving by keyboard and
         pressing Space signs somebody out. */
      expect(semantics.activeTag).toBe('H2');

      /**
       * axe over the dialog, and the green header band is why.
       *
       * `--ink-inv` and `--ink-inv-3` on `--brand-panel-bg` are the pairing the
       * dashboard's next-shift card uses, and the token comments record a
       * measured 4.81:1 for the dimmed one. This checks it where it is actually
       * rendered rather than trusting the arithmetic in a comment.
       */
      const results = await new AxeBuilder({ page })
        .withTags(AXE_TAGS)
        .include('[role="alertdialog"]')
        .analyze();
      expect(
        results.violations.map(v => `${v.id}: ${v.nodes.length} node(s)`),
        JSON.stringify(results.violations, null, 2)
      ).toEqual([]);
    } finally {
      clearFixture(userId, FIXTURE.slug);
      await ctx.close();
    }
  });

  test('refuses Escape, contains Tab, and keeps the page behind it inert', async ({ browser, request, baseURL }) => {
    const { ctx, page, userId } = await openWith(browser, request, baseURL, FIXTURE);

    try {
      const dialog = page.locator('[role="alertdialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 30000 });

      /* The deliberate exception to the APG's modal pattern. There is nothing
         to close to, and a key that appears to work and does not is how
         somebody concludes the page is broken. */
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();

      /* And the thing that keeps it from being a keyboard trap under WCAG
         2.1.2: every answer is in the tab cycle, and the cycle stays inside. */
      const walk = [];
      for (let i = 0; i < 5; i += 1) {
        await page.keyboard.press('Tab');
        walk.push(await page.evaluate(() => {
          const d = document.querySelector('[role="alertdialog"]');
          const el = document.activeElement;
          return { name: el?.textContent?.trim().slice(0, 24), inside: d.contains(el) };
        }));
      }

      expect(walk.every(step => step.inside), JSON.stringify(walk)).toBe(true);
      const names = walk.map(s => s.name).join(' | ');
      expect(names).toMatch(/Sign out/);
      expect(names).toMatch(/Read the document/);
      expect(names).toMatch(/Accept and continue/);

      /* `aria-modal="true"` is a promise that nothing outside is reachable. The
         overlay is what has to keep it for everybody else — the APG is blunt
         that a dialog claiming modality without behaving that way cuts
         assistive-technology users off from content that is still live. */
      const inert = await page.evaluate(() => {
        const navControl = document.querySelector('nav.nav a, nav.nav button');
        const r = navControl.getBoundingClientRect();
        const hit = document.elementFromPoint(
          Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)
        );
        return {
          covered: Boolean(hit?.classList?.contains('modal-overlay')),
          scrollLocked: document.body.style.overflow === 'hidden',
        };
      });
      expect(inert.covered, 'a background control is reachable by pointer').toBe(true);
      expect(inert.scrollLocked).toBe(true);
    } finally {
      clearFixture(userId, FIXTURE.slug);
      await ctx.close();
    }
  });

  /**
   * Every narrow width, because "works on mobile" is a claim about a range.
   *
   * 320 is the narrowest phone still in use; 375, 390 and 414 are the common
   * iPhone widths; 560 is inside the mobile breakpoint but wide enough that a
   * row layout would fit, which is where a rule keyed off the wrong query
   * shows up. Each is checked for the same four things, because each of them
   * broke at least once during this work: an action off-screen, a control
   * under 44px, the document scrolling sideways, and a sheet with a void in it.
   */
  for (const width of [320, 375, 390, 414, 560]) {
    test(`is a content-sized sheet with every action reachable at ${width}px`, async ({ browser, request, baseURL }) => {
      const { ctx, page, userId } = await openWith(browser, request, baseURL, FIXTURE);

      try {
        await page.setViewportSize({ width, height: 812 });
        await page.locator('[role="alertdialog"]').waitFor({ state: 'visible', timeout: 30000 });
        await page.addStyleTag({ content: SETTLE });

        const geometry = await page.evaluate((vw) => {
          const dialog = document.querySelector('[role="alertdialog"]');
          const foot = dialog.querySelector('.modal-foot');
          const body = dialog.querySelector('.modal-body');
          const r = dialog.getBoundingClientRect();
          return {
            dialogHeight: Math.round(r.height),
            viewportHeight: window.innerHeight,
            /* A sheet, so the page shows above it. Zero would mean the
               full-screen rule is back. */
            peek: Math.round(r.top),
            radius: getComputedStyle(dialog).borderTopLeftRadius,
            /* Content-sized: the body must not be padded out with empty space.
               `scrollHeight` is the content; `clientHeight` is the box. A void
               is a box much taller than its content. */
            bodyBox: body.clientHeight,
            bodyContent: body.scrollHeight,
            footOverflows: foot.scrollWidth > foot.clientWidth + 1,
            horizontalOverflow:
              document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            controls: [...foot.querySelectorAll('a, button')].map((el) => {
              const b = el.getBoundingClientRect();
              return {
                name: el.textContent.trim().slice(0, 24),
                w: Math.round(b.width),
                h: Math.round(b.height),
                onScreen: b.left >= 0 && b.right <= vw + 1
                  && b.top >= 0 && b.bottom <= window.innerHeight + 1,
              };
            }),
          };
        }, width);

        expect(geometry.horizontalOverflow, 'the page scrolls sideways').toBe(false);
        expect(geometry.footOverflows, 'an action is clipped by the dialog').toBe(false);

        expect(geometry.controls, 'three answers').toHaveLength(3);
        for (const c of geometry.controls) {
          expect(c.onScreen, `"${c.name}" is off screen at ${width}px`).toBe(true);
          expect(c.h, `"${c.name}" is ${c.w}x${c.h} at ${width}px`).toBeGreaterThanOrEqual(44);
        }

        /* The sheet stops where its content stops. Before the stylesheet was
           consolidated this was pinned to the full viewport height, which put
           a screenful of nothing between the message and the buttons. */
        expect(
          geometry.dialogHeight,
          `a full-height sheet at ${width}px means the two competing @media blocks are back`
        ).toBeLessThan(geometry.viewportHeight);
        expect(geometry.peek, 'no page visible above the sheet').toBeGreaterThan(0);
        expect(geometry.radius, 'a sheet has a rounded top edge').not.toBe('0px');

        /* And the body is not padded out: its box is close to its content. A
           tolerance rather than equality because the body legitimately scrolls
           by a few pixels at 320px. */
        expect(
          geometry.bodyBox - geometry.bodyContent,
          `the dialog body has ${geometry.bodyBox - geometry.bodyContent}px of empty space at ${width}px`
        ).toBeLessThan(24);
      } finally {
        clearFixture(userId, FIXTURE.slug);
        await ctx.close();
      }
    });
  }

  test('keeps all three answers on screen at 375px', async ({ browser, request, baseURL }) => {
    /**
     * The regression this exists for, in its own words.
     *
     * The first version of this dialog's mobile CSS added
     * `flex-wrap: wrap` and a 100% flex basis to the footer — not realising
     * `.modal-foot` is ALREADY `flex-direction: column` on a phone, app-wide.
     * Wrapping a column container wraps it into COLUMNS: the three actions
     * stayed on one line, the footer's scrollWidth measured 1037 against a 371
     * client width, and "Sign out" and "Read the document" were clipped off the
     * right edge by the dialog's own `overflow: hidden`.
     *
     * Two of the three answers were simply not on screen, on the one dialog in
     * the product that has to be answered — and every unit test still passed,
     * because the markup was correct and the layout was not. So the assertion
     * is geometric: each control inside the viewport, each at least 44px tall,
     * and nothing overflowing.
     */
    const { ctx, page, userId } = await openWith(browser, request, baseURL, FIXTURE);

    try {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.locator('[role="alertdialog"]').waitFor({ state: 'visible', timeout: 30000 });
      await page.addStyleTag({ content: SETTLE });

      const footer = await page.evaluate(() => {
        const foot = document.querySelector('.modal-mandatory .modal-foot');
        return {
          scrollWidth: foot.scrollWidth,
          clientWidth: foot.clientWidth,
          controls: [...foot.querySelectorAll('a, button')].map((el) => {
            const r = el.getBoundingClientRect();
            return {
              name: el.textContent.trim().slice(0, 24),
              w: Math.round(r.width),
              h: Math.round(r.height),
              left: Math.round(r.left),
              right: Math.round(r.right),
            };
          }),
        };
      });

      expect(footer.controls.length, 'three answers').toBe(3);
      expect(
        footer.scrollWidth,
        'the footer overflows, so a control is clipped by the dialog'
      ).toBeLessThanOrEqual(footer.clientWidth + 1);

      for (const c of footer.controls) {
        expect(c.left, `"${c.name}" starts off the left edge`).toBeGreaterThanOrEqual(0);
        expect(c.right, `"${c.name}" runs past the right edge`).toBeLessThanOrEqual(375);
        expect(c.h, `"${c.name}" is ${c.w}x${c.h}`).toBeGreaterThanOrEqual(44);
      }

      /* Each on its own row: three distinct tops, so they are stacked rather
         than squeezed side by side. */
      const tops = new Set(footer.controls.map(c => c.right - c.w));
      expect(tops.size, 'the three controls share a column, so they share a left edge').toBe(1);

      expect(await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      )).toBe(false);
    } finally {
      clearFixture(userId, FIXTURE.slug);
      await ctx.close();
    }
  });

  test('can be answered, and stays answered', async ({ browser, request, baseURL }) => {
    const { ctx, page, userId } = await openWith(browser, request, baseURL, FIXTURE);

    try {
      await page.locator('[role="alertdialog"]').waitFor({ state: 'visible', timeout: 30000 });

      await page.getByRole('button', { name: /Accept and continue/i }).click();
      await page.locator('[role="alertdialog"]').waitFor({ state: 'detached', timeout: 30000 });

      /* The capabilities are released, which is the only thing accepting is
         for — the dialog going away is a consequence, not the outcome. */
      const withheld = await page.evaluate(async () => {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        return (await res.json()).withheld;
      });
      expect(withheld).not.toContain('event.apply');

      /* And a reload does not reopen it. */
      await page.reload();
      await page.locator('#main-content').waitFor({ state: 'visible', timeout: 30000 });
      expect(await page.locator('[role="alertdialog"]').count()).toBe(0);
      expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
    } finally {
      clearFixture(userId, FIXTURE.slug);
      await ctx.close();
    }
  });
});
