import { ROUTES, SIGNED_OUT_ROUTES, concreteFor } from './routes.mjs';
import { resolveFixtures } from './fixtures.mjs';
import { fetchRoles } from './roles.mjs';
import { signInAs } from './signIn.mjs';

/** Kills animation and transition, so a measurement sees final styles. */
const SETTLE = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

/**
 * Visits every route and hands each page to a visitor.
 *
 * ── Why this is shared rather than inlined per sweep ──
 *
 * Five sweeps need the same loop, and three lines of it fail silently.
 *
 * The wait for the main landmark is there because route-level code splitting
 * means a Suspense fallback — LoadingSkeleton — is what renders first. A sweep
 * that measures before it resolves measures the skeleton and reports a clean
 * page.
 *
 * A route whose fixture 404s must be RECORDED rather than measured, because a
 * 404 body passes almost every accessibility check there is. A skip would be the
 * quiet failure: the route stops being audited and nothing says so.
 *
 * And a route that REDIRECTS must be recorded too. This one was a real defect in
 * the first version: signed in, /login, /signup and /welcome all redirect to the
 * dashboard, so the sweep measured the dashboard three extra times and reported
 * the counts under the auth routes' names. The sign-in page — the one every
 * unauthenticated visitor sees, and the one place a locked-out person cannot work
 * around a defect — was never audited at all. The numbers looked plausible,
 * which is exactly what made it dangerous.
 *
 * Duplicated five times, each copy is one edit away from disagreeing with the
 * others, and the disagreement looks like a real finding. So there is one copy.
 */
