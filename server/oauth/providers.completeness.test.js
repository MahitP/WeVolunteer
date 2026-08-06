/**
 * Structural guards over the sign-in provider table.
 *
 * ── Why this file exists ──
 *
 * `server/oauth/credentials.js` fixed the AADSTS900144 incident by refusing to
 * mint an authorization URL without credentials, and it fixed it at the point
 * where the URL is constructed rather than at the button. That is the right
 * place, but it made the refusal a CONVENTION: `google.js` and `microsoft.js`
 * each remember to call `assertProviderConfigured`, and nothing stops the third
 * provider from forgetting.
 *
 * Forgetting is not a hypothetical. Both existing providers shipped without the
 * guard, and Google's absence was masked for months purely by having real
 * credentials in `.env` — i.e. the defect is invisible in exactly the
 * environment its author is working in. A provider added next year, tested by
 * somebody who has that provider's credentials, reproduces the incident
 * verbatim.
 *
 * `config.oauthProviders.test.js` pins the six states a provider can be in, but
 * it looped over a hand-written `['google', 'microsoft']`. A hand-written list
 * is a guard that silently stops covering the thing it was written for the
 * moment a fourth file lands in this directory — the same failure mode
 * `errorStyles.test.js` documents for its animated-class list, and the same one
 * `authz.completeness.test.js` exists to prevent for route gates.
 *
 * So these two guards derive their subject from the filesystem. Adding a
 * provider that mints a URL without checking its credentials fails the build,
 * and adding one that no state test covers fails the build.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'server', 'oauth', 'providers');

/** Every provider module, as [id, source]. */
const PROVIDERS = readdirSync(DIR)
  .filter(f => f.endsWith('.js') && !f.includes('.test.'))
  .map(f => [path.basename(f, '.js'), readFileSync(path.join(DIR, f), 'utf8')]);

it('finds the provider directory it is guarding', () => {
  // A rename that empties PROVIDERS would make every assertion below vacuous.
  expect(PROVIDERS.length).toBeGreaterThan(0);
  expect(PROVIDERS.map(([id]) => id)).toContain('google');
});

/**
 * A provider is "implemented" if it does not declare itself otherwise.
 *
 * Read from the source rather than by importing the module, because importing
 * reaches `config.js`, which reads `process.env` at module scope — and the whole
 * point of the sibling state tests spawning subprocesses is that this suite's
 * environment has both providers configured.
 */
function isImplemented(source) {
  return !/implemented:\s*false/.test(source);
}

describe('every provider refuses to mint without credentials', () => {
  for (const [id, source] of PROVIDERS) {
    it(`${id}: getAuthUrl cannot produce a URL with empty credentials`, () => {
      if (!isImplemented(source)) {
        /**
         * An unimplemented provider satisfies the invariant a stronger way: it
         * has no credential path to get wrong because it never returns a URL at
         * all. `apple.js` is this case, and it is the reason the check is
         * "refuses to mint" rather than "calls the guard" — requiring the call
         * would force a placeholder to import a credential checker for
         * credentials that do not exist.
         *
         * The placeholder must actually throw, though. It previously returned
         * the string '#apple-not-yet-implemented', which the client assigned to
         * `window.location` — a button that silently did nothing.
         */
        expect(source, `${id} declares implemented: false but getAuthUrl does not throw`)
          .toMatch(/getAuthUrl\s*\([^)]*\)\s*\{[^}]*throw/s);
        return;
      }

      expect(
        source,
        `${id}/getAuthUrl mints an authorization URL without calling `
        + 'assertProviderConfigured. That is the AADSTS900144 defect: the URL is '
        + 'built with client_id= and the user discovers it at the provider, after '
        + 'leaving the site. Import the guard from ../credentials.js and call it '
        + 'before building the URL — see server/oauth/credentials.js.',
      ).toMatch(/assertProviderConfigured\s*\(/);
    });
  }
});

/**
 * The six-state matrix itself lives in `config.oauthProviders.test.js`, which
 * derives its own loop from this same directory and fails on a provider with no
 * credential fixtures. So "is this provider state-tested at all" is enforced
 * there, at the point where the fixtures are declared, rather than restated here
 * as a search for the provider's name in another file's source.
 */
