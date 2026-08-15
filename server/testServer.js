// Re-exported so suites already importing from here need no second import.
// Defined in testConsent.js because that module never reaches db.js.
export { TEST_CONSENT, TEST_SIGNUP_DEFAULTS } from './testConsent.js';
import { TEST_SIGNUP_DEFAULTS } from './testConsent.js';
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
/**
 * The base32 TOTP secret every seeded administrator is enrolled with.
 *
 * Fixed and in the open on purpose: it is a test fixture and protects nothing.
 * 32 characters of base32 — otplib v13 rejects anything under 16 bytes, which is
 * why the shorter secrets that read naturally (`JBSWY3DPEHPK3PXP`) cannot be
 * used here.
 */
export const TEST_TOTP_SECRET = 'UZ4DHT22AL6CQMULDYSGGT4YT4UU2GMT';

/** A code for `secret` in a step nothing has spent yet. See `freshTotpToken`. */
export const freshTotp = (secret = TEST_TOTP_SECRET, accountKey) => freshTotpToken(secret, accountKey);

/**
 * Enrols an account in two-factor authentication, by address.
 *
 * For the suites that mint a privileged session by promoting a throwaway account
 * with direct SQL and reusing a cookie they already hold — `authz.matrix` and
 * `routes.errorTriage` do exactly that, deliberately, because identity is
 * re-derived from the users row on every request and no re-login is needed.
 *
 * Those never call `login()`, so the enrolment it performs does not reach them,
 * and `requireCap` then refuses the account with `tfa_required`. Exported rather
 * than duplicated so there is one answer to "how does a test make a compliant
 * administrator", and so the next suite that promotes by SQL has something to
 * find.
 */
export async function enrolTwoFactor(db, email) {
  const { encryptSecret } = await import('./cryptoUtils.js');
  db.prepare('UPDATE users SET tfa_enabled = 1, tfa_secret = ? WHERE email = ?')
    .run(encryptSecret(TEST_TOTP_SECRET), email);
}

/**
 * The 30-second TOTP step, and the last one this process has spent per secret.
 *
 * ── Why the harness has to track this ──
 *
 * TOTP codes are now single-use: `verifyTotpOnce` records the step it accepted
 * against `users.tfa_last_counter` and refuses anything at or below it, which is
 * what RFC 6238 §5.2 requires and what this platform previously did not do.
 *
 * A consequence falls straight out of that, and it is real product behaviour
 * rather than a test problem: within one 30-second window an account can spend one
 * code and no more. A suite that signs the same account in twice — or signs in and
 * then disables 2FA — is asking to reuse a code, and the server is right to refuse
 * it. Roughly a third of the 2FA suite did exactly that.
 *
 * So the harness waits for a fresh step instead of pretending the rule is not
 * there. Weakening the rule to keep the fixtures convenient would be testing a
 * product nobody ships.
 */
const TOTP_STEP_MS = 30_000;
const spentSteps = new Map();

/**
 * Keyed per ACCOUNT, not per secret.
 *
 * `users.tfa_last_counter` is a per-user column, and the seed gives every
 * administrator the SAME `TEST_TOTP_SECRET` — so keying on the secret would make
 * signing in as one admin block signing in as another for the rest of the step,
 * waiting thirty seconds for a collision the server would never have reported.
 */
async function freshTotpToken(secret, accountKey = secret) {
  const { generateSync } = await import('otplib');

  /* Only the boundary guard remains: wait if too little of the step is left for
     the request to be verified inside it, which is the race that made an enrolment
     test fail one run in three. Waiting for an UNSPENT step is handled by clearing
     the server's mark instead — see `clearTotpMark`. */
  for (;;) {
    const remaining = TOTP_STEP_MS - (Date.now() % TOTP_STEP_MS);
    if (remaining > 3_000) {
      spentSteps.set(accountKey, Math.floor(Date.now() / TOTP_STEP_MS));
      return generateSync({ secret });
    }
    await new Promise(resolve => setTimeout(resolve, remaining + 50));
  }
}

