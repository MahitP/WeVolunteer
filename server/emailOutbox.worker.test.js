import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * The seam between the worker and the mail service.
 *
 * ── Why this file exists separately from the failure matrix ──
 *
 * `emailFailureMatrix.test.js` proves the SERVICE decides correctly: what falls
 * back, what is queued, what is permanent. It calls the service directly.
 * `notificationWorker.reliability.test.js` proves the WORKER survives its own
 * failure modes. Neither one runs a queued message all the way through.
 *
 * That gap is exactly where a durable queue fails in the way that matters. A
 * message can be written to the outbox perfectly and then sit there forever
 * because the worker does not recognise its channel, or because a column the
 * worker reads was never populated. Both are silent: the row exists, `pending`,
 * with a `next_attempt_at` in the past, and nothing logs anything. The queue
 * looks like it is working right up until somebody asks why a student never got
 * their verification email.
 *
 * So this drives the real worker over a real database with a real migration, and
 * only the providers are fake.
 */

let dir;

async function freshWorker() {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-outbox-'));
  process.env.WEV_DB_PATH = path.join(dir, 'outbox.db');
  process.env.JWT_SECRET = 'x'.repeat(48);
  process.env.APP_URL = 'http://localhost:5173';
  delete process.env.NODE_ENV;

  vi.resetModules();
  const dbMod = await import('./db.js');
  dbMod.initDatabase();
  await dbMod.completeDatabaseInit();
  const worker = await import('./workers/notificationWorker.js');
  const service = await import('./emailService.js');
  return { db: dbMod.db, worker, service };
}

/** A provider that behaves as told and remembers what it was handed. */
function fakeProvider(name, behaviour) {
  const sent = [];
  return {
    name, sent,
    isConfigured: () => true,
    describe: () => ({ provider: name, configured: true }),
    async send(message) {
      sent.push(message);
      const r = typeof behaviour === 'function' ? behaviour(message, sent.length) : behaviour;
      if (r instanceof Error) throw r;
      return r || { messageId: `${name}-${sent.length}` };
    },
  };
}

