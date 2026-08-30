import { test, expect } from '@playwright/test';
import { forEachRoute } from './harness/walk.mjs';

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
  const namelessControls = [];

  const { unreachable } = await forEachRoute({ browser, request, baseURL }, {}, async (page, route) => {
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

      const byRole = {};
      for (const el of [...document.querySelectorAll('nav,main,header,footer,aside,[role="navigation"],[role="region"]')].filter(exposed)) {
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
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

      /* A control with no accessible name is announced as just its role —
         "button" — which tells somebody nothing about what it does. axe's
         button-name rule catches many of these, but not [role] controls or
         links whose only content is an aria-hidden icon, so this is the wider
         net. */
      const nameless = [];
      for (const el of document.querySelectorAll('a[href], button, [role="button"], [role="link"]')) {
        if (!exposed(el)) continue;
        const name = (
          el.getAttribute('aria-label')
          || el.getAttribute('title')
          || el.textContent
          || ''
        ).trim();
        if (!name) nameless.push(el.outerHTML.slice(0, 110).replace(/\s+/g, ' '));
      }

      return {
        h1Count: levels.filter(l => l.level === 1).length,
        skips,
        ambiguous,
        nameless: nameless.slice(0, 8)
      };
    });

    if (structure.h1Count !== 1) wrongH1.push(`${route.path} has ${structure.h1Count} h1 elements`);
    if (structure.skips.length) badHeadings.push(`${route.path}: ${structure.skips.join('; ')}`);
    if (structure.ambiguous.length) ambiguousLandmarks.push(`${route.path}: ${structure.ambiguous.join(', ')}`);
    if (structure.nameless.length) namelessControls.push(`${route.path}: ${structure.nameless.join(' | ')}`);
  });

  console.log(`skipped heading levels (${badHeadings.length}):\n${badHeadings.join('\n')}`);
  console.log(`\nindistinguishable duplicate landmarks (${ambiguousLandmarks.length}):\n${ambiguousLandmarks.join('\n')}`);

  expect(unreachable, `routes that did not load:\n${unreachable.join('\n')}`).toEqual([]);

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
  expect(namelessControls, `WCAG 4.1.2 — controls with no accessible name:\n${namelessControls.join('\n')}`).toEqual([]);
});
