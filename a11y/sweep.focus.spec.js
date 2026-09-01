import { test, expect } from '@playwright/test';
import { forEachRoute } from './harness/walk.mjs';
import { walkFocus } from './harness/measure.mjs';

/**
 * Keyboard reachability across every route, for the first seeded role.
 *
 * One role, because focus order is a property of the shell and the view rather
 * than of authorisation, and the shell is shared. Role-specific keyboard
 * behaviour belongs to the workflow specs, which is where it actually differs.
 *
 * Three things no static guard on this platform can check: that every control
 * reachable by Tab paints an indicator, that nothing covers the focused control
 * (2.4.11, new at AA in WCAG 2.2), and that Tab keeps moving at all.
 */
test('every route is keyboard-navigable with a visible focus indicator', async ({ browser, request, baseURL }) => {
  test.setTimeout(45 * 60 * 1000);

  const noRing = [];
  const obscured = [];
  const trapped = [];
  const noStops = [];

  const { unreachable, unmeasured } = await forEachRoute({ browser, request, baseURL }, {}, async (page, route) => {
    const walk = await walkFocus(page);

    /* A page with no tab stops at all is either genuinely static or a page whose
       controls are all divs. Both are worth seeing; neither is silently fine. */
    if (walk.length === 0) noStops.push(route.path);

    for (const step of walk) {
      if (step.trapped) {
        trapped.push(`${route.path} — Tab does not leave ${step.tag} "${step.name}" ${step.outerHTML}`);
      }
      /* An off-screen control legitimately has no painted ring — it is not
         rendered where a ring could be seen. Skipping it keeps the finding list
         about controls a person is actually looking at. */
      /* `reallyFocused` guards a stale `document.activeElement`: see the note
         in measure.mjs. An element that is no longer `:focus`ed has already had
         its focus styles withdrawn, so reading a ring off it says nothing. */
      if (!step.visibleRing && !step.offScreen && step.reallyFocused) {
        noRing.push(`${route.path} — ${step.tag} "${step.name}" ${step.outerHTML}`);
      }
      if (step.obscuredBy) {
        obscured.push(`${route.path} — ${step.tag} "${step.name}" covered by ${step.obscuredBy}`);
      }
    }
  });

  expect(unreachable, `routes that did not load:\n${unreachable.join('\n')}`).toEqual([]);

  /**
   * A route with NO tab stops is asserted, not merely printed.
   *
   * This used to be a `console.log`, which made the whole sweep vacuous for the
   * worst case: a route that renders blank — a crash after the landmark appears,
   * a stuck loading state — has no focusable elements, so `trapped`, `noRing`
   * and `obscured` are all empty and the sweep passes cleanly on a broken page.
   *
   * Every signed-in route in this application has navigation, so zero tab stops
   * means something failed to render. `/appeal/:token` used to be the one real
   * exception and now has a way out, so there is no allowlist.
   */
  expect(
    noStops,
    'these routes have no keyboard-reachable controls at all, which usually means '
    + `they did not render:\n${noStops.join('\n')}`
  ).toEqual([]);

  /* Keyboard traps first: they are the only finding here that makes a page
     impossible rather than merely worse. */
  expect(unmeasured, `routes that rendered an error instead of the page:\n${unmeasured.join('\n')}`).toEqual([]);
  expect(trapped, `WCAG 2.1.2 — keyboard traps:\n${trapped.join('\n')}`).toEqual([]);
  expect(noRing, `WCAG 2.4.7 — controls that focus with no visible indicator:\n${noRing.join('\n')}`).toEqual([]);
  expect(obscured, `WCAG 2.4.11 — focused controls covered by other content:\n${obscured.join('\n')}`).toEqual([]);
});