beforeEach(() => { dir = null; });
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('a queued transactional message is actually delivered', () => {
  it('goes out on the next tick and is recorded as sent', async () => {
    const { db, worker, service } = await freshWorker();

    /* Both providers down: this is the path a verification email takes during an
       outage, which before the outbox existed was the path where it vanished. */
    let restore = service.setProvidersForTests({
      resend: fakeProvider('resend', () => Object.assign(new Error('down'), { category: 'transient' })),
      smtp: fakeProvider('smtp', () => Object.assign(new Error('down'), { category: 'transient' })),
    });

    const result = await service.sendEmail(
      {
        to: 'student@school.example.org',
        subject: 'Please verify your email',
        text: 'Verify at https://wevolunteers.org/?verify=tok',
        html: '<p>Verify</p>',
      },
      { flow: 'verification', idempotencyKey: 'verify-1' }
    );
    expect(result.delivered).toBe(false);
    expect(result.queued, 'the message was not written to the outbox').toBe(true);
    restore();

    const queued = await db.prepare("SELECT * FROM notification_jobs WHERE channel = 'email.message'").all();
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe('pending');

    /* The provider comes back. */
    const resend = fakeProvider('resend', { messageId: 're_recovered' });
    restore = service.setProvidersForTests({ resend, smtp: fakeProvider('smtp', {}) });

    await worker.processNotificationJobs();
    restore();

    const [row] = await db.prepare("SELECT * FROM notification_jobs WHERE channel = 'email.message'").all();
    expect(row.status, 'the worker did not deliver a queued message').toBe('sent');
    expect(row.provider_message_id).toBe('re_recovered');
    expect(row.sent_by_provider).toBe('resend');

    /* The message the recipient gets on the retry must be the message that was
       composed, not one re-rendered later from state that has since moved. */
    expect(resend.sent[0].subject).toBe('Please verify your email');
    expect(resend.sent[0].html).toBe('<p>Verify</p>');
    expect(resend.sent[0].to).toBe('student@school.example.org');
    /* And it must leave from the authentication sender, even a day later. */
    expect(resend.sent[0].from).toBe('"WeVolunteer" <noreply@wevolunteers.org>');
    /* Same key as the first attempt, so a provider that silently accepted the
       message the first time does not send a second copy. */
    expect(resend.sent[0].idempotencyKey).toBe('verify-1');
  });

  it('reschedules rather than losing the message when the retry also fails', async () => {
    const { db, worker, service } = await freshWorker();

    let restore = service.setProvidersForTests({
      resend: fakeProvider('resend', () => Object.assign(new Error('down'), { category: 'transient' })),
      smtp: fakeProvider('smtp', () => Object.assign(new Error('down'), { category: 'transient' })),
    });
    await service.sendEmail(
      { to: 'a@school.example.org', subject: 'Reset your password', text: 'link', html: '<p>link</p>' },
      { flow: 'password-reset', idempotencyKey: 'reset-1' }
    );
    await worker.processNotificationJobs();
    restore();

    const [row] = await db.prepare("SELECT * FROM notification_jobs WHERE channel = 'email.message'").all();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error_category).toBe('transient');
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    /* The body must survive a retryable failure — it is what the retry sends. */
    expect(JSON.parse(row.payload).html).toBe('<p>link</p>');
  });

  it('does not pick up a message another worker is already holding', async () => {
    /**
     * The FIRST of two defences, and the weaker one: the pickup query selects
     * only `pending`, so a row already marked `processing` is not seen at all.
     *
     * Named for what it actually proves. An earlier version of this case claimed
     * to test the atomic claim and did not — the row it marked `processing` was
     * filtered out by the SELECT before the claim was ever reached, so it passed
     * with the claim's guard deleted. The guard is asserted separately below.
     */
    const { db, worker, service } = await freshWorker();

    const restore = service.setProvidersForTests({
      resend: fakeProvider('resend', () => Object.assign(new Error('down'), { category: 'transient' })),
      smtp: fakeProvider('smtp', () => Object.assign(new Error('down'), { category: 'transient' })),
    });
    await service.sendEmail(
      { to: 'a@school.example.org', subject: 'Hello', text: 't', html: '<p>t</p>' },
      { flow: 'verification', idempotencyKey: 'claim-1' }
    );
    restore();

    const [queued] = await db.prepare("SELECT * FROM notification_jobs WHERE channel = 'email.message'").all();
    await db.prepare("UPDATE notification_jobs SET status = 'processing' WHERE id = ?").run(queued.id);

    const resend = fakeProvider('resend', { messageId: 're_dupe' });
    const r2 = service.setProvidersForTests({ resend, smtp: fakeProvider('smtp', {}) });
    await worker.processNotificationJobs();
    r2();

    expect(resend.sent, 'a message another worker holds was sent anyway').toHaveLength(0);
  });

  it('claims each row with a status guard, so two workers cannot both send it', async () => {
    /**
     * The SECOND defence, and the one that actually closes the race.
     *
     * Pickup is `SELECT ... WHERE status = 'pending'` followed by a separate
     * `UPDATE`. Two processes — a deploy overlapping its predecessor, a stray
     * dev server on the same file — can both run the SELECT before either runs
     * the UPDATE, and both then see the same row as theirs. `AND status =
     * 'pending'` on the UPDATE means exactly one of them changes a row; the
     * loser sees `changes === 0` and skips. Without it, both send, and the
     * recipient gets the email twice.
     *
     * Asserted structurally because the race cannot be staged from inside one
     * event loop: the SELECT and the UPDATE are synchronous and adjacent, so
     * nothing else in THIS process can interleave between them. The defect is
     * only reachable from a second process, and the guard against it is a
     * property of the statement rather than of any observable single-process
     * behaviour.
     */
    const src = readFileSync(
      path.join(process.cwd(), 'server', 'workers', 'notificationWorker.js'), 'utf8'
    );

    const claim = src.slice(src.indexOf("SET status = 'processing'"));
    expect(claim, 'the claim statement has moved or been renamed').toBeTruthy();

    const statement = claim.slice(0, claim.indexOf(').run('));
    expect(
      statement,
      'the claim no longer guards on the status it selected: two workers can both '
      + 'claim the same row, and the recipient gets the message twice'
    ).toMatch(/WHERE id = \? AND status = 'pending'/);

    /* And the result must be CHECKED. A guarded UPDATE whose `changes` nobody
       reads is exactly as broken as an unguarded one. */
    const after = src.slice(src.indexOf(statement) + statement.length);
    expect(
      after.slice(0, 200),
      'the claim result is not checked, so losing the race changes nothing'
    ).toMatch(/changes === 0/);
  });

  it('does not queue a login code, because a late one is worse than none', async () => {
    const { db, service } = await freshWorker();

    const restore = service.setProvidersForTests({
      resend: fakeProvider('resend', () => Object.assign(new Error('down'), { category: 'transient' })),
      smtp: fakeProvider('smtp', () => Object.assign(new Error('down'), { category: 'transient' })),
    });

    const { send2FACode } = await import('./email.js');
    const ok = await send2FACode('a@school.example.org', '123456');
    restore();

    /* The route turns `false` into a 502 so the person presses the button again.
       A queued code arrives after they have already requested a second one,
       which invalidates it — two messages, and the newer-looking one is dead. */
    expect(ok).toBe(false);
    expect(
      (await db.prepare("SELECT COUNT(*) AS c FROM notification_jobs WHERE channel = 'email.message'").get()).c,
      'a time-critical login code was queued'
    ).toBe(0);
  });
});
