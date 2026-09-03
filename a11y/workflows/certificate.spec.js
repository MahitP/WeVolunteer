import { test, expect } from '@playwright/test';
import { resolveCertificate } from '../harness/fixtures.mjs';
import { scan } from '../harness/axe.mjs';

/**
 * A real certificate, which the route sweep cannot reach.
 *
 * ── The gap this closes ──
 *
 * `/certificates/:code` is the one route the sweep cannot reach, and the reason
 * is worth stating exactly, because the obvious one is wrong.
 *
 * It is NOT that the code cannot be resolved. `a11y/harness/fixtures.mjs` asks
 * `/api/certificates` for a code that exists and the sweep measures
 * `/verify/:code` against that very code on every run. The obstacle is
 * OWNERSHIP: `getCertificateForOwner` scopes every read to `user_id`, so this
 * page opens only for the student who earned the certificate. The sweep signs in
 * as the first account of each role — `user-student-1` for students — and the
 * seed's only attended event belongs to `user-student-2`. The sweep is therefore
 * authenticated as somebody the product is right to refuse, and the 404 it gets
 * is the product working.
 *
 * `routes.mjs` records that in `SWEEP_CANNOT_MEASURE`, so the run reports it as
 * an expected gap rather than a surprise. But recording a gap is not closing
 * one. This closes it, by signing in as the student who actually holds the
 * certificate.
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
   * One lookup, shared with the sweep.
   *
   * This file used to carry its own copy: fetch the demo accounts, filter to
   * students, sign each in, ask `/api/certificates`, stop at the first that
   * answers. `fixtures.mjs` now does exactly that for the route sweep, and two
   * copies of a search this fiddly are one edit away from disagreeing — with the
   * disagreement showing up as an accessibility finding rather than as the
   * harness bug it would be. It hands back the session as well as the code,
   * which is what this spec needs and the sweep does not.
   *
   * The subtlety the copy existed to capture is preserved inside it: `fetchRoles`
   * deduplicates to one account per ROLE, and a certificate is a property of the
   * ACCOUNT, so the deduplicated list returns the student who holds nothing.
   */
  const certificate = await resolveCertificate({ browser, request, baseURL });
  expect(
    certificate,
    'no seeded student holds a certificate, so there was nothing to measure. '
    + 'A certificate needs an attended, past event in the demo seed.'
  ).toBeTruthy();
  const { code, statePath } = certificate;

  const ctx = await browser.newContext({ baseURL, storageState: statePath });
  const page = await ctx.newPage();

  try {
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
    await ctx.close();
  }
});
