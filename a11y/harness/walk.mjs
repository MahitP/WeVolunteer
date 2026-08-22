import { ROUTES, SIGNED_OUT_ROUTES } from './routes.mjs';
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
  { roles = 'first', context = {}, signedOut = false } = {},
  visit
) {
  const unreachable = [];
  const redirected = [];
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

  for (const pass of passes) {
    const ctx = await browser.newContext({
      baseURL,
      ...(pass.storageState ? { storageState: pass.storageState } : {}),
      ...context
    });
    const page = await ctx.newPage();

    for (const route of pass.routes) {
      let res;
      try {
        res = await page.goto(route.concrete, { waitUntil: 'domcontentloaded' });
      } catch (err) {
        unreachable.push(
          `${route.concrete} (${pass.role.key}) -> navigation threw: ${err.message.split('\n')[0]}`
        );
        continue;
      }
      if (res && res.status() >= 400) {
        unreachable.push(`${route.concrete} (${pass.role.key}) -> HTTP ${res.status()}`);
        continue;
      }

      /* Let a client-side redirect happen before deciding where we are: the
         router redirects after hydration, not in the HTTP response. */
      await page.locator('#main-content, main, [role="main"]').first()
        .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

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
      await page.addStyleTag({ content: SETTLE }).catch(() => {});
      await page.evaluate(
        () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      ).catch(() => {});

      const landed = new URL(page.url()).pathname;
      if (landed !== route.concrete) {
        redirected.push(`${route.concrete} (${pass.role.key}) -> ${landed}`);
        continue;
      }

      await visit(page, route, pass.role);
      visited.push(`${route.path}::${pass.role.key}`);
    }
    await ctx.close();
  }

  return { unreachable, redirected, visited };
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
