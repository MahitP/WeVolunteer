/**
 * Transactional mail: failures must be visible, and one campus must not share one
 * rate-limit bucket.
 *
 * ── Visibility ──
 *
 * `sendVerificationEmail`, `sendPasswordResetEmail` and the two email-change
 * messages caught their own errors, wrote a line with `console.error`, and returned
 * `false`. Callers ignore the return value because the API deliberately answers
 * `{success:true}` regardless (so `forgot-password` cannot leak whether an address
 * exists). Only *notification* mail goes through the `notification_jobs` outbox with
 * retries; these four had no retry and no counter.
 *
 * The result: during an SMTP incident, students silently never receive a
 * verification link, `/api/admin/system/status` still reports
 * `smtpConfigured: true` — because that only checks whether env vars are set — and
 * nothing anywhere records that mail is failing.
 *
 * ── Rate limiting ──
 *
 * `mailLimiter` allowed 5 requests per 15 minutes keyed on IP. A school campus
 * leaves through one public address, so on signup day the whole building shared
 * five resend-verification attempts. With REQUIRE_EMAIL_VERIFICATION defaulting to
 * ON, that is a lockout of the entire cohort on day one — while the abuse the
 * limiter exists to stop (flooding one person's inbox) is per-ADDRESS, not per-IP.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * A file-wide budget, measured rather than guessed — the same remedy and the same
 * reasoning as `tooling.dbPath.test.js`.
 *
 * `allows many different addresses from one IP to request verification` makes
 * **twelve sequential HTTP round trips** through `/api/auth/forgot-password`, and
 * each one boots the reset path. Sequential is not incidental: the test is about a
 * per-IP counter, so the requests cannot be parallelised without changing what is
 * being measured.
 *
 * Isolated, the whole file runs in ~1.3s. Under the parallel load of the full
 * suite that one test was measured at **5133ms** against vitest's 5000ms default
 * and timed out — then passed on the next full run, with the rest of the file
 * green both times. Nothing was hung, and the assertion it makes (0 of 12
 * rate-limited) never failed; it ran out of clock.
 *
 * So this is a flake, and flakiness on the gate every other gate depends on is a
 * defect in its own right. Raised here rather than on the single test so a second
 * slow case in this file does not have to rediscover it. The global default stays
 * 5000ms, so a genuinely hung test elsewhere still fails fast.
 */
vi.setConfig({ testTimeout: 20000 });

async function freshEmail({ failing = false } = {}) {
  process.env.JWT_SECRET = 'x'.repeat(48);
  process.env.APP_URL = 'http://localhost:5173';
  delete process.env.NODE_ENV;
  // Presence of SMTP_* selects the real nodemailer transport, which is then mocked.
  process.env.SMTP_HOST = 'smtp.test.invalid';
  process.env.SMTP_USER = 'u';
  process.env.SMTP_PASS = 'p';
  process.env.MAIL_RETRY_DELAY_MS = '1'; // keep the backoff out of the test runtime

  const sent = [];
  vi.resetModules();
  vi.doMock('nodemailer', () => ({
    default: {
      createTransport: () => ({
        sendMail: async (opts) => {
          if (failing) throw new Error('ECONNREFUSED smtp.test.invalid:587');
          sent.push(opts);
          return { messageId: 'test' };
        }
      })
    }
  }));

  const email = await import('./email.js');
  return { email, sent };
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => {
  vi.doUnmock('nodemailer');
  vi.restoreAllMocks();
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.MAIL_RETRY_DELAY_MS;
});

describe('transactional mail failures are recorded', () => {
  it('a healthy send leaves the failure counter at zero', async () => {
    const { email } = await freshEmail();

    const ok = await email.sendVerificationEmail('student@example.org', 'tok');

    expect(ok).toBe(true);
    const health = email.getMailHealth();
    expect(health.failures).toBe(0);
    expect(health.lastError).toBeNull();
    expect(health.lastSuccessAt).toBeTruthy();
  });

  it('a failed verification send is counted and attributed', async () => {
    const { email } = await freshEmail({ failing: true });

    const ok = await email.sendVerificationEmail('student@example.org', 'tok');

    // The return contract is unchanged — callers still get false.
    expect(ok).toBe(false);

    const health = email.getMailHealth();
    expect(health.failures).toBeGreaterThan(0);
    // An operator needs to know WHICH flow is failing; "mail is broken" is not
    // actionable when reset and verification have different consequences.
    expect(health.lastError.flow).toBe('verification');
    expect(health.lastError.message).toMatch(/ECONNREFUSED/);
    expect(health.lastError.at).toBeTruthy();
  });

  it('does not put the recipient address in the failure record', async () => {
    const { email } = await freshEmail({ failing: true });

    await email.sendPasswordResetEmail('ava.white@student.example.org', 'tok');

    const health = email.getMailHealth();
    const serialised = JSON.stringify(health);
    // The record is surfaced on an admin endpoint and written to the journal. The
    // domain is enough to diagnose a relay problem; the local part is a minor's
    // identity and does not belong in either.
    expect(serialised).not.toContain('ava.white');
    expect(health.lastError.recipientDomain).toBe('student.example.org');
  });

  it('records the flow for each transactional message type', async () => {
    const { email } = await freshEmail({ failing: true });

    await email.sendPasswordResetEmail('a@example.org', 't');
    expect(email.getMailHealth().lastError.flow).toBe('password-reset');

    await email.sendEmailChangeConfirmation('a@example.org', 't');
    expect(email.getMailHealth().lastError.flow).toBe('email-change-confirm');

    await email.sendEmailChangeNotice('a@example.org', 'b@example.org');
    expect(email.getMailHealth().lastError.flow).toBe('email-change-notice');
  });
});

