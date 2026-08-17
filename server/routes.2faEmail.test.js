/**
 * The emailed second factor, end to end.
 *
 * ── Why this file exists ──
 *
 * Two-factor by authenticator app is covered in four places. Two-factor by
 * EMAIL — the method every account without a phone falls back to — had exactly
 * one test, and it asserted that a column got set to 1. Nothing exercised
 * sending a code, spending it, or any of the ways it should be refused.
 *
 * That is the wrong coverage for this code. `hoursLedger` failing loudly is an
 * accounting error; this failing quietly is either a locked-out user who cannot
 * sign in at all, or a second factor that is not one. Both of those have
 * happened here already — `datetimeComparison.test.js` exists because an emailed
 * code once stayed valid for the rest of the calendar day instead of ten
 * minutes.
 *
 * ── What is asserted ──
 *
 * Both directions, because only one of them is a security property and the other
 * is the one users actually meet:
 *
 *   REFUSED — an expired code, a spent code, a code belonging to somebody else,
 *   a code guessed too many times, a request with no pre-auth grant.
 *
 *   DELIVERED — a correct code mints a session, a resend retires the previous
 *   code, the cooldown is honest, and a relay failure is REPORTED rather than
 *   dressed up as a successful send.
 *
 * The last of those is the defect this file was written to catch. See the block
 * comment on that test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// db.js opens its connection at module scope, so nothing that reaches it may be
// imported statically here — see the long explanation in testServer.js.
let srv, db;

const EMAIL = 'leo.chen@example.com';
const PASSWORD = 'password123';

/** Starts a sign-in and returns the pre-auth cookie the second factor needs. */
async function beginLogin(email = EMAIL) {
  const first = await srv.call('POST', '/api/auth/login', { email, password: PASSWORD });
  expect(first.body.require2FA, JSON.stringify(first.body)).toBe(true);
  const preauth = (first.headers.get('set-cookie') || '').match(/wev_preauth=([^;]+)/)?.[1];
  expect(preauth, 'no pre-auth cookie was issued').toBeTruthy();
  return preauth;
}

const sendCode = (preauth) =>
  srv.call('POST', '/api/auth/login-2fa/email/send', {}, undefined,
    preauth ? { Cookie: `wev_preauth=${preauth}` } : {});

const submitCode = (code, preauth) =>
  srv.call('POST', '/api/auth/login-2fa', { method: 'email', code }, undefined,
    preauth ? { Cookie: `wev_preauth=${preauth}` } : {});

const userId = async (email = EMAIL) =>
  (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)).id;

const liveCodes = async (email = EMAIL) =>
  await db.prepare('SELECT * FROM tfa_email_codes WHERE user_id = ? ORDER BY created_at DESC')
    .all(await userId(email));

/**
 * Enrols an account in email 2FA and nothing else.
 *
 * Straight into the row rather than through `/api/2fa/email/enable`, which sits
 * behind a step-up grant. The enrolment route has its own tests; this file is
 * about what happens once an account IS enrolled, and routing every case through
 * a re-authentication would test that instead.
 */
async function enrolEmailOnly(email = EMAIL) {
  await db.prepare(`
    UPDATE users
       SET tfa_email_enabled = 1, email_verified = 1,
           tfa_enabled = 0, tfa_secret = NULL
     WHERE email = ?
  `).run(email);
}

/** Clears the cooldown and every stored code, so a case starts from nothing. */
async function clearCodes(email = EMAIL) {
  await db.prepare('DELETE FROM tfa_email_codes WHERE user_id = ?').run(await userId(email));
  await db.prepare('DELETE FROM tfa_login_attempts WHERE user_id = ?').run(await userId(email));
}

beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  await enrolEmailOnly();
}, 60000);

afterAll(async () => { await srv?.close?.(); });

beforeEach(async () => {
  await enrolEmailOnly();
  await clearCodes();
});

/* ── Requesting a code ───────────────────────────────────────────────────── */

