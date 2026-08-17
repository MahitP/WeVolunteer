import express from 'express';
import { verifySignature, applyEvent } from '../resendWebhook.js';

const router = express.Router();

/**
 * Resend delivery events.
 *
 * ── Why this route has no session ──
 *
 * The caller is Resend, which has no WeVolunteer account. Authentication is the
 * signature, and the signature is the ONLY thing that authenticates it — so the
 * verification runs before a single field of the body is read, and a body that
 * fails it is never parsed at all.
 *
 * ── Why it always answers 2xx once verified ──
 *
 * Resend retries a non-2xx. That is right for a transient outage and wrong for
 * a payload we will never be able to process: an unrecognised event type or a
 * message id from before the outbox existed would be retried on a schedule
 * forever. So a verified event is acknowledged, and whether it changed anything
 * is reported in the body for an operator rather than through the status code.
 *
 * The refusals are the other way round: an unverified request gets 401 and is
 * not retried into a state change, because nothing about it is trustworthy.
 */
router.post('/api/webhooks/resend', async (req, res) => {
  /**
   * `req.body` is a Buffer here — see the `express.raw` mount in app.js.
   *
   * It has to be the bytes as received. Re-serialising a parsed object changes
   * key order and whitespace, and the HMAC is over the exact bytes, so a
   * signature check against `JSON.stringify(req.body)` fails for every valid
   * request and passes for none. That failure looks like a wrong secret, which
   * is a long way to chase.
   */
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

  const verdict = verifySignature(raw, req.headers);
  if (!verdict.ok) {
    /* The reason goes to the log, not the response. "stale" versus
       "bad_signature" tells an attacker which half of the check they passed. */
    console.warn(`[resend-webhook] refused (${verdict.reason})`);
    return res.status(verdict.reason === 'not_configured' ? 503 : 401)
      .json({ error: 'Signature verification failed.' });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Malformed payload.' });
  }

  try {
    const result = await applyEvent(payload);
    return res.status(200).json({ received: true, applied: result.applied, reason: result.reason });
  } catch (err) {
    /* A database problem is genuinely transient, so this one SHOULD be retried
       — it is the one case where a 5xx is the honest answer. The message is
       logged without the payload, which carries a recipient address. */
    console.error('[resend-webhook] could not record event:', err.message);
    return res.status(500).json({ error: 'Could not record event.' });
  }
});

export default router;