describe('transactional mail retries a transient failure', () => {
  it('retries before giving up', async () => {
    process.env.JWT_SECRET = 'x'.repeat(48);
    process.env.APP_URL = 'http://localhost:5173';
    process.env.SMTP_HOST = 'smtp.test.invalid';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    process.env.MAIL_RETRY_DELAY_MS = '1';
    delete process.env.NODE_ENV;

    let attempts = 0;
    vi.resetModules();
    vi.doMock('nodemailer', () => ({
      default: {
        createTransport: () => ({
          sendMail: async () => {
            attempts++;
            // Fails once, then succeeds — the shape of a relay hiccup, which is
            // exactly the case a single attempt turned into a locked-out student.
            if (attempts === 1) throw new Error('ETIMEDOUT');
            return { messageId: 'test' };
          }
        })
      }
    }));

    const email = await import('./email.js');
    const ok = await email.sendVerificationEmail('student@example.org', 'tok');

    expect(attempts).toBeGreaterThan(1);
    expect(ok, 'a transient failure should not lose the message').toBe(true);
  });

  it('gives up after a bounded number of attempts', async () => {
    const { email } = await freshEmail({ failing: true });

    const started = Date.now();
    const ok = await email.sendVerificationEmail('student@example.org', 'tok');
    const elapsed = Date.now() - started;

    expect(ok).toBe(false);
    // Must not retry forever — a signup request cannot hang on a dead relay.
    expect(elapsed).toBeLessThan(5000);
    expect(email.getMailHealth().attemptsOnLastFailure).toBeLessThanOrEqual(3);
  });
});

describe('the mail rate limiter does not lock out a shared campus address', () => {
  /**
   * Boots the app with a throwaway database and returns a supertest agent.
   *
   * The limiter is module-level state in app.js, so each test needs a fresh
   * registry — the same reason vitest.config.js pins `isolate: true`.
   */
  async function freshApp() {
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const path = await import('path');
    const request = (await import('supertest')).default;

    const dir = mkdtempSync(path.join(tmpdir(), 'wev-maillimit-'));
    process.env.WEV_DB_PATH = path.join(dir, 'mail.db');
    process.env.JWT_SECRET = 'x'.repeat(48);
    process.env.APP_URL = 'http://localhost:5173';
    delete process.env.NODE_ENV;
    delete process.env.SMTP_HOST;

    vi.resetModules();
    const dbMod = await import('./db.js');
    dbMod.initDatabase();
    const { app } = await import('./app.js');
    return { app, request, dir };
  }

  it('allows many different addresses from one IP to request verification', async () => {
    const { app, request } = await freshApp();

    /**
     * Twelve distinct students behind one school NAT. Under the old per-IP limiter
     * the sixth would have been refused.
     *
     * `forgot-password` is used rather than `resend-verification` because it always
     * answers 200 by design, so a 429 is unambiguous — it is the limiter and not a
     * missing account.
     */
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: `student${i}@school.example.org` });
      statuses.push(res.status);
    }

    const rateLimited = statuses.filter(s => s === 429).length;
    expect(rateLimited, `${rateLimited} of 12 distinct students were rate-limited`).toBe(0);
  });

  it('still stops repeated requests aimed at ONE address', async () => {
    const { app, request } = await freshApp();

    // The abuse the limiter exists to prevent: flooding one person's inbox.
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'victim@school.example.org' });
      statuses.push(res.status);
    }

    expect(statuses.filter(s => s === 429).length, 'inbox flooding was not throttled').toBeGreaterThan(0);
  });

  it('keeps a per-IP ceiling so one host cannot walk the address space', async () => {
    const { app, request } = await freshApp();

    // Per-address keying alone would be trivially bypassed by rotating the address,
    // so a generous per-IP ceiling stays underneath it.
    const statuses = [];
    for (let i = 0; i < 130; i++) {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: `probe${i}@school.example.org` });
      statuses.push(res.status);
    }

    expect(statuses.filter(s => s === 429).length, 'no per-IP ceiling is enforced').toBeGreaterThan(0);
  });

  it('normalises the address so case and padding cannot multiply the allowance', async () => {
    const { app, request } = await freshApp();

    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const spelling = i % 2 === 0 ? 'Victim@School.Example.org' : '  victim@school.example.org ';
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: spelling });
      statuses.push(res.status);
    }

    expect(statuses.filter(s => s === 429).length, 'case variants bypassed the per-address limit').toBeGreaterThan(0);
  });
});
