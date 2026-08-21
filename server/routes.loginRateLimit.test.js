import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

/**
 * The sign-in limiter, and the school it must not lock out.
 *
 * ── The lockout ──
 *
 * `authLimiter` was keyed on the device address alone at ten failures per
 * fifteen minutes, and a school leaves through one public address. Ten different
 * students each mistyping their password once exhausted the shared budget, and
 * the eleventh — typing the CORRECT password — was refused 429 for the rest of
 * the window. Every case here is written against that: the per-pair limiter must
 * stop one student's typos from spending another's allowance, and the per-address
 * ceiling must still bound a spray.
 *
 * ── Why this suite runs the limiters for real ──
 *
 * `startTestServer` sets `DEMO_MODE=true`, which raises every ceiling ~100× so
 * that the other 300 suites are not fighting the limiter. That is right for them
 * and useless here, so this file boots its own app with demo mode OFF and the
 * production limits in force. `vitest.config.js` runs server files in isolation,
 * so the module-scope environment set here does not leak.
 */
describe('the sign-in limiter under shared NAT', () => {
  let app, db, server, base, initDatabase, completeDatabaseInit;

  /* The limits under test, low enough to exercise in a test but exercising the
     real code paths and the real key generators. */
  const PER_PAIR = 4;
  const IP_CEILING = 10;

  beforeAll(async () => {
    const { mkdtempSync, realpathSync } = await import('fs');
    const { tmpdir } = await import('os');
    const path = (await import('path')).default;

    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wev-rl-')));
    process.env.WEV_DB_PATH = path.join(dir, 'test.db');
    process.env.DEMO_MODE = 'false';
    process.env.REQUIRE_EMAIL_VERIFICATION = 'false';
    process.env.JWT_SECRET = 'rate-limit-suite-secret';
    process.env.TFA_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
    process.env.LOGIN_RATE_LIMIT = String(PER_PAIR);
    process.env.LOGIN_IP_CEILING = String(IP_CEILING);

    ({ db, initDatabase, completeDatabaseInit } = await import('./db.js'));
    /* The connection binds at module scope, so prove it is the throwaway file
       rather than trusting the env var — the same guard startTestServer uses. */
    const opened = (await db.prepare('PRAGMA database_list').all()).find(r => r.name === 'main')?.file || '';
    if (!opened.startsWith(dir)) throw new Error(`wrong database: ${opened}`);
    initDatabase();
    await completeDatabaseInit();

    ({ app } = await import('./app.js'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;

    /* Twelve accounts, one shared password, all synthetic. */
    const bcrypt = (await import('bcryptjs')).default;
    const hash = bcrypt.hashSync('CorrectHorse42', 10);
    const ins = db.prepare(`INSERT INTO users (id,name,email,username,password_hash,grade,role,verified,email_verified,created_at)
      VALUES (?,?,?,?,?,'11','student',1,1,?)`);
    db.exec('BEGIN');
    for (let i = 0; i < 12; i++) {
      await ins.run(`rl-${i}`, `Student ${i}`, `student.${i}@example.com`, `rl_student_${i}`, hash, new Date().toISOString());
    }
    db.exec('COMMIT');
  }, 60000);

  afterAll(async () => { if (server) await new Promise(r => server.close(r)); });

  /**
   * Both buckets are cleared between cases.
   *
   * The per-address ceiling is by definition shared by every account, so without
   * this each case inherits whatever the previous one spent and the suite tests
   * accumulation rather than behaviour. The first draft did exactly that: the
   * "many different accounts" case was refused after four attempts because an
   * earlier case had already used six of the ten.
   *
   * `resetKey` is per key and there is no public reset-all, so the keys this
   * suite can produce are enumerated and cleared. Both limiters see the same
   * loopback address, which is also why `x-forwarded-for` cannot isolate them —
   * `trust proxy` is off, which is the property the spoofing case asserts.
   */
  beforeEach(async () => {
    const { loginLimiter, loginIpCeilingLimiter } = await import('./app.js');
    const { createHash } = await import('crypto');
    const h = (v) => createHash('sha256').update(v).digest('hex').slice(0, 32);
    for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
      loginIpCeilingLimiter.resetKey(ip);
      loginLimiter.resetKey(`login:${ip}`);
      for (let i = 0; i < 12; i++) loginLimiter.resetKey(`login:${ip}:${h(`student.${i}@example.com`)}`);
      for (let n = 0; n < 40; n++) loginLimiter.resetKey(`login:${ip}:${h(`sprayed.${n}@example.com`)}`);
    }
  });

  const post = (body, headers = {}) => fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

  const wrong = (i, headers) => post({ email: `student.${i}@example.com`, password: 'WrongPassword!1' }, headers);
  const right = (i, headers) => post({ email: `student.${i}@example.com`, password: 'CorrectHorse42' }, headers);

  /* 1 */
  it('limits repeated wrong passwords against ONE account', async () => {
    const seen = [];
    for (let n = 0; n < PER_PAIR + 2; n++) seen.push((await wrong(0)).status);
    expect(seen).toContain(429);
    expect(seen.indexOf(429)).toBe(PER_PAIR);
  });

  /* 2 + 14 — the lockout this suite exists for. */
  it('does NOT limit one failed attempt each from many different accounts', async () => {
    const seen = [];
    for (let i = 1; i <= 8; i++) seen.push((await wrong(i)).status);
    expect(seen.every(s => s === 401), `statuses ${seen.join(',')}`).toBe(true);
  });

  /* 3 + 6 — the eleventh student, typing the right password. */
  it('lets a legitimate sign-in through after unrelated accounts have failed', async () => {
    const res = await right(9);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  /* 4 — username spray is bounded by the per-address ceiling, not by the pair. */
  it('stops a spray of many usernames from one address at the ceiling', async () => {
    const seen = [];
    for (let n = 0; n < IP_CEILING + 6; n++) {
      seen.push((await post({ email: `sprayed.${n}@example.com`, password: 'WrongPassword!1' })).status);
    }
    expect(seen).toContain(429);
  });

  /* 5 — one username from many addresses: the account-level counter in
     authRoutes.js bounds it, not the per-address limiter. */
  it('bounds one account attacked from many addresses', async () => {
    const seen = [];
    for (let n = 0; n < PER_PAIR + 4; n++) {
      seen.push((await wrong(10, { 'x-forwarded-for': `203.0.113.${n}` })).status);
    }
    /* Either layer may answer first; what matters is that it does not run
       unbounded just because the source address keeps changing. */
    expect(seen.some(s => s === 429), `statuses ${seen.join(',')}`).toBe(true);
  });

  /* 7 + 15 — a client-supplied header must not mint a fresh budget. */
  it('cannot be reset by changing X-Forwarded-For', async () => {
    for (let n = 0; n < PER_PAIR + 2; n++) await wrong(11);
    const blocked = await wrong(11);
    expect(blocked.status).toBe(429);

    const spoofed = await wrong(11, { 'x-forwarded-for': '198.51.100.7' });
    expect(spoofed.status, 'a spoofed forwarding header reset the budget').toBe(429);
  });

  /* 8 — a success costs nothing, so a busy morning cannot exhaust anything. */
  it('does not count successful sign-ins', async () => {
    const seen = [];
    for (let n = 0; n < IP_CEILING + 8; n++) seen.push((await right(9)).status);
    expect(seen.every(s => s === 200), `statuses ${[...new Set(seen)].join(',')}`).toBe(true);
  });

  /* 11 — a refusal is a wait, never a disabled account. */
  it('never disables the account row', async () => {
    for (let n = 0; n < PER_PAIR + 3; n++) await wrong(0);
    expect((await db.prepare('SELECT account_status FROM users WHERE id = ?').get('rl-0')).account_status).toBe('active');
  });

  /* 9 — the response says how long to wait, in the shape the client parses. */
  it('answers JSON naming the wait rather than a bare status', async () => {
    for (let n = 0; n < PER_PAIR + 2; n++) await wrong(2);
    const res = await wrong(2);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
    expect(res.body.retryAfterMinutes).toBeGreaterThan(0);
    expect(res.body.error).toMatch(/minute/);
  });

  /* 10 — concurrent attempts must not each read an empty bucket. */
  it('is not bypassable by firing the attempts at once', async () => {
    const res = await Promise.all(Array.from({ length: PER_PAIR + 8 }, () => wrong(3)));
    const allowed = res.filter(r => r.status === 401).length;
    expect(allowed, `statuses ${res.map(r => r.status).join(',')}`).toBeLessThanOrEqual(PER_PAIR);
  });

  /* 16 — the identifier is hashed, so keys are not a list of who signed in. */
  it('does not hold raw identifiers in its keys', async () => {
    const { loginLimiter } = await import('./app.js');
    const store = loginLimiter?.store ?? null;
    if (!store) return;
    const keys = Object.keys(store.hits ?? store.store ?? {});
    for (const k of keys) expect(k).not.toContain('@example.com');
  });

  /* 12 — a missing identifier must not buy an unlimited budget. */
  it('falls back to the address when no identifier is supplied', async () => {
    const seen = [];
    for (let n = 0; n < IP_CEILING + 6; n++) {
      seen.push((await post({ password: 'WrongPassword!1' })).status);
    }
    expect(seen).toContain(429);
  });
});