describe('POST /api/auth/login-2fa/email/send', () => {
  it('refuses a request carrying no pre-auth grant', async () => {
    const res = await sendCode(null);
    expect(res.status).toBe(401);
    expect(await liveCodes()).toHaveLength(0);
  });

  /**
   * A SESSION token is not a pre-auth token.
   *
   * The two are different cookies for exactly this reason: if a full session
   * satisfied this endpoint, the second factor would be reachable by anyone who
   * already had the thing it exists to protect.
   */
  it('refuses a token that is not a pre-auth grant', async () => {
    const res = await sendCode('not-a-real-token');
    expect(res.status).toBe(401);
    expect(await liveCodes()).toHaveLength(0);
  });

  it('sends a code and reports the address masked', async () => {
    const res = await sendCode(await beginLogin());

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.sent).toBe(true);
    /* Masked, because the pre-auth holder has not finished proving who they are
       and the full address is a fact about the account. */
    expect(res.body.maskedEmail).toMatch(/^\w{2}\*\*\*@/);
    expect(res.body.maskedEmail).not.toBe(EMAIL);
    expect(await liveCodes()).toHaveLength(1);
  });

  /** The code is stored hashed. A readable column is a readable second factor. */
  it('stores the code as a hash, never in the clear', async () => {
    await sendCode(await beginLogin());
    const [row] = await liveCodes();

    expect(row.code_hash).toMatch(/^\$2[aby]\$/);
    expect(row.code_hash).not.toMatch(/^\d{6}$/);
  });

  /**
   * Email is a fallback for an account that already has a second factor, even
   * when nobody separately switched "email 2FA" on.
   *
   * This test previously asserted the opposite. The product rule changed
   * deliberately in v1.3.1: email is the thing a person reaches for when their
   * authenticator is gone, and requiring them to have pre-enabled it is
   * requiring foresight exactly where they have none left. The gate that still
   * matters — a CONFIRMED address — is asserted immediately below, and is what
   * stops a code going somewhere nobody has proved they can read.
   *
   * It does not widen who can sign in: delivery goes to the address on the
   * account, which could already reset the password.
   */
  it('offers email to an authenticator account with a confirmed address', async () => {
    const preauth = await beginLogin();
    await db.prepare('UPDATE users SET tfa_email_enabled = 0, tfa_enabled = 1, email_verified = 1 WHERE email = ?')
      .run(EMAIL);

    const res = await sendCode(preauth);
    expect(res.status).toBe(200);
    expect(await liveCodes()).toHaveLength(1);
  });

  it('refuses an account with no second factor at all', async () => {
    const preauth = await beginLogin();
    await db.prepare('UPDATE users SET tfa_email_enabled = 0, tfa_enabled = 0 WHERE email = ?').run(EMAIL);

    const res = await sendCode(preauth);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('method_unavailable');
    expect(await liveCodes()).toHaveLength(0);
  });

  /**
   * An unverified address must not receive a second factor.
   *
   * Sending one would deliver the key to an address nobody has proved they can
   * read — which is the whole reason `email_verified` exists.
   */
  it('refuses an account whose address is not verified', async () => {
    const preauth = await beginLogin();
    await db.prepare('UPDATE users SET email_verified = 0 WHERE email = ?').run(EMAIL);

    const res = await sendCode(preauth);
    expect(res.status).toBe(400);
    expect(await liveCodes()).toHaveLength(0);
  });

  /**
   * "Send me another" means the previous one was not received, so it must stop
   * working. Without this, pressing resend three times leaves three live codes:
   * three times the guessing surface, and three chances that an intercepted
   * older message still opens the account.
   */
  it('retires the previous code when a new one is requested', async () => {
    const preauth = await beginLogin();
    await sendCode(preauth);
    const [first] = await liveCodes();

    /* Past the 60-second cooldown, which is a separate control tested below. */
    await db.prepare(`UPDATE tfa_email_codes SET created_at = '${new Date(Date.now() - 120000).toISOString()}' WHERE id = ?`)
      .run(first.id);

    const res = await sendCode(preauth);
    expect(res.status).toBe(200);

    const after = await db.prepare('SELECT used_at FROM tfa_email_codes WHERE id = ?').get(first.id);
    expect(after.used_at, 'the superseded code was left live').not.toBeNull();
    expect((await liveCodes()).filter(c => c.used_at === null)).toHaveLength(1);
  });

  /**
   * The cooldown must read BOTH shapes this column is written in.
   *
   * `created_at` is the one column whose default differs by engine: SQLite's
   * `datetime('now')` writes `2026-08-10 12:00:00`, and the generated PostgreSQL
   * schema writes ISO-8601. The route used to append `'Z'` unconditionally,
   * which turned the ISO form into `…123ZZ` and `getTime()` into NaN. The
   * cooldown fails shut, so the endpoint then answered 429 to every request
   * forever and nobody using email as their second factor could sign in.
   *
   * Both shapes are written here directly, because the bug is invisible on
   * whichever engine happens to be running the test.
   */
  it('honours the cooldown for both the ISO and the SQLite timestamp shape', async () => {
    const old = new Date(Date.now() - 120000);
    const shapes = [
      old.toISOString(),                                       // PostgreSQL default
      old.toISOString().replace('T', ' ').replace(/\..*$/, ''), // SQLite datetime('now')
    ];

    for (const shape of shapes) {
      const preauth = await beginLogin();
      await sendCode(preauth);
      /* Every row for this user, not just the newest: the cooldown reads
         `ORDER BY created_at DESC LIMIT 1`, and by the second shape there are
         codes left over from the first. */
      await db.prepare('UPDATE tfa_email_codes SET created_at = ? WHERE user_id = ?')
        .run(shape, await userId());

      const res = await sendCode(preauth);
      expect(res.status, `a code stored as "${shape}" must be read as two minutes old, not as unparseable`).toBe(200);
    }
  });

  it('refuses a second request inside the cooldown', async () => {
    const preauth = await beginLogin();
    await sendCode(preauth);

    const res = await sendCode(preauth);
    expect(res.status).toBe(429);
    expect(res.body.retryAfter).toBeGreaterThan(0);
    expect(res.body.retryAfter).toBeLessThanOrEqual(60);
  });

  /**
   * ── The defect this file was written for ──
   *
   * `send2FACode` returns FALSE when the relay is unreachable — it retries three
   * times and then gives up, by design, so a dead relay does not hang a request.
   * This endpoint ignored the return value and answered `{ sent: true }`
   * regardless.
   *
   * The consequences compound. By the time delivery is attempted the endpoint has
   * already retired every previous code, so the working code sitting in the
   * user's inbox is now dead; the new one was never delivered; and the row it
   * wrote arms the sixty-second cooldown. The user is told a code is on its way,
   * has none, has lost the one they had, and must wait a minute to be told the
   * same thing again — with the interface showing a success the whole time.
   *
   * For an account whose ONLY second factor is email, that is a complete sign-in
   * lockout presented as success. It has to be reported.
   */
  it('reports a delivery failure instead of claiming the code was sent', async () => {
    const preauth = await beginLogin();

    /**
     * The transport is replaced, not the module.
     *
     * `vi.doMock('./email.js')` looks like the obvious tool and does not work
     * here: the route imports email.js DYNAMICALLY inside the handler, so by the
     * time this test registers a mock the module is already resolved and cached
     * and the mock is ignored. That version of this test passed — against a
     * relay that was working perfectly — which is the exact failure mode this
     * file is supposed to catch rather than commit.
     */
    const { setMailTransportForTests } = await import('./email.js');
    setMailTransportForTests({
      sendMail: async () => { throw new Error('ECONNREFUSED (simulated relay failure)'); }
    });

    try {
      const res = await sendCode(preauth);

      expect(res.status, 'a failed delivery answered as a success').not.toBe(200);
      expect(res.body?.sent).not.toBe(true);
      expect(res.body?.error, 'the refusal did not say anything').toBeTruthy();
    } finally {
      setMailTransportForTests(null);
    }
  });
});

