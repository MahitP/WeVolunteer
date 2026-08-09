import { OAuth2Client } from 'google-auth-library';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI } from '../../config.js';
import { assertProviderConfigured } from '../credentials.js';
import { mockVerifyCallback } from '../mockTransport.js';
import { authorizeParams } from '../pkce.js';

const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI);

export default {
  id: 'google',
  label: 'Google',

  /**
   * `forceReauth` is what makes step-up (v1.2b) a proof of identity.
   *
   * Ordinary sign-in and re-verification ask Google for two different things,
   * and the difference is the entire feature:
   *
   *   • Sign-in (`forceReauth: false`) — `select_account`, not `consent`.
   *     `consent` forces the full scope-approval screen on every single
   *     sign-in, so a returning student re-authorised the app each time they
   *     came back, which reads as "this site keeps asking for permission
   *     again" — the exact signal people are taught to treat as suspicious.
   *     `select_account` still lets someone switch between a school and a
   *     personal Google account, which is the one thing the prompt is
   *     genuinely useful for here, and matches what the Microsoft provider
   *     already asks for.
   *
   *   • Re-verification (`forceReauth: true`) — `prompt=login` AND
   *     `max_age=0`. Either prompt on its own can be answered from the session
   *     Google already holds, and an assertion reissued from an existing
   *     session says only "this browser signed in at some point", which is
   *     precisely what a stolen session already demonstrates. `prompt=login`
   *     asks for re-authentication; `max_age=0` states that no cached
   *     authentication of any age is acceptable, which is what makes it a
   *     requirement rather than a request. Without both, step-up silently
   *     degrades to a redirect that always succeeds — and it degrades
   *     INVISIBLY, because the flow still completes.
   *
   * The parameters are passed through `generateAuthUrl`, which query-string-
   * encodes every option it is given, so `max_age` reaches Google despite not
   * being one of the library's named fields. `routes.reauth.test.js` asserts
   * on the generated URL rather than on this call, because that is the only
   * form of the check that survives a library upgrade dropping an option.
   */
  getAuthUrl(state, { forceReauth = false, codeVerifier = null, oidcNonce = null } = {}) {
    /**
     * Same refusal as microsoft.js, and it matters here despite Google being the
     * provider that happens to be configured today. `generateAuthUrl` does not
     * validate: with no client id it returns a URL carrying `client_id=` exactly
     * as the hand-built Microsoft one did. This defect was Microsoft-shaped only
     * by accident of which credentials were in .env.
     */
    assertProviderConfigured('google', {
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
    });

    return client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
      state,
      prompt: forceReauth ? 'login' : 'select_account',
      ...(forceReauth ? { max_age: 0 } : {}),
      /* PKCE. `generateAuthUrl` passes unknown options straight into the query
         string, which is how `max_age` above reaches Google too. Omitted rather
         than sent empty when there is no verifier, because `code_challenge=` with
         no value is a request Google rejects. */
      ...(codeVerifier ? authorizeParams(codeVerifier) : {}),
      /* Echoed into the ID token and compared in verifyCallback, which is what
         stops an ID token obtained for one authorization being replayed into
         another. */
      ...(oidcNonce ? { nonce: oidcNonce } : {})
    });
  },

  async verifyCallback(code, { codeVerifier = null, expectedNonce = null } = {}) {
    /* Test transport, in ../mockTransport.js — gated on an explicit opt-in that
       config.js refuses to honour in production, and which no longer invents an
       identity when the `code` is not one. Returns null when the real exchange
       below is what must happen. */
    const mocked = mockVerifyCallback('google', code);
    if (mocked) {
      /* Google asserts `email_verified`, so an identity that does not say
         otherwise is treated as verified — matching the real branch below. */
      return { ...mocked, emailVerified: mocked.emailVerified !== false };
    }

    /* `getToken` takes an object so the verifier can travel with the code. The
       string form (`getToken(code)`) has no way to carry it, which is why this
       changed shape. */
    const { tokens } = await client.getToken({
      code,
      ...(codeVerifier ? { codeVerifier } : {})
    });

    /**
     * Signature, issuer and audience, all checked by the library.
     *
     * `verifyIdToken` fetches and caches Google's JWKS, verifies the RS256
     * signature, requires `iss` to be accounts.google.com, enforces `exp`, and
     * rejects any `aud` other than the value passed here. Passing
     * `GOOGLE_CLIENT_ID` is what makes it audience validation rather than a
     * decode: an ID token minted for a DIFFERENT Google client — trivial for
     * anybody to obtain, since it only requires their own app — would otherwise
     * be accepted here and would let them sign in as any address it named.
     */
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();

    /**
     * The nonce binding, checked when we set one.
     *
     * Audience validation proves the token was minted for this application; it
     * says nothing about WHICH sign-in produced it. Without this, an ID token
     * captured from one of our own authorizations could be presented against a
     * different in-flight one. Compared against the value stored server-side, not
     * against anything in the request.
     */
    if (expectedNonce && payload.nonce !== expectedNonce) {
      throw new Error('Google ID token was issued for a different sign-in attempt.');
    }

    if (payload.email_verified === false) {
      throw new Error('Google account email is not verified. Please verify your email with Google first.');
    }

    return {
      email: payload.email,
      sub: payload.sub,
      name: payload.name,
      // Google asserts this explicitly and `false` was rejected above, so an
      // address arriving here is one Google confirmed the user controls.
      emailVerified: payload.email_verified === true
    };
  }
};
