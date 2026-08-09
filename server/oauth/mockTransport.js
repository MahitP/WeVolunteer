import { OAUTH_ALLOW_MOCK } from '../config.js';

/**
 * The OAuth test transport, in one place instead of two.
 *
 * ── What it is for ──
 *
 * Every automated test of a sign-in, an account link, a data export or an
 * account deletion has to arrive at the callback holding a provider identity,
 * and there is no way to obtain one from Google or Microsoft in a unit test. So
 * suites opt in to this transport and pass the identity they want as the `code`,
 * as JSON. `startTestServer` documents the opt-in; `OAUTH_ALLOW_MOCK` in
 * config.js documents why it can never exist in a production process.
 *
 * ── Why it no longer INVENTS an identity ──
 *
 * Both providers used to end their mock branch with a fallback:
 *
 *     catch { return { email: 'mock@example.com', name: 'Mock User', … }; }
 *
 * so any `code` that was not JSON produced a fabricated account. That fallback
 * is what made the following happen to a developer with working Google
 * credentials in `.env`: they pressed "Continue with Google", authenticated with
 * Google for real, came back with a genuine authorization code — an opaque
 * string, not JSON — and the signup form filled itself in with **"Mock User"**
 * and **"mock@example.com"**. The real credentials were never consulted, because
 * the flag was checked first and defaulted to on outside production.
 *
 * The flag's default is fixed separately (config.js). This is the other half:
 * production code must never manufacture an identity nobody supplied. A test
 * that wants an identity states it; anything else is an error, and an error is
 * the only honest answer to "the provider said nothing and no test told us
 * either". The strings `Mock User` and `mock@example.com` no longer exist
 * anywhere in this repository, which is a property `oauth.noFakeIdentity.test.js`
 * asserts by scanning the tree.
 *
 * @param {string} providerId  for the error message and the warning
 * @param {string} code        the request's `code`; a JSON identity when mocking
 * @returns {object|null}      the identity, or null when the caller must do the
 *                             real code exchange
 */
export function mockVerifyCallback(providerId, code) {
  if (!OAUTH_ALLOW_MOCK) return null;

  let parsed;
  try {
    parsed = JSON.parse(code);
  } catch {
    /**
     * Deliberately an error, and deliberately this wording.
     *
     * This is the branch a real authorization code lands in when somebody has
     * the flag set by accident, so the message has to name the actual situation
     * rather than say "invalid code". It is the difference between five seconds
     * and an afternoon.
     */
    throw new Error(
      `OAUTH_ALLOW_MOCK is enabled, so the ${providerId} callback expected a JSON `
      + 'identity as the `code` and got something else — which is what a REAL '
      + 'authorization code looks like. Unset OAUTH_ALLOW_MOCK to use the real '
      + `${providerId} flow, or pass an identity such as `
      + '{"email":"a@b.org","sub":"1","name":"A B","emailVerified":true}.'
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Mock ${providerId} identity must be a JSON object.`);
  }
  /* `sub` is the provider's stable subject id and is what account linking keys
     on, so an identity without one is not usable and failing here beats writing
     a row keyed on undefined. */
  if (!parsed.email || !parsed.sub) {
    throw new Error(`Mock ${providerId} identity requires both "email" and "sub".`);
  }

  /**
   * Announced on every use.
   *
   * A silent fake identity is what the incident above was made of. If this line
   * appears in a log that is not a test run, the flag is set somewhere it should
   * not be, and that is worth being unmissable.
   */
  console.warn(
    `[oauth] MOCK transport used for ${providerId} — identity taken from the request, `
    + 'NOT from the provider. This must never appear outside a test run.'
  );

  return parsed;
}
