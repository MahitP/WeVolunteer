import { ROUTES } from './routes.mjs';
import { fetchRoles } from './roles.mjs';
import { signInAs } from './signIn.mjs';

/**
 * Visits every route, for one role or all of them, and hands each page to a
 * visitor.
 *
 * ── Why this is shared rather than inlined per sweep ──
 *
 * Four sweeps need the same loop, and two lines of it fail silently.
 *
 * The wait for the main landmark is there because route-level code splitting
 * means a Suspense fallback — LoadingSkeleton — is what renders first. A sweep
 * that measures before it resolves measures the skeleton and reports a clean
 * page.
 *
 * And a route whose fixture 404s must be RECORDED rather than measured, because
 * a 404 body passes almost every accessibility check there is. A skip would be
 * the quiet failure: the route stops being audited and nothing says so.
 *
 * Duplicated four times, each copy is one edit away from disagreeing with the
 * others, and the disagreement looks like a real finding. So there is one copy.
 */
export async function forEachRoute(
  { browser, request, baseURL },
  { roles = 'first', context = {} } = {},
  visit
) {
  const all = await fetchRoles(request, baseURL);
  /* One role by default: page structure, focus order and layout are properties
     of the shell and the view, not of authorisation. Only the axe sweep needs
     every role, because a rule can fire on markup only one role is shown. */
  const chosen = roles === 'all' ? all : all.slice(0, 1);
  const unreachable = [];
  const visited = [];

  for (const role of chosen) {
    const statePath = await signInAs(browser, role, baseURL);
    const ctx = await browser.newContext({ baseURL, storageState: statePath, ...context });
    const page = await ctx.newPage();

    for (const route of ROUTES) {
      let res;
      try {
        res = await page.goto(route.concrete, { waitUntil: 'domcontentloaded' });
      } catch (err) {
        unreachable.push(`${route.concrete} (${role.key}) -> navigation threw: ${err.message.split('\n')[0]}`);
        continue;
      }
      if (res && res.status() >= 400) {
        unreachable.push(`${route.concrete} (${role.key}) -> HTTP ${res.status()}`);
        continue;
      }
      await page.locator('#main-content, main, [role="main"]').first()
        .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await visit(page, route, role);
      visited.push(`${route.path}::${role.key}`);
    }
    await ctx.close();
  }
  return { unreachable, visited };
}
