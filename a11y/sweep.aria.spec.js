import { test, expect } from '@playwright/test';
import { forEachRoute } from './harness/walk.mjs';
import { SWEEP_CANNOT_MEASURE } from './harness/routes.mjs';

/**
 * The accessible structure the browser actually computes, per route.
 *
 * axe reports rule violations; this records STRUCTURE — what a screen-reader
 * user navigates by. The two find different things: a page can satisfy every axe
 * rule and still present eleven h3s under no h2, or a landmark set that makes
 * the rotor useless.
 */
test('the accessible structure of every route holds up', async ({ browser, request, baseURL }) => {
  test.setTimeout(45 * 60 * 1000);

  const wrongH1 = [];
  const badHeadings = [];
  const ambiguousLandmarks = [];
  const duplicateMains = [];
  const namelessControls = [];

  const titles = [];
  const { unreachable, unmeasured, expectedUnmeasured } = await forEachRoute({ browser, request, baseURL }, {}, async (page, route) => {
    /* 2.4.2 Page Titled — Level A, and the criterion App.jsx's own comment
       records having failed silently once: PAGE_META carried a title for every
       route and nothing wrote it to document.title, so the guard was testing the
       DATA and not the effect. This tests the effect. */
    titles.push({ path: route.path, title: await page.title() });
    const structure = await page.evaluate(() => {
      const levels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .map(h => ({ level: Number(h.tagName[1]), text: h.textContent.trim().slice(0, 40) }));

      const skips = [];
      for (let i = 1; i < levels.length; i++) {
        if (levels[i].level > levels[i - 1].level + 1) {
          skips.push(`h${levels[i - 1].level} "${levels[i - 1].text}" -> h${levels[i].level} "${levels[i].text}"`);
        }
      }

      /* Two landmarks of the same role need distinct names to be usable in a
         rotor. App.jsx renders two <nav> elements — the desktop rail and the
         mobile bar — and both are labelled "Main", which is the case worth
         catching: a rotor cannot tell them apart. */
      /**
       * Only landmarks that are actually EXPOSED.
       *
       * The first version of this check counted every matching element in the
       * DOM and reported "nav x2 all named Main" on 23 routes — the desktop rail
       * and the mobile bottom bar. That was a defect in the check, not in the
       * app: `.mobilenav` is `display: none` until its breakpoint and the rail is
       * hidden below it, and `display: none` removes an element from the
       * accessibility tree entirely. A screen reader has never seen both.
       *
       * Reporting it would have meant renaming working navigation to satisfy a
       * measurement that was wrong, which is worse than not measuring at all.
       * `offsetParent` is null for a `display: none` subtree, and the
       * visibility check covers the cases it misses.
       */
      const exposed = el => {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        if (el.getAttribute('aria-hidden') === 'true') return false;
        /* position: fixed elements have a null offsetParent legitimately, so it
           is only conclusive when the element is not fixed. */
        return s.position === 'fixed' || el.offsetParent !== null;
      };

      /**
       * The role the browser computes, not the tag that was typed.
       *
       * `<header>` and `<footer>` are `banner` and `contentinfo` ONLY at the top
       * level. Nested in `article`, `aside`, `main`, `nav` or `section` they are
       * generic elements and appear in no landmark list at all — HTML-AAM has
       * said so since it was written.
       *
       * Bucketing by tag name therefore reported a page header inside `main` as
       * a second banner, and `/portfolio` and `/welly` were both on the list for
       * markup that was correct. That is the same defect as the `nav x2` false
       * positive above, one level up: a measurement that is wrong costs more
       * than no measurement, because the fix it demands is to break working
       * markup until the instrument is satisfied.
       */
      const SECTIONING = 'article,aside,main,nav,section';
      const roleOf = (el) => {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === 'header' || tag === 'footer') {
          /* `closest` starts at the element itself, so step up first — a
             `<header>` is not its own ancestor but `closest` would say it is if
             the selector ever grew to include it. */
          return el.parentElement?.closest(SECTIONING)
            ? null
            : (tag === 'header' ? 'banner' : 'contentinfo');
        }
        return tag;
      };

      const byRole = {};
      for (const el of [...document.querySelectorAll('nav,main,header,footer,aside,[role="navigation"],[role="region"]')].filter(exposed)) {
        const role = roleOf(el);
        if (!role) continue;
        const labelledBy = el.getAttribute('aria-labelledby');
        const name = (
          el.getAttribute('aria-label')
          || (labelledBy && document.getElementById(labelledBy)?.textContent)
          || ''
        ).trim();
        (byRole[role] ||= []).push(name);
      }
      const ambiguous = Object.entries(byRole)
        .filter(([, names]) => names.length > 1 && new Set(names).size < names.length)
        .map(([role, names]) => `${role} x${names.length} all named "${names[0] || '(unnamed)'}"`);

      /**
       * More than one `main`, however they are named.
       *
       * The ambiguity check above asks whether two landmarks of one role can be
       * told apart, which is the right question for `nav` and `region` — a page
       * may legitimately have several. It is the wrong question for `main`:
       * there is supposed to be one, and naming the second one does not make it
       * allowed. So `/welly` sat under the shell's `main` with a `main` of its
       * own labelled "Welly conversation", the names differed, and the check
       * stayed silent about a page with two of the landmark that is meant to be
       * unique.
       */
      const mainCount = [...document.querySelectorAll('main,[role="main"]')].filter(exposed).length;

      /* A control with no accessible name is announced as just its role —
         "button" — which tells somebody nothing about what it does. axe's
         button-name rule catches many of these, but not [role] controls or
         links whose only content is an aria-hidden icon, so this is the wider
         net. */
      const nameless = [];
      for (const el of document.querySelectorAll('a[href], button, [role="button"], [role="link"]')) {
        if (!exposed(el)) continue;
        /* The full name computation, including aria-labelledby and an image's
           alt text. The first version checked aria-label/title/textContent only,
           which would have reported a control named purely by aria-labelledby —
           a legitimate, common pattern — as a 4.1.2 violation. It is the one
           name check that gates every route, so it has to be the most complete,
           not the least. */
        const labelledBy = el.getAttribute('aria-labelledby');
        const name = (
          el.getAttribute('aria-label')
          || (labelledBy && labelledBy.split(/\s+/)
              .map(id => document.getElementById(id)?.textContent || '').join(' '))
          || el.textContent
          || [...el.querySelectorAll('img[alt]')].map(i => i.getAttribute('alt')).join(' ')
          || el.getAttribute('title')
          || ''
        ).trim();
        if (!name) nameless.push(el.outerHTML.slice(0, 110).replace(/\s+/g, ' '));
      }

      return {
        h1Count: levels.filter(l => l.level === 1).length,
        mainCount,
        skips,
        ambiguous,
        nameless: nameless.slice(0, 8)
      };
    });

    if (structure.h1Count !== 1) wrongH1.push(`${route.path} has ${structure.h1Count} h1 elements`);
    if (structure.mainCount > 1) {
      duplicateMains.push(
        `${route.path} has ${structure.mainCount} exposed main landmarks — the shell `
        + 'renders one around every APP_ROUTES view, so a view inside it must not '
        + 'render another. Use a section with an aria-label if the region needs a name.'
      );
    }
    if (structure.skips.length) badHeadings.push(`${route.path}: ${structure.skips.join('; ')}`);
    if (structure.ambiguous.length) ambiguousLandmarks.push(`${route.path}: ${structure.ambiguous.join(', ')}`);
    if (structure.nameless.length) namelessControls.push(`${route.path}: ${structure.nameless.join(' | ')}`);
  });

  console.log(`skipped heading levels (${badHeadings.length}):\n${badHeadings.join('\n')}`);
  console.log(`\nindistinguishable duplicate landmarks (${ambiguousLandmarks.length}):\n${ambiguousLandmarks.join('\n')}`);

  expect(unreachable, `routes that did not load:\n${unreachable.join('\n')}`).toEqual([]);
  expect(
    unmeasured,
    'these routes answered 200 on the right path but rendered an error instead of '
    + `the page, so nothing about them was actually measured:\n${unmeasured.join('\n')}`
  ).toEqual([]);

  /**
   * Guards the exception list, which is the half that rots.
   *
   * `SWEEP_CANNOT_MEASURE` buys `/certificates/:code` an exemption from the
   * assertion above, and an exemption nobody rechecks is how a route stops being
   * audited for good. So every entry must still be EARNING it: the route has to
   * have actually turned up unmeasured on this walk. The day ownership changes,
   * or the seed gives the swept student a certificate, this fails and the entry
   * has to go — which is the outcome you want, because it means the route can be
   * measured properly now.
   */
  console.log(`expected coverage gaps (${expectedUnmeasured.length}):\n${expectedUnmeasured.join('\n')}`);
  const stale = Object.keys(SWEEP_CANNOT_MEASURE).filter(
    routePath => !expectedUnmeasured.some(entry => entry.startsWith(`${routePath} —`))
  );
  expect(
    stale,
    'these routes are excused from the coverage assertion but were not actually '
    + `unmeasured, so the exemption is stale and should be deleted:\n${stale.join('\n')}`
  ).toEqual([]);

  /* Every route's tab must be distinguishable, and none may be left as the bare
     app name — that was the exact symptom when nothing wrote the title. */
  const untitled = titles.filter(t => !t.title || t.title.trim() === 'WeVolunteer');
  expect(
    untitled.map(t => t.path),
    `WCAG 2.4.2 — routes whose document title is missing or just the app name:\n`
    + untitled.map(t => `${t.path} -> "${t.title}"`).join('\n')
  ).toEqual([]);

  /* These two DO fail.

     The h1 count is the browser checking src/headingLevels.test.js's claim. That
     guard reasons about source text and an allowlist of views rendering outside
     the shell; if runtime disagrees, the allowlist reasoning is wrong, and a
     guard that is wrong is worse than no guard.

     A control with no accessible name is a 4.1.2 failure and is never a design
     decision. The two console lines above are reported instead, because a
     skipped heading level is a 1.3.1 concern whose fix is a decision about what
     the missing section IS, and stalling the harness on it would stop the audit
     meant to enumerate them. */
  expect(wrongH1, `routes whose h1 count contradicts headingLevels.test.js:\n${wrongH1.join('\n')}`).toEqual([]);

  /* Asserted rather than reported, unlike the ambiguity list above. "Two
     landmarks share a name" is a judgement about whether a rotor is usable and
     its fix is a naming decision; "this page has two mains" is a fact about
     markup that is wrong however it is named, and there is exactly one way to
     fix it. */
  expect(
    duplicateMains,
    `routes with more than one main landmark:\n${duplicateMains.join('\n')}`
  ).toEqual([]);
  expect(namelessControls, `WCAG 4.1.2 — controls with no accessible name:\n${namelessControls.join('\n')}`).toEqual([]);
});
