import { mkdtempSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
// Safe to import statically, unlike almost everything else in server/: this
// module imports `node:crypto` and nothing else, so it cannot reach db.js and
// cannot bind its connection before startTestServer() sets WEV_DB_PATH. The
// header name has exactly one definition and tests read it from there rather
// than retyping the wire form — see sensitiveActions.js's header.
import { REAUTH_CHALLENGE_HEADER } from './sensitiveActions.js';

/**
 * Boots the real Express app in-process against a throwaway SQLite file.
 *
 * DEMO_MODE is on so the database seeds its demo users (tests assert against
 * them) and the rate limiters stay out of the way. The env vars must be set
 * before db.js and app.js are first imported, which is why the imports here
 * are dynamic.
 */
export async function startTestServer() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wev-test-'));
  process.env.WEV_DB_PATH = path.join(dir, 'test.db');
  process.env.DEMO_MODE = 'true';
  process.env.JWT_SECRET = 'test-secret-not-for-production';

  const { initDatabase, db } = await import('./db.js');
  const { app } = await import('./app.js');

  /**
   * Prove the connection really is the throwaway one.
   *
   * `db.js` opens its database at module scope, so whichever import happens
   * FIRST decides the path — and a static import at the top of a test file is
   * evaluated before any hook runs. One test file statically imported
   * `./routes/eventRoutes.js` (for a single exported constant), which reaches
   * db.js, so the connection was bound to the default `server/wevolunteer.db`
   * before this function ever set WEV_DB_PATH. The dynamic import above then
   * returned the cached module, and the entire file ran against that real file.
   *
   * Nothing failed. It just leaked 25 events per run into a repo-local database
   * — 797 had accumulated before anyone noticed, and the suite only broke when
   * the total crossed a loop guard, which made a leaked fixture look like a
   * pagination bug.
   *
   * PRAGMA database_list reports the path SQLite actually opened, which is the
   * only trustworthy source here: `process.env.WEV_DB_PATH` was set correctly and
   * still described nothing.
   */
  const openedPath = db.prepare('PRAGMA database_list').all()
    .find(r => r.name === 'main')?.file || '';
  // Both sides are resolved through realpath first: on macOS mkdtemp hands back
  // /var/folders/… while SQLite reports /private/var/folders/… for the same file,
  // because /var is a symlink. Comparing the raw strings makes every run look
  // like a failure.
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  if (!real(openedPath).startsWith(real(dir))) {
    throw new Error(
      'startTestServer(): the database connection is not the throwaway one.\n'
      + `  expected under: ${dir}\n`
      + `  actually opened: ${openedPath || '(none)'}\n`
      + '\n'
      + 'db.js opens its connection at module scope, so something imported it\n'
      + 'before this function set WEV_DB_PATH — almost certainly a STATIC import\n'
      + 'at the top of the test file that reaches db.js (directly, or via\n'
      + 'routes/*, utils.js, services/*, attendance.js, eventQuery.js …).\n'
      + 'Move that import inside beforeAll, after startTestServer() resolves.\n'
      + '\n'
      + 'Left unchecked this writes test fixtures into a real database file.'
    );
  }

  initDatabase();

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  /**
   * One HTTP call against the real app.
   *
   * `headers` (added for v1.2b) is how a test presents the step-up challenge
   * header. It is a fifth positional parameter rather than an options object so
   * that the ~1,500 existing four-argument call sites are untouched.
   */
  const call = async (method, p, body, token, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Cookie: `wev_session=${token}` } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { /* empty or non-JSON body */ }
    
    const setCookie = res.headers.get('set-cookie');
    const cookie = setCookie ? setCookie.match(/wev_session=([^;]+)/)?.[1] : null;
    
    return { status: res.status, body: parsed, headers: res.headers, cookie };
  };

  const login = async (email, password = 'password123') => {
    const res = await call('POST', '/api/auth/login', { email, password });
    return res.cookie;
  };
  
  const signup = async (email, password, rest) => {
    const res = await call('POST', '/api/auth/signup', { email, password, ...rest });
    return res.cookie;
  };

  /**
   * Confirms an account's address the way clicking the emailed link would.
   *
   * A signup is unconfirmed by default, and authenticateToken confines an
   * unconfirmed account to a small allowlist — so a fixture that exists only
   * to exercise something else (data export, PII scoping) has to get past
   * that first, or every assertion in the suite reads as a 403.
   *
   * Goes through the real endpoint rather than writing email_verified
   * directly, so the fixtures keep exercising the actual flow.
   */
  const confirmEmail = async (userId) => {
    const { db } = await import('./db.js');
    const row = db.prepare(
      'SELECT token FROM email_verification_tokens WHERE user_id = ? ORDER BY expires_at DESC LIMIT 1'
    ).get(userId);
    if (!row) throw new Error(`No verification token outstanding for ${userId}`);
    const res = await call('POST', '/api/auth/verify-email', { token: row.token });
    if (res.status !== 200) throw new Error(`Could not confirm ${userId}: ${JSON.stringify(res.body)}`);
    return res.cookie;
  };

  /** Signs up and confirms in one step, returning a session cookie ready to use. */
  const signupConfirmed = async (payload) => {
    const res = await call('POST', '/api/auth/signup', payload);
    if (res.status !== 201) throw new Error(`Signup failed: ${JSON.stringify(res.body)}`);
    const cookie = await confirmEmail(res.body.user.id);
    return { cookie, user: res.body.user };
  };

  /**
   * Drives a real step-up challenge to a granted state and returns its id.
   *
   * Goes through both HTTP endpoints — open, then satisfy with the password —
   * rather than writing a `reauth_challenges` row directly, for the same reason
   * `confirmEmail` above posts a token instead of setting `email_verified`: a
   * fixture that fakes the state it needs stops exercising the flow that
   * produces it, and the flow is the thing most likely to break.
   *
   * `params` must be the same object the endpoint under test will bind, because
   * that is the whole point of the params binding. Deliberately does NOT default
   * it from anywhere — a helper that guessed would hide exactly the mismatch the
   * binding exists to catch.
   *
   * Returns only the id: presenting it is the caller's job, via the
   * `X-Reauth-Challenge` header, so a test that forgets to present it fails
   * rather than passing on a grant nobody spent. Throws on any refusal, so a
   * broken fixture reads as a broken fixture and not as the assertion failing.
   */
  const stepUp = async (token, action, { params = {}, password = 'password123' } = {}) => {
    const opened = await call('POST', '/api/auth/reauth/challenge', { action, params }, token);
    if (opened.status !== 201) {
      throw new Error(`stepUp('${action}'): challenge failed ${opened.status} ${JSON.stringify(opened.body)}`);
    }
    const granted = await call(
      'POST', '/api/auth/reauth/password',
      { challengeId: opened.body.challengeId, password },
      token
    );
    if (granted.status !== 200) {
      throw new Error(`stepUp('${action}'): grant failed ${granted.status} ${JSON.stringify(granted.body)}`);
    }
    return opened.body.challengeId;
  };

  /**
   * The same, satisfied by provider re-consent instead of a password.
   *
   * This is the path a provider-only account has to take, and the only one it
   * can: it holds no password, so `openChallenge` never offers it the password
   * prompt. Every step goes through the real endpoints — redirect, state,
   * callback — because the `sub` comparison inside `grantByOAuth` is the entire
   * security of this route and a fixture that wrote `granted_at` directly would
   * exercise none of it.
   *
   * `sub` must be the `provider_user_id` on the account's own `oauth_accounts`
   * row; a different one is a wrong answer that costs an attempt, by design.
   * Requires `OAUTH_ALLOW_MOCK=true`, set by the caller before startTestServer().
   */
  const stepUpOAuth = async (token, action, { params = {}, provider = 'google', sub } = {}) => {
    const opened = await call('POST', '/api/auth/reauth/challenge', { action, params }, token);
    if (opened.status !== 201) {
      throw new Error(`stepUpOAuth('${action}'): challenge failed ${opened.status} ${JSON.stringify(opened.body)}`);
    }
    const challengeId = opened.body.challengeId;

    // redirect: 'manual' — following it would leave for the real provider.
    const redirected = await fetch(
      `${base}/api/auth/reauth/oauth/${provider}?challengeId=${encodeURIComponent(challengeId)}`,
      { redirect: 'manual', headers: { Cookie: `wev_session=${token}` } }
    );
    if (redirected.status !== 302) {
      throw new Error(`stepUpOAuth('${action}'): expected a 302 to ${provider}, got ${redirected.status}`);
    }
    const state = new URL(redirected.headers.get('location')).searchParams.get('state');

    const granted = await call(
      'POST', `/api/auth/reauth/oauth/${provider}/callback`,
      // The mock transport reads the provider's claims straight out of `code`.
      { code: JSON.stringify({ sub, email: 'reconsent@example.org', name: 'Re-consent' }), state },
      token
    );
    if (granted.status !== 200) {
      throw new Error(`stepUpOAuth('${action}'): grant failed ${granted.status} ${JSON.stringify(granted.body)}`);
    }
    return challengeId;
  };

  /** The header a granted challenge is presented in. One spelling, from the source. */
  const reauthHeader = (challengeId) => ({ [REAUTH_CHALLENGE_HEADER]: challengeId });

  /**
   * Opens a challenge, grants it, and returns the header that spends it.
   *
   * The two-step form (`stepUp` then `reauthHeader`) stays available for the
   * tests that need the id itself — the single-use test spends the same one
   * twice, and the cross-action tests deliberately mismatch what they present.
   */
  const verified = async (token, action, opts) => reauthHeader(await stepUp(token, action, opts));

  const close = () => new Promise(resolve => {
    server.close(() => { rmSync(dir, { recursive: true, force: true }); resolve(); });
  });

  return {
    base,
    close,
    call,
    login,
    signup,
    confirmEmail,
    signupConfirmed,
    stepUp,
    stepUpOAuth,
    reauthHeader,
    verified
  };
}
