import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * Nothing the application runs may create a platform owner.
 *
 * ── What this replaces ──
 *
 * `seedSuperAdmin()` inserted `user-super` / `owner@wevolunteer.local` with the
 * role `super_admin` and a known password whenever DEMO_MODE was set. It was
 * gated, it was convenient, and it was the only code in this repository capable
 * of creating an owner.
 *
 * That is what made it worth removing. The platform's strongest defence against
 * privilege escalation is not a permission check — it is the absence of a
 * mechanism: there is no `UPDATE users SET role` anywhere in `server/`, and
 * `bin/make-admin.mjs` refuses every role but student and organizer. A seeding
 * function turned that into "no mechanism except this one", and an invariant
 * with an exception is a convention.
 *
 * ── Why this is a source scan ──
 *
 * The runtime half is `assertNoDemoOwner()` in `db.js`, which refuses to boot a
 * demo database containing an owner, and `startTestServer` exercises it on every
 * server suite in this repository — several hundred boots. What that cannot
 * catch is a NEW writer being added somewhere, which is the actual risk: the
 * function that was removed would pass a runtime check too, right up until it
 * ran.
 */

const SERVER = path.join(process.cwd(), 'server');

const serverSources = (() => {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
      out.push([path.relative(process.cwd(), full), readFileSync(full, 'utf8')]);
    }
  };
  walk(SERVER);
  return out;
})();

/** Comments are prose about the rule, not the rule. Stripped before scanning. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/**
 * Two files legitimately name the role beside a write, and both are excluded
 * with a reason rather than by a broad pattern that would hide a third.
 *
 *   migrations/001 — rebuilds `users` and restates the CHECK enum, which has to
 *   list every role that exists. Defining that a role is legal is not granting
 *   it, and the migration writes nobody's row.
 *
 *   testServer.js — `makeOwner`, the harness helper the suites use now that the
 *   seed is gone. It runs the same statement `bin/grant-ownership.mjs` runs, is
 *   never bundled, and exists precisely because the application path was
 *   removed. Excluded by name so a second harness cannot appear quietly.
 */
const EXCLUDED = new Set([
  'server/migrations/001_authz_roles.js',
  'server/testServer.js',
]);

describe('ownership cannot be created by anything the application runs', () => {
  /**
   * The narrow claim: no server module ASSIGNS the role.
   *
   * Matched on the assignment forms rather than on the bare word, because the
   * word appears legitimately all over the place — capability tables, read-side
   * comparisons, the CHECK constraint. What must not exist is a statement that
   * puts that value into somebody's row.
   */
  it('has no server module that assigns the super_admin role', () => {
    const writers = serverSources
      .filter(([file]) => !EXCLUDED.has(file))
      .filter(([, src]) => {
        const code = stripComments(src);
        /* `SET role =`, not `role =`. In SQL `=` is comparison, and the first
           version of this matched three `WHERE role = 'super_admin'` reads —
           including the boot guard that exists to FIND owners, and this file's
           own remediation message. A guard that flags the code enforcing it is
           a guard somebody switches off. */
        return /SET\s+role\s*=\s*['"`]super_admin['"`]/i.test(code)
          || /INSERT\s+INTO\s+users[\s\S]{0,400}?['"`]super_admin['"`]/i.test(code)
          /* The constant form: the value BOUND INTO a statement, rather than
             merely named. `ROLE.SUPER_ADMIN` appears all over the read side —
             `target.role === ROLE.SUPER_ADMIN` and the like — and an earlier
             version of this check flagged three files for exactly that, which
             is how a guard earns a blanket exemption instead of a fix. */
          || /\.run\([^)]*ROLE\.SUPER_ADMIN/.test(code);
      })
      .map(([file]) => file);

    expect(
      writers,
      'a server module assigns super_admin — ownership is granted only by '
      + 'bin/grant-ownership.mjs or a deliberate database bootstrap'
    ).toEqual([]);
  });

  /**
   * The removed function, by name, so it cannot quietly return.
   *
   * A DEFINITION or a CALL STATEMENT, not a mention. The boot guard's own error
   * message names the function it is telling the operator about, and matching
   * the bare name flagged `db.js` for explaining itself — the same shape of
   * false positive as the `WHERE role =` reads above, and the same lesson: a
   * guard that fires on the prose describing it does not survive contact with
   * whoever has to read the failure.
   */
  it('does not seed an owner', () => {
    const seeders = serverSources
      .filter(([, src]) => {
        const code = stripComments(src);
        return /function\s+seedSuperAdmin\b/.test(code)
          || /^\s*seedSuperAdmin\s*\(\s*\)\s*;/m.test(code);
      })
      .map(([file]) => file);
    expect(seeders, 'seedSuperAdmin is back').toEqual([]);
  });

  /**
   * The boot guard itself, which is what protects databases that already contain
   * an owner from before the seeding function was removed. Deleting the function
   * without this leaves those alone — and they are the dangerous artefact, since
   * their password is a string in this file's git history.
   */
  it('refuses to boot a demo database that contains an owner', () => {
    const db = readFileSync(path.join(SERVER, 'db.js'), 'utf8');
    expect(db).toContain('function assertNoDemoOwner');
    expect(db).toMatch(/assertNoDemoOwner\(\);/);
    expect(db, 'the guard must be conditional on DEMO_MODE, not unconditional')
      .toMatch(/function assertNoDemoOwner\(\)\s*\{\s*if \(!DEMO_MODE\) return;/);
  });
});
