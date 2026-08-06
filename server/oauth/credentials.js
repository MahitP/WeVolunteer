/**
 * The one rule every provider's `getAuthUrl` obeys: never mint a URL with
 * credentials that are not there.
 *
 * ── The incident ──
 *
 * With MICROSOFT_CLIENT_ID unset, `microsoft.js` built and returned
 *
 *     https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=&…
 *
 * `POST /api/oauth/microsoft/url` answered 200 with it, the browser followed it,
 * and Microsoft ended the journey with
 *
 *     AADSTS900144: The request body must contain the following parameter:
 *     'client_id'
 *
 * The user had already left the site by then, which is the worst place to
 * discover a configuration mistake. Google had the identical defect and was
 * hidden only by happening to have real credentials in `.env`.
 *
 * Hiding the button (see OAUTH_PROVIDERS_CONFIGURED in config.js) stops an
 * ordinary person reaching it, but it is presentation, and presentation is not
 * an invariant — the mint endpoint is reachable directly, `reauthRoutes.js`
 * calls `getAuthUrl` down a second path, and a future provider added to the
 * table would inherit the defect rather than the guard. So the refusal lives
 * here, at the point where a URL is actually constructed.
 *
 * ── Why it throws rather than returning null ──
 *
 * Both call sites (`oauthRoutes.js`, `reauthRoutes.js`) already wrap
 * `getAuthUrl` in try/catch and answer 503 with a message naming the provider.
 * Throwing therefore lands in handling that already exists and already says the
 * right thing; a null would need every caller to grow a new branch, and the one
 * that forgot would return `undefined` to `window.location`.
 *
 * ── Why the mock does not exempt it ──
 *
 * OAUTH_ALLOW_MOCK is a CALLBACK-side transport: `verifyCallback` reads its
 * identity out of the `code` parameter. It has nothing to offer the redirect
 * that starts the flow, which always goes to the real provider. Letting the mock
 * wave this through is precisely what kept the empty-client_id URL alive in
 * development, where it was found. Tests that need a URL configure credentials
 * like any deployment does — `testServer.js` sets them for the whole server
 * suite.
 */
export class OAuthNotConfiguredError extends Error {
  constructor(providerId, missing) {
    super(
      `${providerId} OAuth is not configured: ${missing.join(' and ')} `
      + `${missing.length === 1 ? 'is' : 'are'} empty. `
      + 'Set them in the environment, or leave the provider unconfigured and it '
      + 'will not be offered as a sign-in option.'
    );
    this.name = 'OAuthNotConfiguredError';
    this.providerId = providerId;
    this.missing = missing;
  }
}

/**
 * Throws unless both halves of a provider's credentials are present.
 *
 * The secret is checked alongside the id even though only the id appears in the
 * authorize URL. A deployment with an id and no secret produces a URL that works
 * — the user signs in at the provider, comes back with a real code, and the
 * failure surfaces at the token exchange instead, after the round trip. Refusing
 * up front turns a confusing late failure into an honest early one.
 */
export function assertProviderConfigured(providerId, { clientId, clientSecret }) {
  const missing = [];
  if (!clientId) missing.push(`${providerId.toUpperCase()}_CLIENT_ID`);
  if (!clientSecret) missing.push(`${providerId.toUpperCase()}_CLIENT_SECRET`);
  if (missing.length > 0) throw new OAuthNotConfiguredError(providerId, missing);
}
