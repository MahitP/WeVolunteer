import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  verifySignature, applyEvent, deliveryHealth,
  HANDLED_EVENTS, REPLAY_WINDOW_MS,
} from './resendWebhook.js';
import up047 from './migrations/047_email_outbox.js';
import up050 from './migrations/050_delivery_events.js';

/**
 * The Resend delivery webhook.
 *
 * ── Why this endpoint gets its own file ──
 *
 * It is the only route in the application that accepts a state-changing request
 * from outside with no session at all. Its authentication IS the signature, so
 * every way that check can be wrong is a way for anybody on the internet to
 * mark a student's address as bounced — which, once bounce handling acts on it,
 * is a way to stop somebody receiving their verification email.
 *
 * So the cases below are about the check itself, not about the happy path.
 */

const SECRET = `whsec_${Buffer.from('a-test-signing-secret-not-a-real-one').toString('base64')}`;

/** Signs a body the way Resend does, so a valid request is genuinely valid. */
function sign(body, { id = 'msg_test_1', at = Date.now(), secret = SECRET } = {}) {
  const timestamp = Math.floor(at / 1000);
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signature = crypto.createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    'svix-id': id,
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${signature}`,
  };
}

const event = (type, over = {}) => JSON.stringify({
  type,
  created_at: new Date().toISOString(),
  data: { id: `evt_${type}_1`, email_id: 're_msg_abc', to: ['student@school.example.org'], ...over },
});

let db;

beforeEach(() => {
  vi.stubEnv('RESEND_WEBHOOK_SECRET', SECRET);
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE notification_jobs (
      id TEXT PRIMARY KEY, channel TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0,
      next_attempt_at TEXT NOT NULL, error_log TEXT, created_at TEXT NOT NULL
    )
  `);
  /* The real migrations, not a hand-written copy — otherwise these cases pass
     against a schema production does not have. */
  up047.up(db);
  up050.up(db);
});

afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const seedJob = (messageId) => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO notification_jobs
      (id, channel, payload, status, next_attempt_at, created_at, provider_message_id, sent_by_provider)
    VALUES ('job-1', 'email.message', '{}', 'sent', ?, ?, ?, 'resend')
  `).run(now, now, messageId);
  return 'job-1';
};

/* ─────────────────────────── the signature ─────────────────────────── */

describe('signature verification', () => {
  it('accepts a correctly signed body', () => {
    const body = event('email.delivered');
    expect(verifySignature(Buffer.from(body), sign(body))).toEqual({ ok: true });
  });

  it('refuses a body that was altered after signing', () => {
    /* The whole point: the signature covers the bytes, so changing which
       address bounced invalidates it. */
    const body = event('email.bounced');
    const headers = sign(body);
    const tampered = body.replace('student@school.example.org', 'victim@school.example.org');
    expect(verifySignature(Buffer.from(tampered), headers).ok).toBe(false);
  });

  it('refuses a signature made with a different secret', () => {
    const body = event('email.delivered');
    const headers = sign(body, { secret: `whsec_${Buffer.from('attacker-guess').toString('base64')}` });
    expect(verifySignature(Buffer.from(body), headers)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a replayed request once the window has passed', () => {
    /**
     * A signature proves the sender knew the secret at some point; it says
     * nothing about when. Without the window a captured request is valid
     * forever, and a replayed `email.bounced` would mark a working address as
     * undeliverable at any time in the future.
     */
    const body = event('email.bounced');
    const stale = sign(body, { at: Date.now() - REPLAY_WINDOW_MS - 60_000 });
    expect(verifySignature(Buffer.from(body), stale)).toEqual({ ok: false, reason: 'stale' });
  });

  it('accepts a request inside the window', () => {
    const body = event('email.delivered');
    const recent = sign(body, { at: Date.now() - 30_000 });
    expect(verifySignature(Buffer.from(recent && body), recent).ok).toBe(true);
  });

  it('refuses when headers are missing', () => {
    const body = event('email.delivered');
    expect(verifySignature(Buffer.from(body), {})).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('does not throw on a short signature', () => {
    /**
     * `crypto.timingSafeEqual` THROWS when the two buffers differ in length, so
     * without the length guard a one-character signature would be a 500 rather
     * than a 401 — a crash, and an oracle telling the sender their length was
     * wrong.
     */
    const body = event('email.delivered');
    const headers = { ...sign(body), 'svix-signature': 'v1,x' };
    expect(() => verifySignature(Buffer.from(body), headers)).not.toThrow();
    expect(verifySignature(Buffer.from(body), headers).ok).toBe(false);
  });

  it('refuses everything when no secret is configured', () => {
    /* Fail closed. An endpoint that accepts unsigned events because nobody set
       the secret is worse than one that is switched off. */
    vi.stubEnv('RESEND_WEBHOOK_SECRET', '');
    const body = event('email.delivered');
    expect(verifySignature(Buffer.from(body), sign(body))).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('accepts one of several signatures during a secret rotation', () => {
    /* Resend sends a space-separated list while a secret is being rotated. */
    const body = event('email.delivered');
    const good = sign(body);
    const headers = { ...good, 'svix-signature': `v1,AAAA ${good['svix-signature']}` };
    expect(verifySignature(Buffer.from(body), headers).ok).toBe(true);
  });
});

/* ─────────────────────────── applying events ─────────────────────────── */

describe('applying a verified event', () => {
  it('records the outcome against the matching outbox row', () => {
    seedJob('re_msg_abc');
    const r = applyEvent(JSON.parse(event('email.delivered')), { handle: db });
    expect(r.applied).toBe(true);

    const job = db.prepare('SELECT * FROM notification_jobs WHERE id = ?').get('job-1');
    expect(job.delivery_state).toBe('delivered');
    expect(job.delivery_updated_at).toBeTruthy();
  });

  it('is idempotent — a replayed event changes nothing a second time', () => {
    seedJob('re_msg_abc');
    const payload = JSON.parse(event('email.bounced'));
    expect(applyEvent(payload, { handle: db }).applied).toBe(true);
    const second = applyEvent(payload, { handle: db });
    expect(second.applied).toBe(false);
    expect(second.reason).toBe('duplicate');
    expect(db.prepare('SELECT COUNT(*) c FROM resend_webhook_events').get().c).toBe(1);
  });

  it('does not let a late "delivered" erase a bounce', () => {
    /**
     * Events are not ordered. A message that bounced at one recipient and was
     * delivered at another can produce both, in either order, and the
     * later-arriving good news would overwrite the outcome an operator needs.
     */
    seedJob('re_msg_abc');
    applyEvent(JSON.parse(event('email.bounced')), { handle: db });
    applyEvent(JSON.parse(event('email.delivered', { id: 'evt_later' })), { handle: db });

    const job = db.prepare('SELECT delivery_state FROM notification_jobs WHERE id = ?').get('job-1');
    expect(job.delivery_state, 'a bounce was overwritten by a later delivery').toBe('bounced');
  });

  it('records an event for a message the outbox no longer has', () => {
    /* A `sent` row is swept after a day; a bounce can arrive later. The event
       still has to be visible, so this is not an error. */
    const r = applyEvent(JSON.parse(event('email.bounced')), { handle: db });
    expect(r.applied).toBe(true);
    expect(r.reason).toBe('no_matching_job');
    expect(db.prepare('SELECT COUNT(*) c FROM resend_webhook_events').get().c).toBe(1);
  });

  it('ignores an event type it does not handle', () => {
    /* `email.opened` is deliberately unhandled — see the note in
       resendWebhook.js on why open tracking is not wanted here. */
    const r = applyEvent(JSON.parse(event('email.opened')), { handle: db });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('unhandled_event');
    expect(HANDLED_EVENTS['email.opened']).toBeUndefined();
  });

  it('stores the recipient domain and never the local part', () => {
    /* The domain diagnoses a relay or reputation problem; the local part
       identifies a specific child and diagnoses nothing. */
    applyEvent(JSON.parse(event('email.bounced')), { handle: db });
    const row = db.prepare('SELECT * FROM resend_webhook_events').get();
    expect(row.recipient_domain).toBe('school.example.org');
    expect(JSON.stringify(row)).not.toMatch(/student@/);
  });

  it('stores no message body or subject', () => {
    applyEvent(JSON.parse(event('email.delivered', { subject: 'Reset your password' })), { handle: db });
    const row = db.prepare('SELECT * FROM resend_webhook_events').get();
    expect(JSON.stringify(row)).not.toMatch(/Reset your password/);
  });
});

describe('the health view', () => {
  it('counts by outcome without exposing addresses', () => {
    applyEvent(JSON.parse(event('email.delivered')), { handle: db });
    applyEvent(JSON.parse(event('email.bounced', { id: 'evt_b' })), { handle: db });
    applyEvent(JSON.parse(event('email.complained', { id: 'evt_c' })), { handle: db });

    const h = deliveryHealth({ handle: db });
    expect(h).toMatchObject({ configured: true, delivered: 1, bounced: 1, complained: 1 });
    expect(JSON.stringify(h)).not.toMatch(/@/);
  });

  it('reports unavailable rather than throwing before the migration has run', () => {
    const bare = new DatabaseSync(':memory:');
    expect(deliveryHealth({ handle: bare }).unavailable).toBe(true);
    bare.close();
  });
});