/* ── Spending a code ─────────────────────────────────────────────────────── */

/**
 * Requests a code and returns the digits.
 *
 * The code is hashed on the way into the database and never returned by the API,
 * which is correct and leaves a test unable to read it. So the row is overwritten
 * with the hash of a known value: the code under test is a real row, spent
 * through the real endpoint, and only its content is arranged.
 */
async function issueKnownCode(digits, { email = EMAIL, expiresInMs = 10 * 60 * 1000 } = {}) {
  const bcrypt = (await import('bcryptjs')).default;
  const id = `tfa-email-test-${digits}-${await userId(email)}`;
  await db.prepare('DELETE FROM tfa_email_codes WHERE user_id = ?').run(await userId(email));
  await db.prepare(
    'INSERT INTO tfa_email_codes (id, user_id, code_hash, expires_at) VALUES (?, ?, ?, ?)'
  ).run(id, await userId(email), await bcrypt.hash(digits, 10),
    new Date(Date.now() + expiresInMs).toISOString());
  return id;
}

describe('POST /api/auth/login-2fa with an emailed code', () => {
  it('accepts the code and issues a session', async () => {
    const preauth = await beginLogin();
    await issueKnownCode('123456');

    const res = await submitCode('123456', preauth);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.cookie, 'no session cookie was set').toBeTruthy();
  });

  /** Whitespace around a pasted code is not a wrong answer. */
  it('accepts a code pasted with surrounding whitespace', async () => {
    const preauth = await beginLogin();
    await issueKnownCode('223456');

    const res = await submitCode('  223456 ', preauth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('refuses a wrong code and mints nothing', async () => {
    const preauth = await beginLogin();
    const id = await issueKnownCode('323456');

    const res = await submitCode('999999', preauth);

    expect(res.status).toBe(401);
    expect(res.cookie).toBeFalsy();
    expect((await db.prepare('SELECT attempts FROM tfa_email_codes WHERE id = ?').get(id)).attempts).toBe(1);
  });

  /**
   * One wrong guess costs ONE attempt, however many codes are stored.
   *
   * The counter used to be bumped inside the per-code loop, so an account with
   * three live codes burned three attempts on a single typo and was locked out
   * after one mistake, while an account with one code got the three the design
   * intends.
   */
  it('charges one attempt per submission, not one per stored code', async () => {
    const preauth = await beginLogin();
    const bcrypt = (await import('bcryptjs')).default;
    await db.prepare('DELETE FROM tfa_email_codes WHERE user_id = ?').run(await userId());

    for (const digits of ['411111', '422222', '433333']) {
      await db.prepare('INSERT INTO tfa_email_codes (id, user_id, code_hash, expires_at) VALUES (?, ?, ?, ?)')
        .run(`multi-${digits}`, await userId(), await bcrypt.hash(digits, 10),
          new Date(Date.now() + 600000).toISOString());
    }

    await submitCode('999999', preauth);

    for (const digits of ['411111', '422222', '433333']) {
      expect(
        (await db.prepare('SELECT attempts FROM tfa_email_codes WHERE id = ?').get(`multi-${digits}`)).attempts,
        `code ${digits} was charged for a guess against another code`
      ).toBe(1);
    }
  });

  /**
   * The ten-minute expiry, which is the regression `datetimeComparison.test.js`
   * was written for.
   *
   * `expires_at` is an ISO string (`2026-08-08T20:00:00.000Z`) and SQLite's
   * `datetime('now')` is not (`2026-08-08 20:00:00`). Compared textually, 'T'
   * sorts after ' ', so every ISO timestamp on today's date read as later than
   * now and an expired code stayed acceptable until midnight.
   */
  it('refuses a code that has expired', async () => {
    const preauth = await beginLogin();
    await issueKnownCode('523456', { expiresInMs: -1000 });

    const res = await submitCode('523456', preauth);

    expect(res.status, 'an expired code was accepted').toBe(401);
    expect(res.cookie).toBeFalsy();
  });

  /** And an hour past expiry is not a different case, but it is the one that
   *  the calendar-day bug let through. */
  it('refuses a code that expired an hour ago', async () => {
    const preauth = await beginLogin();
    await issueKnownCode('623456', { expiresInMs: -60 * 60 * 1000 });

    expect((await submitCode('623456', preauth)).status).toBe(401);
  });

  /**
   * Single use. A code that has minted a session cannot mint a second one, even
   * inside its ten minutes — the same rule the authenticator path enforces with
   * its high-water counter.
   */
  it('refuses a code that has already been used', async () => {
    await issueKnownCode('723456');

    const first = await submitCode('723456', await beginLogin());
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    /* A separate pre-auth grant, because that is the shape of the attack: an
       attacker holding the stolen password starts their own sign-in and submits
       the code they observed. */
    const second = await submitCode('723456', await beginLogin());
    expect(second.status, 'a spent code minted a second session').toBe(401);
    expect(second.cookie).toBeFalsy();
  });

  /** A code retired by a resend is dead on arrival, not merely superseded. */
  it('refuses a code that a resend retired', async () => {
    const preauth = await beginLogin();
    await issueKnownCode('823456');
    await db.prepare(`UPDATE tfa_email_codes SET used_at = '${new Date().toISOString()}' WHERE user_id = ?`).run(await userId());

    expect((await submitCode('823456', preauth)).status).toBe(401);
  });

  /** Three wrong guesses kill the code itself, so the right one no longer helps. */
  it('kills the code after three wrong guesses', async () => {
    const preauth = await beginLogin();
    await issueKnownCode('923456');

    for (let i = 0; i < 3; i++) await submitCode('000000', preauth);

    const res = await submitCode('923456', preauth);
    expect(res.status, 'the correct code opened a burned-out code row').not.toBe(200);
    expect(res.cookie).toBeFalsy();
  });

  /**
   * Five wrong guesses against one pre-auth grant is a 429, not a 401.
   *
   * The distinction matters to the client: 401 means try again, 429 means stop.
   */
  it('throttles the grant after five wrong guesses', async () => {
    const preauth = await beginLogin();
    await issueKnownCode('101010');

    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await submitCode('000000', preauth)).status);

    expect(statuses[5]).toBe(429);
  });

  /**
   * A code is bound to the account it was issued for.
   *
   * Codes are six digits and every account's live code is drawn from the same
   * range, so without the `user_id` scope one user's valid code would be a valid
   * code for whoever submitted it.
   */
  it("refuses another account's code", async () => {
    const other = 'ethan.miller@example.com';
    await enrolEmailOnly(other);
    await issueKnownCode('111213', { email: other });

    const res = await submitCode('111213', await beginLogin(EMAIL));

    expect(res.status, "one account's code satisfied another's sign-in").toBe(401);
    expect(res.cookie).toBeFalsy();
  });

  it('refuses a code submitted with no pre-auth grant', async () => {
    await issueKnownCode('141516');

    const res = await submitCode('141516', null);
    expect(res.status).toBe(401);
    expect(res.cookie).toBeFalsy();
  });

  /**
   * A suspended or deleted account cannot finish a sign-in it legitimately
   * started. The pre-auth grant was issued before that state was checked, so the
   * second leg is where it has to be caught.
   */
  it('refuses an account deleted between the two legs', async () => {
    const preauth = await beginLogin();
    await issueKnownCode('171819');
    await db.prepare("UPDATE users SET account_status = 'deleted' WHERE email = ?").run(EMAIL);

    try {
      const res = await submitCode('171819', preauth);
      expect(res.status).toBe(401);
      expect(res.cookie).toBeFalsy();
    } finally {
      await db.prepare("UPDATE users SET account_status = 'active' WHERE email = ?").run(EMAIL);
    }
  });
});
