/**
 * Apple Sign-In — not implemented.
 *
 * Kept as an explicit, loudly-failing placeholder rather than a silent one.
 * `getAuthUrl` used to return the string '#apple-not-yet-implemented', which
 * the client assigned to window.location — so pressing "Continue with Apple"
 * on the signup screen appeared to do nothing at all, with no error and no
 * explanation. Throwing means the route answers 501 and the UI can say so.
 *
 * A real implementation needs APPLE_CLIENT_ID (Services ID), APPLE_TEAM_ID,
 * APPLE_KEY_ID and the .p8 private key, plus client-secret JWT generation and
 * form_post response-mode handling, because Apple POSTs the callback rather
 * than redirecting with query parameters.
 */
export default {
  id: 'apple',
  label: 'Apple',
  implemented: false,

  getAuthUrl() {
    throw new Error('Apple Sign-In is not available yet.');
  },

  async verifyCallback() {
    throw new Error('Apple Sign-In is not available yet.');
  }
};
