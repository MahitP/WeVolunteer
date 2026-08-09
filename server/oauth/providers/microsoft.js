import { MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID, OAUTH_REDIRECT_URI } from '../../config.js';
import { assertProviderConfigured } from '../credentials.js';
import { mockVerifyCallback } from '../mockTransport.js';
import { authorizeParams } from '../pkce.js';

/**
 * The authority this deployment signs in against.
 *
 * `common` accepts every Entra directory and personal Microsoft accounts; a
 * tenant GUID accepts one. See MICROSOFT_TENANT_ID in config.js for why a
 * district that has decided should say so — and note that `verifyCallback`
 * re-checks the `tid` claim, so this URL is not the only thing enforcing it.
 */
const AUTHORITY = `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}`;

/**
 * The ID token's claims, without verifying its signature.
 *
 * Named for exactly what it does. The reasoning for not verifying — and the
 * conditions under which that stops being acceptable — is on `verifyCallback`
 * below, beside the checks that make the claims worth reading.
 */
function decodeIdTokenPayload(idToken) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) {
    throw new Error('Microsoft ID token is not a well-formed JWT.');
  }
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Microsoft ID token payload could not be read.');
  }
}

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
  getAuthUrl(state, { forceReauth = false, codeVerifier = null, oidcNonce = null } = {}) {
    // Never mint `client_id=`. This is the AADSTS900144 the pilot hit — see
    // ../credentials.js for why the refusal lives at construction time and why
    // the mock does not exempt it.
    assertProviderConfigured('microsoft', {
      clientId: MICROSOFT_CLIENT_ID,
      clientSecret: MICROSOFT_CLIENT_SECRET,
    });

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
      /**
       * `User.Read` is gone.
       *
       * It was requested so the callback could call Graph `/me`. The callback now
       * reads the identity out of the ID token instead, so the scope bought
       * nothing except a directory-read consent prompt that a district
       * administrator would reasonably ask about. `openid profile email` is the
       * whole requirement, and asking for less is the point.
       */
      scope: 'openid profile email',
      state,
      prompt: forceReauth ? 'login' : 'select_account',
      ...(codeVerifier ? authorizeParams(codeVerifier) : {}),
      ...(oidcNonce ? { nonce: oidcNonce } : {})
    });
    return `${AUTHORITY}/oauth2/v2.0/authorize?${params.toString()}`;
  },

  async verifyCallback(code, { codeVerifier = null, expectedNonce = null } = {}) {
    /* Test transport — see ../mockTransport.js. Opt-in only, never fabricates
       an identity, and config.js refuses to let the flag exist in production. */
    const mocked = mockVerifyCallback('microsoft', code);
    if (mocked) {
      /* `=== true`, not `!== false`, and the asymmetry with google.js is
         deliberate — see the note on the real branch below. A Microsoft identity
         is unverified unless something explicitly vouches for it. */
      return { ...mocked, emailVerified: mocked.emailVerified === true };
    }

    const tokenRes = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MICROSOFT_CLIENT_ID,
        client_secret: MICROSOFT_CLIENT_SECRET,
        code,
        redirect_uri: OAUTH_REDIRECT_URI,
        grant_type: 'authorization_code',
        scope: 'openid profile email',
        ...(codeVerifier ? { code_verifier: codeVerifier } : {})
      })
    });

    if (!tokenRes.ok) {
      /* The body carries `error_description`, which is where AADSTS codes live
         and is the difference between "it failed" and "the redirect URI does not
         match the app registration". Logged, not returned: it can name tenant
         configuration. */
      const detail = await tokenRes.text();
      console.error('Microsoft token exchange failed:', detail);
      throw new Error('Microsoft sign-in could not be completed. Please try again.');
    }

    const { id_token: idToken } = await tokenRes.json();
    if (!idToken) {
      throw new Error('Microsoft did not return an ID token. Check that the app registration requests the openid scope.');
    }

    const payload = decodeIdTokenPayload(idToken);

    /**
     * ── Why the identity comes from the ID TOKEN and not from Graph `/me` ──
     *
     * This used to exchange the code for an access token and then call
     * `https://graph.microsoft.com/v1.0/me`. That worked, and it was the wrong
     * shape for three reasons: it spent a second network round-trip inside a
     * sign-in, it needed the `User.Read` consent scope purely to learn an address,
     * and it took the identity from a DIRECTORY LOOKUP rather than from the signed
     * assertion the provider issued for this specific authorization — so there was
     * nothing to compare a nonce against and nothing tying the answer to the flow.
     *
     * ── Why the signature is not verified here ──
     *
     * Deliberate, and spec-sanctioned rather than skipped. OpenID Connect Core
     * §3.1.3.7 item 6 permits omitting ID-token signature validation when the
     * token is obtained directly from the token endpoint over TLS, using client
     * authentication — which is exactly this call: `client_secret` is presented,
     * the connection is HTTPS to a pinned Microsoft host, and the token never
     * transits the browser. The signature would prove the same thing the transport
     * already proves.
     *
     * The claims below are checked ANYWAY, because they catch a different class of
     * problem: not forgery, but misconfiguration. A token minted for a different
     * application, or by a directory this deployment does not accept, is what
     * `aud` and `tid` are read for.
     *
     * If this ever stops arriving directly from the token endpoint — an implicit
     * or hybrid flow, a token forwarded by a client — signature verification
     * becomes mandatory and a JWKS client (Microsoft publishes one at
     * `${AUTHORITY}/discovery/v2.0/keys`) has to be added before that change.
     */
    if (payload.aud !== MICROSOFT_CLIENT_ID) {
      throw new Error('Microsoft ID token was issued for a different application.');
    }

    /**
     * The issuer, per Microsoft's own rule for the multi-tenant endpoint.
     *
     * With `common`, `iss` is tenant-specific — `…/{tid}/v2.0` — so it cannot be
     * compared against a fixed string, and a naive equality check against the
     * authority URL fails every real token. It is checked against the token's own
     * `tid`, which is only meaningful because `tid` itself is constrained below.
     */
    const expectedIssuers = [
      `https://login.microsoftonline.com/${payload.tid}/v2.0`,
      `https://sts.windows.net/${payload.tid}/`
    ];
    if (!payload.tid || !expectedIssuers.includes(payload.iss)) {
      throw new Error('Microsoft ID token issuer is not recognised.');
    }

    /**
     * The tenant restriction, enforced HERE and not only at the authorize URL.
     *
     * A tenant-pinned authority stops the provider issuing a token for another
     * directory, and that is the primary control. This is the second half: the
     * authorize URL is built from configuration, so anything that ever caused a
     * `common` URL to be used — a stale cached URL, a hand-assembled request, a
     * future refactor — would silently widen sign-in to every Microsoft account on
     * the internet. A deployment that names its tenant refuses every other one.
     */
    if (MICROSOFT_TENANT_ID !== 'common' && payload.tid !== MICROSOFT_TENANT_ID) {
      throw new Error('That Microsoft account is not part of this organization.');
    }

    if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) {
      throw new Error('Microsoft ID token has expired. Please try signing in again.');
    }

    /* Binds the assertion to THIS authorization — see the same check in
       google.js. Compared against the server's stored value, never the request's. */
    if (expectedNonce && payload.nonce !== expectedNonce) {
      throw new Error('Microsoft ID token was issued for a different sign-in attempt.');
    }

    /**
     * `oid` is the stable subject, not `sub`.
     *
     * `sub` is pairwise — scoped to the (user, application) pair — so it is stable
     * for this app and would work. `oid` is the directory object id, the same value
     * Graph reports as `id`, and is what an administrator can actually look up when
     * asked "which account is this row". Both are stable; `oid` is the one a human
     * can act on. Falls back to `sub` for a personal Microsoft account, where `oid`
     * may be absent.
     */
    const subject = payload.oid || payload.sub;
    if (!subject) {
      throw new Error('Microsoft ID token carried no subject identifier.');
    }

    return {
      email: payload.email || payload.preferred_username || payload.upn,
      sub: subject,
      name: payload.name,
      /**
       * Deliberately false, unchanged by the move to the ID token.
       *
       * `email` and `preferred_username` are directory attributes. Neither carries
       * a proof-of-control claim the way Google's `email_verified` does, and in a
       * tenant the caller administers both can be set to an arbitrary string —
       * including somebody else's address. Trusting that is how a person with any
       * Azure tenant mints a pre-verified WeVolunteer account for a teacher's
       * address.
       *
       * So a Microsoft sign-up still confirms its address by mail. Once the account
       * exists, matching on the provider subject means the user never sees this
       * step again.
       */
      emailVerified: false
    };
  }
};