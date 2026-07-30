import { OAuth2Client } from 'google-auth-library';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI, OAUTH_ALLOW_MOCK } from '../../config.js';

const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI);

export default {
  id: 'google',
  label: 'Google',

  getAuthUrl(state) {
    return client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
      state,
      /**
       * `select_account`, not `consent`.
       *
       * `consent` forces the full scope-approval screen on every single
       * sign-in, so a returning student re-authorised the app each time they
       * came back — which reads as "this site keeps asking for permission
       * again", the exact signal people are taught to treat as suspicious.
       * `select_account` still lets someone switch between a school and a
       * personal Google account, which is the one thing the prompt is
       * genuinely useful for here, and matches what the Microsoft provider
       * already asks for.
       */
      prompt: 'select_account'
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
