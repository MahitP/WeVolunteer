import { MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, OAUTH_REDIRECT_URI, OAUTH_ALLOW_MOCK } from '../../config.js';

export default {
  id: 'microsoft',
  label: 'Microsoft',

  /**
   * `forceReauth` forces a genuine re-authentication for step-up (v1.2b).
   *
   * `prompt=login` is the Microsoft identity platform's documented instruction
   * to re-authenticate rather than answer from an existing session. Without it
   * a re-verification redirect returns immediately with a fresh assertion built
   * on an old sign-in, which proves nothing beyond what the stolen session
   * already proved.
   *
   * `max_age` is deliberately NOT sent here, unlike google.js. Google is the
   * provider where the two are worth pairing; Microsoft honours `prompt=login`
   * directly, and adding an OIDC parameter that has not been verified against a
   * real tenant would be a guess dressed up as a hardening measure. If this
   * flow is ever exercised against a live Azure tenant, `max_age=0` is the
   * first thing to try adding, and `routes.reauth.test.js` is where the
   * assertion goes.
   */
  getAuthUrl(state, { forceReauth = false } = {}) {
    const params = new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      response_type: 'code',
      // One redirect URI serves every provider: the SPA reads the provider out
      // of the signed `state` it gets back, so the path does not need to carry
      // it. The previous `.replace('/google/', '/microsoft/')` was a no-op
      // against the configured value ("…/oauth/callback") — it read as
      // provider-specific routing that never actually happened.
      redirect_uri: OAUTH_REDIRECT_URI,
      response_mode: 'query',
      scope: 'openid profile email User.Read',
      state,
      prompt: forceReauth ? 'login' : 'select_account'
    });
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
  },

  async verifyCallback(code) {
    // See the note in google.js — opt-in only, and config.js refuses to let
    // this flag exist in a production process.
    if (OAUTH_ALLOW_MOCK) {
      try {
        const parsed = JSON.parse(code);
        return { ...parsed, emailVerified: parsed.emailVerified === true };
      } catch {
        return { email: 'mock_ms@example.com', sub: 'ms-12345', name: 'Mock MS User', emailVerified: false };
      }
    }

    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MICROSOFT_CLIENT_ID,
        client_secret: MICROSOFT_CLIENT_SECRET,
        code,
        redirect_uri: OAUTH_REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(`Failed to exchange Microsoft token: ${err}`);
    }

    const { access_token } = await tokenRes.json();

    const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    if (!profileRes.ok) {
      throw new Error('Failed to fetch Microsoft profile');
    }

    const profile = await profileRes.json();

    /**
     * No profile-photo fetch.
     *
     * This used to download /me/photo/$value on every single Microsoft
     * sign-in, base64 it into a data: URI, and return it as `avatar` — which
     * nothing ever read. `oauthRoutes.js` takes its avatar from
     * `validateAccountFields`, whose rule is "a single emoji, 8 characters or
     * fewer", so a base64 image could not have been stored even if something
     * had tried. It was a network round-trip and a multi-megabyte string
     * allocated per sign-in to produce a value that was immediately discarded.
     *
     * If real photo avatars are ever wanted, they need a storage decision, a
     * size limit and a CSP img-src review — not a silent extra fetch here.
     */
    return {
      email: profile.mail || profile.userPrincipalName,
      sub: profile.id,
      name: profile.displayName,
      /**
       * Deliberately false.
       *
       * Graph's /me returns `mail` and `userPrincipalName` as directory
       * attributes. Neither carries a proof-of-control claim the way Google's
       * `email_verified` does, and in a tenant the caller administers both can
       * be set to an arbitrary string — including someone else's address.
       * Trusting that is how someone with any Azure tenant mints a
       * pre-verified WeVolunteer account for a teacher's address.
       *
       * So a Microsoft sign-up still confirms its address by mail. Once the
       * account exists, matching on provider_user_id means the user never sees
       * this step again.
       */
      emailVerified: false
    };
  }
};
