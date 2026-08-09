import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Every route that changes two-factor enrolment stays behind a step-up gate.
 *
 * ── Why this is not already covered ──
 *
 * `authz.completeness.test.js` guard 5 pairs `requireAAL2` with `spendChallenge`
 * and requires every registered sensitive action to have at least one gate. Both
 * halves are valuable and neither closes this:
 *
 *   • "every ACTION has a gate" is satisfied while a ROUTE loses one. `2fa.disable`
 *     gates two routes — `POST /api/2fa/disable` and
 *     `POST /api/2fa/email/disable`. Delete the gate from either and the action is
 *     still gated by the other, so guard 5 stays green while one of the two ways
 *     to remove a second factor is reachable from a bare session.
 *   • The route registry in that file records `requireAAL2` as prose in a `reason`
 *     string. Prose does not execute.
 *
 * ── Why it matters more here than elsewhere ──
 *
 * This is the compensating control that lets TOTP replay protection stay scoped to
 * the SIGN-IN path. `verifyTotpOnce` marks a spent time step at
 * `POST /api/auth/login-2fa`; enrolment and disable use plain `verifyTotp`
 * deliberately, and `server/totpReplay.js` explains why — marking the step there
 * would stop somebody signing in and finishing enrolment inside the same thirty
 * seconds, friction bought for nothing, because reaching those handlers already
 * requires a live session AND a spent single-use step-up grant.
 *
 * That reasoning is only sound while the grant is genuinely required. If a gate
 * quietly came off one of these routes, the argument for the narrow replay scope
 * would come off with it — and nothing would report the connection. This is the
 * test that makes the premise enforceable rather than asserted in a comment.
 *
 * ── Derived, not listed ──
 *
 * The route list is read out of the module, and which routes need a gate is
 * decided by whether the handler WRITES. A new endpoint that mutates 2FA state
 * fails this without anybody remembering to add it to a list; a new read-only one
 * does not have to be exempted by name.
 */

const SERVER = path.resolve(__dirname);
const ROUTE_FILE = path.join(SERVER, 'routes', 'twoFactorRoutes.js');

/** Comments removed: these files document the gates at length, in prose that names them. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every `router.<method>(...)` block in a route module.
 *
 * Split on the declarations rather than parsed: the property under test is a fact
 * about the text between one route and the next, and a real parser would be a lot
 * of machinery to answer "does this substring contain requireAAL2".
 */
function routeBlocks(filePath) {
  const code = codeOnly(readFileSync(filePath, 'utf8'));
  const declaration = /router\.(get|post|put|patch|delete)\s*\(\s*'([^']+)'/g;

  const found = [];
  let match;
  while ((match = declaration.exec(code)) !== null) {
    found.push({ method: match[1].toUpperCase(), routePath: match[2], start: match.index });
  }

  return found.map((entry, i) => ({
    ...entry,
    body: code.slice(entry.start, i + 1 < found.length ? found[i + 1].start : code.length)
  }));
}

/** Does this block's handler change stored state? */
const WRITES = /\b(UPDATE\s+\w+\s+SET|INSERT\s+INTO|DELETE\s+FROM)\b/i;

const blocks = routeBlocks(ROUTE_FILE);

describe('two-factor routes are all behind a step-up gate', () => {
  it('the scan found the module\'s routes', () => {
    /* Vacuity guard. A rename of the file, or of `router.post`, would otherwise
       turn every assertion below into a loop over nothing. */
    expect(blocks.length, `no routes found in ${ROUTE_FILE}`).toBeGreaterThanOrEqual(6);
    expect(blocks.some(b => WRITES.test(b.body)), 'no route appears to write').toBe(true);
    expect(blocks.some(b => !WRITES.test(b.body)), 'no read-only route found').toBe(true);
  });

  it('every route that writes 2FA state requires AAL2', () => {
    const offenders = blocks
      .filter(b => WRITES.test(b.body))
      .filter(b => !/requireAAL2\s*\(/.test(b.body))
      .map(b => `${b.method} ${b.routePath}`);

    expect(
      offenders,
      'these change two-factor enrolment from a bare session. A stolen session must '
      + 'not be enough to plant or remove a factor — and the narrow TOTP replay '
      + 'scope in server/totpReplay.js depends on this gate being here.'
    ).toEqual([]);
  });

  it('every gated route also spends its grant', () => {
    /**
     * The other half, restated per ROUTE rather than per action.
     *
     * `requireAAL2` is an early refusal, not the check: a gate with no
     * `spendChallenge` leaves the grant replayable for its full five minutes, and
     * every functional test still passes. Guard 5 in authz.completeness.test.js
     * asserts the pairing globally; this pins it on each route in this file, which
     * is where the pairing is easiest to lose while the action stays covered.
     */
    const offenders = blocks
      .filter(b => /requireAAL2\s*\(/.test(b.body))
      .filter(b => !/spendChallenge\s*\(/.test(b.body))
      .map(b => `${b.method} ${b.routePath}`);

    expect(
      offenders,
      'these open a step-up gate and never spend the grant, leaving it replayable.'
    ).toEqual([]);
  });

  it('the gate and the spend name the same action, per route', () => {
    const mismatched = [];
    for (const block of blocks) {
      const gate = block.body.match(/requireAAL2\s*\(\s*'([^']+)'/);
      if (!gate) continue;
      const spends = [...block.body.matchAll(/spendChallenge\s*\([^,]+,[^,]+,\s*'([^']+)'/g)]
        .map(m => m[1]);
      if (spends.length && !spends.includes(gate[1])) {
        mismatched.push(`${block.method} ${block.routePath}: gates '${gate[1]}', spends '${spends.join("', '")}'`);
      }
    }

    expect(
      mismatched,
      'a grant opened for one action cannot be spent on another — the handler would '
      + 'refuse every caller, which reads as verification being broken.'
    ).toEqual([]);
  });

  it('the read-only route is genuinely read-only', () => {
    /* The exemption is earned by the code, not granted by name: anything that
       does not write does not need a gate, and this asserts the converse holds —
       an ungated route in this module must not have acquired a write. */
    for (const block of blocks.filter(b => !/requireAAL2\s*\(/.test(b.body))) {
      expect(
        WRITES.test(block.body),
        `${block.method} ${block.routePath} is ungated but writes`
      ).toBe(false);
    }
  });
});
