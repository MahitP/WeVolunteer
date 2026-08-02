import { OAuth2Client } from 'google-auth-library';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI, OAUTH_ALLOW_MOCK } from '../../config.js';

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
  getAuthUrl(state, { forceReauth = false } = {}) {
    return client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
      state,
      prompt: forceReauth ? 'login' : 'select_account',
      ...(forceReauth ? { max_age: 0 } : {})
    });
  },

  async verifyCallback(code) {
    // Test transport. Gated on an explicit opt-in that config.js refuses to
    // honour in production — never on "the client id happens to be missing",
    // which is what turned this into an unauthenticated impersonation endpoint.
    if (OAUTH_ALLOW_MOCK) {
      try {
        const parsed = JSON.parse(code);
        return { ...parsed, emailVerified: parsed.emailVerified !== false };
      } catch {
        return { email: 'mock@example.com', sub: '12345', name: 'Mock User', emailVerified: true };
      }
    }

    const { tokens } = await client.getToken(code);
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();

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
