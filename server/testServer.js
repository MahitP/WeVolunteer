import { mkdtempSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

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

  const call = async (method, p, body, token) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Cookie: `wev_session=${token}` } : {})
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
    signupConfirmed
  };
}