/**
 * Forgets that this account has spent a TOTP step.
 *
 * ── Why the harness is allowed to do this ──
 *
 * TOTP codes are single-use on the sign-in path: `verifyTotpOnce` records the step
 * it accepted and refuses anything at or below it. So an account can sign in once
 * per thirty seconds, which is correct product behaviour and what RFC 6238 §5.2
 * requires.
 *
 * Most suites sign the same fixture in several times in a few milliseconds, and
 * none of them is testing replay — they want "a session as this account". Making
 * each of them wait out a step would add roughly thirty seconds per login to a
 * suite that currently runs in eighty, and raising every timeout to accommodate it
 * would be paying that cost to test nothing.
 *
 * So `login()` clears the mark first and says so. The protection itself is covered
 * deliberately, by a test that does NOT clear it and asserts the second use of one
 * code is refused — which is the only place the rule should be exercised, because
 * it is the only place it is the subject.
 */
function clearTotpMark(database, email) {
  try {
    database.prepare('UPDATE users SET tfa_last_counter = NULL WHERE email = ?').run(email);
  } catch {
    /* The column arrives with migration 029; a fixture built before it ran has
       nothing to clear and nothing to fail about. */
  }
}

export async function startTestServer() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wev-test-'));
  process.env.WEV_DB_PATH = path.join(dir, 'test.db');
  process.env.DEMO_MODE = 'true';
  process.env.REQUIRE_ADMIN_2FA = 'true';
  process.env.JWT_SECRET = 'test-secret-not-for-production';

  /**
   * Both providers are configured, because `getAuthUrl` now refuses to mint a
   * URL with an empty client id (see oauth/credentials.js — that refusal is the
   * AADSTS900144 fix, and exempting the mock is what let the bug live).
   *
   * Six test files drive `POST /api/oauth/:provider/url` or the step-up
   * re-consent redirect, and every one of them wants a well-formed authorize URL
   * rather than a 503. Setting the pair here rather than in each file keeps the
   * server suite modelling an ordinary configured deployment.
   *
   * Deliberately NOT overwriting a value already in the environment: it lets a
   * developer point a run at a real client without editing this file, and the
   * `??=` means CI (where neither is set) always gets these.
   *
   * The four-state provider matrix — configured, credential-less, disabled and
   * unimplemented — is asserted in config.oauthProviders.test.js, which controls
   * the environment itself in a subprocess instead of inheriting this one.
   */
  process.env.GOOGLE_CLIENT_ID ??= 'test-google-client.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET ??= 'test-google-secret';
  process.env.MICROSOFT_CLIENT_ID ??= 'test-microsoft-client-id';
  process.env.MICROSOFT_CLIENT_SECRET ??= 'test-microsoft-secret';

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

  /**
   * Every seeded administrator is enrolled in two-factor authentication.
   *
   * ── Why the fixtures have to change ──
   *
   * `requireCap` refuses any `admin`/`super_admin` whose account has no second
   * factor, answering 403 `tfa_required`. That is the point of the feature — an
   * administrator without 2FA cannot administer — and it means a fixture
   * representing a WORKING administrator must be enrolled. Left unenrolled, ~290
   * tests across 49 files fail on a policy they predate, and every one of those
   * failures is about the fixture rather than about the thing under test.
   *
   * So this is not a workaround. It is the seed catching up with the rule: the
   * suite's admin is now a compliant admin, and the NON-compliant case gets its
   * own explicit tests (`routes.2faHardening.test.js`, and the enforcement cases
   * that disable it deliberately) rather than being every test's accidental
   * state.
   *
   * ── One shared secret ──
   *
   * A fixed, valid base32 secret rather than a random one per run, so `login`
   * below can produce a code without threading state, and so a failing test can
   * be reproduced by hand. It is a test fixture; it protects nothing.
   */
  {
    const { encryptSecret } = await import('./cryptoUtils.js');
    const { db: seeded } = await import('./db.js');
    seeded.prepare(
      "UPDATE users SET tfa_enabled = 1, tfa_secret = ? WHERE role IN ('admin', 'super_admin')"
    ).run(encryptSecret(TEST_TOTP_SECRET));
  }

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

  /**
   * Sign in, completing two-factor authentication when the account has it.
   *
   * ── Why the helper does the second step ──
   *
   * An enrolled account's `POST /api/auth/login` no longer returns a session. It
   * returns `{ require2FA: true }` and a `wev_preauth` cookie, and the session
   * only exists after `POST /api/auth/login-2fa`. Every one of the ~1,500
   * existing `srv.login(...)` call sites wants "give me a signed-in session", so
   * the exchange belongs here rather than in each of them.
   *
   * The code is generated from the same fixed secret the seed enrolled, through
   * the REAL endpoint — so every test that signs in as an administrator now
   * exercises the 2FA exchange as a side effect, which is strictly more coverage
   * than before rather than less.
   *
   * A test that wants the UNENROLLED behaviour turns it off explicitly
   * (`UPDATE users SET tfa_enabled = 0 …`) and gets the 403 the policy promises.
   */
  const login = async (email, password = 'password123') => {
    /**
     * Bring the account into line with the two-factor policy before signing in.
     *
     * The seed enrols the administrators it creates, but a dozen suites promote a
     * throwaway account with direct SQL —
     * `UPDATE users SET role = 'super_admin' …` — and those accounts are then
     * refused by `requireCap` with `tfa_required`, which is correct policy and a
     * baffling way to discover it three assertions later.
     *
     * Doing it HERE rather than in each suite: this helper's contract is "give me
     * a working signed-in session for this account", and under the policy a
     * working ADMINISTRATOR session is an enrolled one. Non-admins are untouched,
     * so ordinary sign-in stays a single round trip and the suites that test the
     * login flow itself see exactly what they saw before.
     */
    {
      const { db: live } = await import('./db.js');
      const { encryptSecret } = await import('./cryptoUtils.js');
      live.prepare(
        "UPDATE users SET tfa_enabled = 1, tfa_secret = ?\n"
        + "         WHERE email = ? AND role IN ('admin', 'super_admin')\n"
        + '           AND (tfa_enabled IS NULL OR tfa_enabled = 0)\n'
        + '           AND (tfa_email_enabled IS NULL OR tfa_email_enabled = 0)'
      ).run(encryptSecret(TEST_TOTP_SECRET), email);
    }

    const res = await call('POST', '/api/auth/login', { email, password });
    if (!res.body?.require2FA) return res.cookie;

    const preauth = (res.headers.get('set-cookie') || '').match(/wev_preauth=([^;]+)/)?.[1];
    if (!preauth) {
      throw new Error(
        `login(${email}): the server asked for a second factor but issued no preauth cookie.`
      );
    }

    /* Not testing replay — see clearTotpMark. */
    clearTotpMark(db, email);
    const second = await call('POST', '/api/auth/login-2fa',
      { method: 'totp', token: await freshTotpToken(TEST_TOTP_SECRET, `login:${email}`) },
      undefined, { Cookie: `wev_preauth=${preauth}` });

    if (!second.cookie) {
      throw new Error(
        `login(${email}): the second factor was refused (${second.status} `
        + `${JSON.stringify(second.body)}). The fixture's enrolment and the secret `
        + 'in testServer.js have drifted apart.'
      );
    }
    return second.cookie;
  };

  /**
   * Promotes a seeded account to platform owner, by direct SQL.
   *
   * ── Why the suite has to do this itself now ──
   *
   * The demo seed used to insert `user-super` whenever DEMO_MODE was set, and
   * three suites signed in as it. That seeding function is gone: it was the only
   * code in the repository that could create an owner, and the platform's
   * strongest defence against privilege escalation is that no such code exists.
   * `db.js` now refuses to boot a demo database that contains one.
   *
   * ── Why direct SQL rather than a route ──
   *
   * Because that is how ownership is actually created. There is no endpoint, and
   * adding one for the convenience of tests would recreate exactly the path this
   * change removed. `bin/grant-ownership.mjs` does the same UPDATE against the
   * same column; this is that statement, run against a throwaway database.
   *
   * Bumps `token_version` for the same reason the real script does: the role on
   * an already-issued cookie is stale the moment it changes.
   */
  const makeOwner = async (email) => {
    const { db } = await import('./db.js');
    const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!row) throw new Error(`makeOwner: no account for ${email}`);
    /* Enrolled at the same moment as the promotion. This helper turns an
       ordinary account into one the 2FA policy applies to, so without this the
       caller gets an owner who is immediately refused by `requireCap` — which is
       correct behaviour and a confusing way to learn it. */
    const { encryptSecret } = await import('./cryptoUtils.js');
    db.prepare(
      "UPDATE users SET role = 'super_admin', tfa_enabled = 1, tfa_secret = ?, "
      + 'token_version = token_version + 1 WHERE id = ?'
    ).run(encryptSecret(TEST_TOTP_SECRET), row.id);
    return row.id;
  };

  /**
   * Reads a report's preserved evidence, through the step-up the route requires.
   *
   * `GET /api/admin/reports/:id/evidence` gained `requireAAL2('report.evidence')`
   * in the v1.2c privacy review: reading a child's private messages was the most
   * invasive read on the platform and the only one of its weight behind nothing
   * but a session. Every suite that reads evidence therefore has to verify first,
   * and doing it in one helper keeps that from being seven copies of the same
   * four lines — and makes the requirement obvious to whoever writes the eighth.
   *
   * The grant binds `reportId`, so this deliberately opens a challenge per
   * report rather than caching one.
   */
  const readEvidence = async (token, reportId) => {
    const challengeId = await stepUp(token, 'report.evidence', { params: { reportId } });
    return call('GET', `/api/admin/reports/${reportId}/evidence`, undefined, token,
      { [REAUTH_CHALLENGE_HEADER]: challengeId });
  };

  /** `makeOwner` then sign in, which is what every caller actually wants. */
  const loginAsOwner = async (email, password = 'password123') => {
    await makeOwner(email);
    return login(email, password);
  };
  
  // Consent supplied for the same reason signupConfirmed does: this helper's
  // job is "give me an account", not "exercise the consent gate".
  const signup = async (email, password, rest) => {
    const res = await call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS, email, password, ...rest });
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
    /**
     * Issues a FRESH token rather than reading the outstanding one.
     *
     * It used to `SELECT token FROM email_verification_tokens`, which stopped
     * being possible when migration 048 replaced the plaintext with its digest
     * — and that is the whole point of 048: nothing, including this, can read a
     * usable credential out of the table.
     *
     * `issueVerificationToken` is the same function signup and resend call, and
     * it returns the plaintext to its immediate caller exactly as it does in
     * production when it hands it to the email template. So this is not a test
     * backdoor; it is the ordinary issue path, and it still goes through the
     * real endpoint afterwards. Issuing supersedes any previous link, which is
     * the documented behaviour of that function anyway.
     */
    const { issueVerificationToken } = await import('./services/verification.js');
    const token = issueVerificationToken(userId);
    const res = await call('POST', '/api/auth/verify-email', { token });
    if (res.status !== 200) throw new Error(`Could not confirm ${userId}: ${JSON.stringify(res.body)}`);
    return res.cookie;
  };

  /**
   * Signs up and confirms in one step, returning a session cookie ready to use.
   *
   * Supplies TEST_CONSENT unless the caller sets `consent` themselves. This
   * helper's entire purpose is "give me a working confirmed account", so consent
   * is setup here rather than subject matter — the same reason it does not make
   * the caller pass an email-verification token either.
   *
   * `call()` deliberately does NOT do this. A harness that quietly supplied
   * consent to every signup would make a future test of the consent gate pass
   * while testing nothing.
   */
  const signupConfirmed = async (payload) => {
    const res = await call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS, ...payload });
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
    makeOwner,
    readEvidence,
    loginAsOwner,
    signup,
    confirmEmail,
    signupConfirmed,
    stepUp,
    stepUpOAuth,
    reauthHeader,
    verified
  };
}
