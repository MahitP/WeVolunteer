import express from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../db.js';
import { authenticateToken } from '../utils.js';
import { requireCap } from '../authz.js';
import { sendMail } from '../email.js';
import { APP_NAME } from '../config.js';
/* The address book stays on this side of the boundary — `issueReports.js` is
   bundled into the browser and `emailIdentity.js` reads `process.env` at module
   scope. See the header on `../issueReports.js`. */
import { ADDRESSES } from '../emailIdentity.js';
import {
  validateIssue, sanitiseContext, newIssueId, newReference,
  replyToKeyFor, isSensitive, ISSUE_CATEGORIES,
} from '../issueReports.js';

const router = express.Router();

/**
 * Reporting a problem with the platform.
 *
 * Not the moderation queue. See migration 051 for why a bug report must not be
 * filed alongside a report about a person.
 */

/**
 * Ten reports an hour, keyed on the account.
 *
 * Keyed on the ACCOUNT and not the address, because a school leaves through one
 * public IP — the incident app.js records at length, where a per-IP limit meant
 * one building shared one allowance. Somebody genuinely hitting a broken page
 * may file three in a row while working out what is wrong; ten is well past
 * honest use and well short of a useful flood.
 */
const issueLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.ISSUE_REPORT_LIMIT) || 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  /**
   * Keyed on the ACCOUNT, with no IP fallback.
   *
   * The `|| req.ip` this used to carry was both unnecessary and wrong:
   * unnecessary because the route sits behind `authenticateToken` so a request
   * that reaches the limiter always has a principal, and wrong because
   * express-rate-limit refuses a raw `req.ip` key — an IPv6 client gets a fresh
   * /128 per connection, so an IP-keyed bucket it can rotate out of is not a
   * limit at all. Throwing on a missing principal would be a 500 on a path that
   * cannot produce one; the constant simply shares one bucket, which is the
   * safe direction for a case that should never happen.
   */
  keyGenerator: (req) => `issue:${req.principal?.userId ?? 'anonymous'}`,
  handler: (req, res) => res.status(429).json({
    error: 'You have sent several reports recently. If something urgent is happening, email us directly.',
    code: 'rate_limited',
  }),
});

/** The categories, so the form cannot drift from what the server accepts. */
router.get('/api/issues/categories', authenticateToken, (req, res) => {
  /* `replyTo` is deliberately NOT sent. It is an internal routing decision, and
     publishing it would tell every reader which mailbox each category reaches. */
  res.json({ categories: ISSUE_CATEGORIES.map(({ value, label }) => ({ value, label })) });
});

/**
 * POST /api/issues — file a report.
 *
 * Authenticated, because every reader of this application has an account and an
 * anonymous endpoint that emails staff is a spam relay. A signed-in reporter
 * also means a reply is possible.
 */
router.post('/api/issues', authenticateToken, issueLimiter, async (req, res) => {
  const check = validateIssue(req.body);
  if (!check.ok) {
    return res.status(400).json({ error: check.error, field: check.field });
  }

  const { category, description } = check.value;
  const context = sanitiseContext(req.body?.context);
  const id = newIssueId();
  const reference = newReference();
  const now = new Date().toISOString();

  try {
    await db.prepare(`
      INSERT INTO issue_reports (id, reference, category, description, reporter_id, context, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(id, reference, category, description, req.principal.userId, context ? JSON.stringify(context) : null, now, now);
  } catch (err) {
    console.error('[issues] could not store a report:', err.message);
    return res.status(500).json({ error: 'We could not record that. Please try again.' });
  }

  /**
   * The notification, through the ordinary email path.
   *
   * `sendMail` goes to EmailService — Resend, then SMTP, then the durable
   * outbox — so a report filed while the provider is down is not lost. The
   * route deliberately does not talk to a provider itself.
   *
   * Awaited only far enough to log: a mail failure must not turn a stored
   * report into a 500, because the report IS stored and the reporter should be
   * told so.
   */
  const replyTo = ADDRESSES[replyToKeyFor(category)];
  const label = ISSUE_CATEGORIES.find(c => c.value === category)?.label || category;

  /**
   * A security or privacy report's CONTENTS do not go in the email.
   *
   * The body may describe a live vulnerability or somebody's personal data, and
   * email is the least controlled place it could sit — forwarded, quoted,
   * retained on a phone. The notification says one exists and where to read it;
   * reading it requires the account that may.
   */
  const sensitive = isSensitive(category);
  const body = sensitive
    ? `A ${label.toLowerCase()} was reported.\n\nReference: ${reference}\n\n`
      + 'The contents are deliberately not included in this email. Open the report in the admin area to read it.'
    : `${label}\n\nReference: ${reference}\n\n${description}`;

  sendMail({
    to: replyTo,
    subject: `[${reference}] ${label}`,
    text: body,
    flow: 'notification',
  }).catch((err) => {
    /* The message only, never the report. */
    console.warn(`[issues] notification for ${reference} could not be sent: ${err.message}`);
  });

  return res.status(201).json({
    reference,
    /* Enough to confirm, and nothing internal: no row id, no routing, no
       provider detail. */
    message: 'Report received.',
  });
});

/**
 * GET /api/issues — the staff view.
 *
 * `report.resolve` is the capability that already names "may read what people
 * have reported". Ordinary organizers and students hold none of it, so this is
 * not a feed anybody can browse.
 */
router.get('/api/issues', authenticateToken, requireCap('report.resolve'), async (req, res) => {
  const rows = await db.prepare(`
    SELECT i.id, i.reference, i.category, i.description, i.context, i.status, i.created_at,
           u.name AS reporter_name, u.username AS reporter_username
      FROM issue_reports i
      LEFT JOIN users u ON u.id = i.reporter_id
     ORDER BY i.created_at DESC
     LIMIT 200
  `).all();

  res.json({
    issues: rows.map(r => ({
      id: r.id,
      reference: r.reference,
      category: r.category,
      description: r.description,
      context: r.context ? JSON.parse(r.context) : null,
      status: r.status,
      createdAt: r.created_at,
      reporter: r.reporter_name ? { name: r.reporter_name, username: r.reporter_username } : null,
    })),
  });
});

export default router;
