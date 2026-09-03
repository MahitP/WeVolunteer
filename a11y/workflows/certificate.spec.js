import { test, expect } from '@playwright/test';
import { signInAs } from '../harness/signIn.mjs';
import { scan } from '../harness/axe.mjs';

/**
 * A real certificate, which the route sweep cannot reach.
 *
 * ── The gap this closes ──
 *
 * `/certificates/:code` is parameterised, and `routes.mjs` supplies parameters
 * from a table of literals. That works for `/users/:handle` and `/events/:id`,
 * whose seeded values are stable strings somebody can write down. It cannot work
 * here: `generateCode` in `server/certificates.js` builds the code from
 * `crypto.randomBytes`, so every reseed produces a different one — two
 * consecutive scratch databases gave `WEV-3CVD-ZJS6` and `WEV-5U93-8FP9`.
 *
 * So the typed fixture never resolves, the route renders its not-found panel on
 * every single run, and before `CertificateView` carried `data-error-kind` the
 * sweep measured that panel and filed the result under `/certificates/:code`.
 * Which is the failure `walk.mjs` warns about in its own words: worse than
 * skipping a route, because it produces numbers that look like coverage.
 *
 * Marking the panel fixed the dishonesty — the sweep now reports the route as
 * unmeasured — but reporting a gap is not closing one. This closes it, by
 * asking the API for a code that exists instead of hoping one was written down
 * correctly.
 *
 * ── Why the whole page and not a component test ──
 *
 * `CertificateView.test.jsx` renders the view in jsdom, which has no layout, no
 * real contrast and no computed colour. The certificate is the one screen in
 * this product a student is likely to hand to somebody else — a coordinator, a
 * school office — and it is deliberately a *document*: heavy type, an ornamental
 * border, a QR code, print rules. Every one of those is a thing axe can only
 * judge against real rendering.
 */
test('axe finds no violations on a real certificate', async ({ browser, request, baseURL }) => {
  test.setTimeout(120000);

  /**
   * Every demo student, not `fetchRoles`.
   *
   * `fetchRoles` keeps one account per distinct ROLE, which is right for a sweep
   * measuring shells and reachable route sets — auditing five students adds no
   * coverage there. It is wrong here: it collapses the three seeded students to
   * the first, and a certificate is a property of the ACCOUNT, not the role.
   * The seed gives one to `user-student-2`, so the deduped list returns the one
   * student who has none and the spec fails on an empty list having proved
   * nothing. Which account holds it is a seed detail this file should not know,
   * so it asks each in turn instead of naming one.
   */
  const accountsRes = await request.get(`${baseURL}/api/auth/demo-accounts`);
  expect(accountsRes.ok(), 'GET /api/auth/demo-accounts').toBeTruthy();
  const payload = await accountsRes.json();
  const accounts = (Array.isArray(payload) ? payload : payload?.accounts ?? [])
    /* Certificates belong to the volunteer who earned them —
       `getCertificateForOwner` scopes every read to `user_id`, and no other role
       can open one (`routes.certificateViewer.test.js`). */
    .filter(a => /student/i.test(a.role));
  expect(accounts.length, 'the demo seed must contain a student').toBeGreaterThan(0);

  let ctx = null;
  let page = null;
  let code = null;
  const tried = [];

  try {
    for (const account of accounts) {
      const statePath = await signInAs(
        browser,
        { key: account.id, email: account.email, role: account.role },
        baseURL
      );
      const candidate = await browser.newContext({ baseURL, storageState: statePath });
      const candidatePage = await candidate.newPage();

      /* The reader's own list, which is also the only place a code can be
         learned from — no endpoint hands out somebody else's. */
      const list = await candidatePage.request.get('/api/certificates');
      expect(list.ok(), `GET /api/certificates as ${account.id}`).toBeTruthy();
      const body = await list.json();
      const rows = Array.isArray(body) ? body : (body?.certificates ?? []);
      const found = rows.find(r => r?.code)?.code;

      tried.push(`${account.id}: ${rows.length} certificate(s)`);
      if (found) { ctx = candidate; page = candidatePage; code = found; break; }
      await candidate.close();
    }

    expect(
      code,
      'no seeded student holds a certificate, so there was nothing to measure. '
      + `Tried — ${tried.join('; ')}. A certificate needs an attended, verified, `
      + 'past event in the demo seed.'
    ).toBeTruthy();

    await page.goto(`/certificates/${code}`);
    await page.getByText('Certificate of Community Service').waitFor({ timeout: 60000 });

    /**
     * The assertion that makes the rest of this file mean anything.
     *
     * Without it, a regression that broke the fetch would land on the not-found
     * panel, axe would find nothing wrong with that panel, and the test would
     * pass while measuring the wrong page — which is precisely the bug this
     * spec exists because of.
     */
    const errorKind = await page.evaluate(
      () => document.querySelector('[data-error-kind]')?.getAttribute('data-error-kind') ?? null
    );
    expect(errorKind, 'measured the certificate, not an error panel').toBeNull();

    /**
     * The rule `sweep.aria.spec.js` applies to every route it can reach, applied
     * here to the one it cannot.
     *
     * This is the assertion that would have caught the defect: the shell's
     * `topbar-title` is an `h1` and `CertificateDocument` rendered a second one,
     * so this page carried two — invisible to the sweep, which was measuring the
     * not-found panel and its single heading.
     */
    const headings = await page.evaluate(() => ({
      h1: [...document.querySelectorAll('h1')].map(h => h.textContent.trim()),
      outline: [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .map(h => Number(h.tagName[1]))
    }));
    expect(headings.h1, `exactly one h1, found: ${JSON.stringify(headings.h1)}`).toHaveLength(1);

    /* And no level is skipped on the way down — the other half of a usable
       outline, and the half that flagged the empty state's `h1 -> h3`. */
    const skips = headings.outline
      .map((level, i) => (i > 0 && level - headings.outline[i - 1] > 1
        ? `h${headings.outline[i - 1]} -> h${level}` : null))
      .filter(Boolean);
    expect(skips, `skipped heading levels: ${skips.join(', ')}`).toEqual([]);

    const violations = await scan(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  } finally {
    if (ctx) await ctx.close();
  }
});