export async function forEachRoute(
  { browser, request, baseURL },
  { roles = 'first', context = {}, signedOut = false, settle = true } = {},
  visit
) {
  const unreachable = [];
  const redirected = [];
  /* Answered 200 on the right path, but showed an error instead of the page. */
  const unmeasured = [];
  /* The same thing, for the routes `SWEEP_CANNOT_MEASURE` says cannot be
     reached by this sweep's kind of visitor. Kept apart so the specs can go on
     asserting that `unmeasured` is empty — an expected gap and a surprise are
     different facts, and merging them would either hide the surprise or turn the
     expected gap into a permanent red. */
  const expectedUnmeasured = [];
  const visited = [];

  /**
   * Signed out there is no role, so one pass over the routes an unauthenticated
   * visitor can actually reach: the auth screens, the legal centre, certificate
   * verification and the appeal link. Everything else redirects to sign-in, and
   * measuring the sign-in page under another route's name is the defect above.
   */
  const passes = signedOut
    ? [{ role: { key: 'signed-out' }, storageState: undefined, routes: SIGNED_OUT_ROUTES }]
    : await signedInPasses({ browser, request, baseURL }, roles);

  /**
   * Parameters the typed table cannot supply, asked of the running app.
   *
   * `routes.mjs` precomputes `route.concrete` from literals, which is all a
   * seeded id or handle needs. A certificate code is `crypto.randomBytes` and
   * differs every reseed, so it can only be learned here — see `fixtures.mjs`.
   * Resolved ONCE for the whole walk (and memoised beyond it), then merged per
   * route below, so a route's URL is never built from a value that was true
   * when somebody typed it and false ever since.
   *
   * Done for the signed-out pass too. There is no session in that pass, but the
   * lookup opens its own, and `/verify/:code` is a PUBLIC route: the code is
   * what a reader is handed on paper, and the signed-out visit is the one that
   * matches how the link is really opened.
   */
  const live = await resolveFixtures({ browser, request, baseURL });

  for (const pass of passes) {
    const ctx = await browser.newContext({
      baseURL,
      ...(pass.storageState ? { storageState: pass.storageState } : {}),
      ...context
    });
    const page = await ctx.newPage();

    for (const route of pass.routes) {
      /* The typed path, with anything `fixtures.mjs` resolved layered over it.
         Everything below reports against THIS rather than `route.concrete`, so
         a failure names the URL that was actually visited. */
      const target = concreteFor(route.path, live);
      let res;
      try {
        res = await page.goto(target, { waitUntil: 'domcontentloaded' });
      } catch (err) {
        unreachable.push(
          `${target} (${pass.role.key}) -> navigation threw: ${err.message.split('\n')[0]}`
        );
        continue;
      }
      if (res && res.status() >= 400) {
        unreachable.push(`${target} (${pass.role.key}) -> HTTP ${res.status()}`);
        continue;
      }

      /* Let a client-side redirect happen before deciding where we are: the
         router redirects after hydration, not in the HTTP response. */
      await page.locator('#main-content, main, [role="main"]').first()
        .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

      /**
       * …and then wait for the page's CONTENT, which the landmark does not
       * imply.
       *
       * `main` is the shell. It becomes visible as soon as the route's component
       * mounts, while the data it renders is still being fetched, so the wait
       * above returns on a page that is nothing but loading skeletons. Every
       * sweep then measures placeholders: the focus walk tabs through controls
       * that are still being replaced, and axe scans a page the reader never
       * sees.
       *
       * That is not hypothetical. The GitHub runner is slower than a developer
       * machine, and the focus sweep failed there on `/` and `/calendar` —
       * reporting "View details" and "Week" as having no focus indicator —
       * while passing locally every time. The uploaded screenshot settled it:
       * the dashboard was still showing grey skeleton blocks. The rings were
       * never missing; the page had not finished arriving.
       *
       * This is the same mistake, in the same shape, that
       * `preferences.spec.js` made about the Accessibility Statement: waiting
       * for a landmark that was already on screen and reading the previous
       * page's content.
       *
       * Bounded and forgiving. A route whose skeletons never clear — a genuinely
       * stuck fetch — still gets measured after the timeout rather than hanging
       * the sweep, and whatever it reports about a stuck page is a true finding
       * about a stuck page.
       */
      /* `.full-page-wait` is the other loading state: a route chunk or the
         session check, which shows nothing for a second and then the brand
         loader (`FullPageWait`). It has no skeleton to wait out, so without it
         here the sweep measured the wait itself — and reported the two routes
         that are supposed to be unmeasurable as measured. */
      await page.waitForFunction(
        () => !document.querySelector('.skeleton, .premium-skeleton, .full-page-wait'),
        undefined,
        { timeout: 10000 },
      ).catch(() => {});

      /**
       * Settle the styles before anything measures them.
       *
       * This is not a convenience — it is the difference between real findings
       * and fabricated ones, and it was measured: the first contrast run
       * reported 49 violations, and with motion disabled the same pages reported
       * 18. Thirty-one were artefacts.
       *
       * Entrance animations in this stylesheet run 120-300ms, and an element
       * mid-fade has a COMPOSITED colour lighter than the token it was given.
       * axe reported the primary button's background as #3b8668 when the token
       * is #0f6b45 — white on the token is 6.54:1 and passes, white on the
       * mid-fade composite is 4.29:1 and fails. Acting on that would have meant
       * darkening a palette that was already conformant: a scanner number
       * treated as a fact about the product.
       */
      /**
       * `settle: false` exists for one caller and is not an optimisation.
       *
       * SETTLE sets `animation-duration: 0s`, so any check that ASKS ABOUT
       * animation is answered by the settle rather than by the page. The
       * reduced-motion sweep looks for elements still animating infinitely, and
       * with styles settled it found none and passed — vacuously, on every
       * route, which is the failure mode this repo's guards are written against.
       * A sweep measuring motion must not be handed a stylesheet that removed it.
       */
      if (settle) {
        await page.addStyleTag({ content: SETTLE }).catch(() => {});
        await page.evaluate(
          () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
        ).catch(() => {});
      }

      const landed = new URL(page.url()).pathname;
      if (landed !== target) {
        redirected.push(`${target} (${pass.role.key}) -> ${landed}`);
        continue;
      }

      /**
       * A route that answered 200 but rendered "not found" is NOT measured.
       *
       * This is the failure mode a status check cannot see. React Router serves
       * the shell for any path, so a parameterised route whose fixture does not
       * exist in the seed returns HTTP 200, lands on exactly the requested path,
       * and renders an error panel — which the sweep then measured and reported
       * under the real route's name. Six of the twelve parameterised routes were
       * in that state: the fixtures were guessed (`id: '1'`, `handle: 'alex'`)
       * and the seed uses `user-diana` and `dsorensen`.
       *
       * That is worse than skipping a route, because it produces numbers that
       * look like coverage. `ErrorExperience` sets `data-error-kind` on its
       * container precisely so routing can be asserted without pinning copy, so
       * that is the signal used here.
       *
       * Only a **404** counts as unmeasured. A 403 is a different thing entirely:
       * it is the real page that role sees, it is reached legitimately, and it is
       * one of the places accessibility matters most — somebody has just been
       * stopped and needs to work out what to do. Eleven routes render a 403 for
       * a student, and every one of them should be, and is, measured. Treating
       * those as unmeasured would have thrown away exactly the coverage that
       * finding A-13 (the missing landmark on error takeovers) was about.
       *
       * A 404 means the path or its fixture did not resolve to anything, so
       * whatever was measured is not the page the route names.
       *
       * `fixtures.mjs` has since removed the commonest cause: a parameter whose
       * value cannot be written down — a certificate code is `crypto.randomBytes`
       * and differs every reseed — is now resolved from the running app instead
       * of typed, so `/verify/:code` is measured against a code that exists. This
       * check is what remains honest when even that finds nothing.
       */
      /* `page.evaluate`, NOT `locator.getAttribute`. A locator action auto-waits
         for the element to appear, and on a route that renders correctly this
         element never will — so the first version blocked until the test timeout
         on every healthy route and turned a 25-second sweep into a hang. A
         synchronous read answers "is there one right now", which is the actual
         question. */
      const errorKind = await page.evaluate(
        () => document.querySelector('[data-error-kind]')?.getAttribute('data-error-kind') ?? null
      ).catch(() => null);
      if (errorKind === '404' && !route.path.startsWith('/errors')) {
        if (route.sweepCannotMeasure) {
          /* Prefixed with the DECLARED path, not just the concrete one, so the
             stale-exemption guard in sweep.aria.spec.js can match these against
             `SWEEP_CANNOT_MEASURE`'s keys exactly rather than by guessing at a
             shared prefix. */
          expectedUnmeasured.push(
            `${route.path} — ${target} (${pass.role.key}) -> ${route.sweepCannotMeasure}`
          );
        } else {
          unmeasured.push(
            `${target} (${pass.role.key}) -> rendered a 404, so its path or `
            + 'fixture does not resolve and the page under this route was never measured'
          );
        }
        continue;
      }

      await visit(page, route, pass.role);
      visited.push(`${route.path}::${pass.role.key}`);
    }
    await ctx.close();
  }

  return { unreachable, redirected, unmeasured, expectedUnmeasured, visited };
}

async function signedInPasses({ browser, request, baseURL }, roles) {
  const all = await fetchRoles(request, baseURL);
  /* One role by default: page structure, focus order and layout are properties
     of the shell and the view, not of authorisation. Only the axe sweep asks for
     every role, because a rule can fire on markup only one role is shown. */
  const chosen = roles === 'all' ? all : all.slice(0, 1);
  const out = [];
  for (const role of chosen) {
    out.push({
      role,
      storageState: await signInAs(browser, role, baseURL),
      routes: ROUTES
    });
  }
  return out;
}
