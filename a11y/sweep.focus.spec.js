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

  const { unreachable } = await forEachRoute({ browser, request, baseURL }, {}, async (page, route) => {
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
      if (!step.visibleRing && !step.offScreen) {
        noRing.push(`${route.path} — ${step.tag} "${step.name}" ${step.outerHTML}`);
      }
      if (step.obscuredBy) {
        obscured.push(`${route.path} — ${step.tag} "${step.name}" covered by ${step.obscuredBy}`);
      }
    }
  });

  console.log(`routes with no tab stops: ${noStops.join(', ') || 'none'}`);
  expect(unreachable, `routes that did not load:\n${unreachable.join('\n')}`).toEqual([]);

  /* Keyboard traps first: they are the only finding here that makes a page
     impossible rather than merely worse. */
  expect(trapped, `WCAG 2.1.2 — keyboard traps:\n${trapped.join('\n')}`).toEqual([]);
  expect(noRing, `WCAG 2.4.7 — controls that focus with no visible indicator:\n${noRing.join('\n')}`).toEqual([]);
  expect(obscured, `WCAG 2.4.11 — focused controls covered by other content:\n${obscured.join('\n')}`).toEqual([]);
});
