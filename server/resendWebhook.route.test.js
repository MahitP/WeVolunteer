import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { startTestServer } from './testServer.js';

/**
 * The webhook over real HTTP.
 *
 * ── Why this is separate from the unit tests ──
 *
 * `resendWebhook.test.js` proves the signature maths and the event handling.
 * Neither would catch the thing most likely to break this endpoint: the body
 * parser.
 *
 * The signature is an HMAC over the exact bytes received. `express.json` is
 * mounted globally in app.js, and if it runs first it consumes the body and
 * hands the route a parsed object — at which point the only way to verify is
 * `JSON.stringify(req.body)`, which produces different key order and whitespace
 * and therefore fails for every legitimate request and passes for none.
 *
 * That failure is indistinguishable from a wrong secret, and the tempting fix
 * is to go looking at Resend. So the mount ordering is asserted here, through
 * the real stack, where getting it wrong is visible.
 */

const SECRET = `whsec_${Buffer.from('route-test-signing-secret').toString('base64')}`;

let srv;

beforeAll(async () => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
  delete process.env.RESEND_WEBHOOK_SECRET;
});

function sign(body, { id = 'msg_route_1', at = Date.now(), secret = SECRET } = {}) {
  const timestamp = Math.floor(at / 1000);
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signature = crypto.createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    'svix-id': id,
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${signature}`,
    'content-type': 'application/json',
  };
}

const post = (body, headers) => fetch(`${srv.base}/api/webhooks/resend`, {
  method: 'POST', headers, body,
});

const eventBody = (type, id) => JSON.stringify({
  type,
  created_at: new Date().toISOString(),
  data: { id, email_id: 're_route_msg', to: ['student@school.example.org'] },
});

describe('POST /api/webhooks/resend', () => {
  it('accepts a correctly signed event — proving the raw body survived the parsers', async () => {
    const body = eventBody('email.delivered', 'evt_route_ok');
    const res = await post(body, sign(body));
    expect(res.status, 'a valid signature was rejected — check the express.raw mount order').toBe(200);
    expect((await res.json()).received).toBe(true);
  });

  it('refuses an unsigned request', async () => {
    /* The endpoint has no session. The signature is the ONLY authentication, so
       an unsigned request must not reach the handler at all. */
    const body = eventBody('email.bounced', 'evt_route_unsigned');
    const res = await post(body, { 'content-type': 'application/json' });
    expect(res.status).toBe(401);
  });

  it('refuses a body altered after signing', async () => {
    const body = eventBody('email.bounced', 'evt_route_tamper');
    const headers = sign(body);
    const tampered = body.replace('student@', 'victim@');
    expect((await post(tampered, headers)).status).toBe(401);
  });

  it('refuses a replayed request', async () => {
    const body = eventBody('email.bounced', 'evt_route_replay');
    const res = await post(body, sign(body, { at: Date.now() - 60 * 60 * 1000 }));
    expect(res.status).toBe(401);
  });

  it('does not say WHICH half of the check failed', async () => {
    /**
     * "stale" versus "bad signature" tells an attacker they have the secret but
     * the wrong clock, which is most of the way to a working forgery. The reason
     * goes to the log; the response says one thing.
     */
    const body = eventBody('email.delivered', 'evt_route_oracle');
    const stale = await post(body, sign(body, { at: Date.now() - 60 * 60 * 1000 }));
    const wrongKey = await post(body, sign(body, { secret: `whsec_${Buffer.from('nope').toString('base64')}` }));

    expect(stale.status).toBe(wrongKey.status);
    expect(await stale.text()).toBe(await wrongKey.text());
  });

  it('rejects a malformed payload that is nonetheless signed', async () => {
    /* A correct signature does not make the contents valid JSON. */
    const body = '{ not json at all';
    const res = await post(body, sign(body));
    expect(res.status).toBe(400);
  });

  it('acknowledges an event type it does not handle rather than making Resend retry', async () => {
    /**
     * A non-2xx is retried on a schedule. For something we will never process —
     * an unhandled type, or a message id from before the outbox existed — that
     * is a retry loop with no end. Verified events are acknowledged.
     */
    const body = eventBody('email.opened', 'evt_route_opened');
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toBe(false);
  });

  it('is idempotent over HTTP', async () => {
    const body = eventBody('email.delivered', 'evt_route_dupe');
    const headers = sign(body);
    expect((await post(body, headers)).status).toBe(200);
    const second = await post(body, headers);
    expect(second.status).toBe(200);
    expect((await second.json()).reason).toBe('duplicate');
  });

  it('never echoes the payload back', async () => {
    /* The payload carries a recipient address. The response is a receipt. */
    const body = eventBody('email.delivered', 'evt_route_echo');
    const text = await (await post(body, sign(body))).text();
    expect(text).not.toMatch(/student@school\.example\.org/);
  });

  it('is not throttled by the blanket API limiter', async () => {
    /**
     * Every delivery event arrives from Resend's own addresses, so all of them
     * share one per-IP bucket — and one send produces up to three events.
     * Signup day at a school is a few hundred verification emails in a few
     * minutes, comfortably past the blanket 600-per-15-minutes.
     *
     * The 429s would not lose events (Resend retries), but they would delay
     * them and fill the log with a failure that is not one. Asserted with a
     * burst rather than by reading the config, so a future change to the
     * exemption is caught by behaviour.
     */
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const body = eventBody('email.delivered', `evt_burst_${i}`);
        return post(body, sign(body, { id: `msg_burst_${i}` })).then(r => r.status);
      })
    );
    expect(results.filter(s => s === 429), 'the webhook was rate limited').toHaveLength(0);
  });
});
