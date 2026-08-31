import { test, expect } from '@playwright/test';
import { forEachRoute } from './harness/walk.mjs';
import { scan, tally } from './harness/axe.mjs';
import { load, save, compare } from './harness/baseline.mjs';

/**
 * axe over every route the table declares, for every distinct seeded role.
 *
 * One test, not one per route, because the ratchet has to see the whole run at
 * once: a per-route test could only compare its own row, and "this rule moved
 * from page A to page B" would read as one fix and one regression rather than as
 * nothing changing.
 *
 * `roles: 'all'` here and nowhere else. A rule can fire on markup only one role
 * is ever shown, so axe needs every role; page structure, focus order and layout
 * are properties of the shell and the view, so the other sweeps do not.
 *
 * Set A11Y_UPDATE_BASELINE=1 to record the current state. That is an explicit,
 * reviewable act, which is the only way the ratchet is allowed to loosen.
 */
test('axe finds no new WCAG 2.2 AA violations', async ({ browser, request, baseURL }) => {
  test.setTimeout(45 * 60 * 1000);

  const found = {};
  const detail = {};
  const { unreachable, visited } = await forEachRoute(
    { browser, request, baseURL },
    { roles: 'all' },
    async (page, route, role) => {
      /* A BOUNDED settle, not networkidle.
       *
       * networkidle waits for 500ms of no network activity, and this app holds a
       * socket.io connection open for live notifications — so it never goes
       * idle and every route burned the full 30s default before the catch
       * swallowed it. Across 48 routes times every role that is hours, which is
       * the "harness nobody runs" failure the spec names as a risk.
       *
       * axe needs styles settled, not the network silent. A short fixed settle
       * after the landmark is already visible is what that actually requires. */
      await page.waitForTimeout(250);
      const violations = await scan(page);
      const counts = tally(violations);
      const key = `${route.path}::${role.key}`;
      if (Object.keys(counts).length) {
        found[key] = counts;
        detail[key] = violations;
      }
    }
  );

  console.log(`swept ${visited.length} route/role pairs`);

  if (process.env.A11Y_UPDATE_BASELINE) {
    const stamped = {};
    for (const [key, rules] of Object.entries(found)) {
      stamped[key] = {};
      for (const [rule, count] of Object.entries(rules)) {
        stamped[key][rule] = { count, finding: 'A-00' };
      }
    }
    save(stamped);
    console.log('baseline written — replace every A-00 with a real finding id before committing');
    /* The detail is what makes the findings actionable; the baseline stores only
       counts, because a selector changes whenever markup does and would make the
       ratchet fire on cosmetic edits. */
    const byRule = {};
    for (const violations of Object.values(detail)) {
      for (const v of violations) {
        (byRule[v.id] ||= { help: v.help, impact: v.impact, examples: [] });
        if (byRule[v.id].examples.length < 4) byRule[v.id].examples.push(`${v.selector} — ${v.html}`);
      }
    }
    console.log('\n=== violations by rule ===');
    for (const [id, info] of Object.entries(byRule).sort()) {
      const total = Object.values(found).reduce((n, r) => n + (r[id] || 0), 0);
      console.log(`\n${id} (${info.impact}) x${total} — ${info.help}`);
      for (const ex of info.examples) console.log(`   ${ex}`);
    }
  }

  expect(unreachable, `routes that did not load:\n${unreachable.join('\n')}`).toEqual([]);

  const { regressions, fixed } = compare(load(), found);
  if (fixed.length) console.log(`${fixed.length} violation(s) fixed since the baseline`);
  expect(
    regressions,
    'new accessibility violations:\n'
    + regressions.map(r => `  ${r.key} — ${r.rule}: ${r.was} -> ${r.now}`).join('\n')
  ).toEqual([]);
});
