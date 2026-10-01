import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import { db } from '../db.js';
import { authenticateToken } from '../utils.js';
import { requireCap } from '../authz.js';
import { sendMail } from '../email.js';
import '../config.js';
/* The address book stays on this side of the boundary — `issueReports.js` is
   bundled into the browser and `emailIdentity.js` reads `process.env` at module
   scope. See the header on `../issueReports.js`. */
import { ADDRESSES } from '../emailIdentity.js';
import {
  validateIssue, sanitiseContext, newIssueId, newReference,
  isSensitive, ISSUE_CATEGORIES,
} from '../issueReports.js';
import { createRedisLimitStore } from '../redis/limitStore.js';
/* Server-only: these keys must not reach the browser bundle. See issueRouting.js. */
import { replyToKeyFor } from '../issueRouting.js';
import { reportForAttaching, countScreenshots, storeScreenshot, readScreenshot } from '../issueScreenshots.js';

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
  store: createRedisLimitStore({ name: 'issue' }),
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

/**
 * ── `GET /api/issues/categories` was here, and is deleted ──
 *
 * It existed "so the form cannot drift from what the server accepts", which is
 * the right goal reached the weaker way. `src/issueReports.js` re-exports
 * `ISSUE_CATEGORIES` from this module directly, so the dropdown and the
 * validator are the same frozen array at BUILD time — a guarantee a request
 * cannot improve on. The endpoint had no caller anywhere in the client, and its
 * only remaining effect was to be a second way to learn the same vocabulary.
 *
 * Deleted rather than kept for compatibility: it is not named in
 * `docs/spec/appendix-api-contracts.md`, nothing outside this repository is
 * documented as calling it, and an authenticated endpoint that answers a
 * question already answered at build time is a route somebody has to keep
 * classifying in `authz.completeness.test.js` for ever.
 *
 * `server/badgeCriteria.js` records the same decision from the other side: it
 * cites this endpoint as the reason the badge criteria vocabulary is shared by
 * import rather than published.
 */

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

/* ── Screenshots (FX-75) ─────────────────────────────────────────────────────
 *
 * The owner asked for a report page that can "include screenshots". A
 * screenshot of somebody's screen is likely to hold their own personal data and
 * other people's, so the rules are narrow:
 *
 *   • Only the person who filed a report may attach to it, and only while it is
 *     fresh. Anybody else, and any report that does not exist, gets the same
 *     404 — a distinguishable refusal would confirm a reference is real.
 *   • Three per report (the table's key enforces it too), fifteen minutes from
 *     filing, five megabytes in.
 *   • Every image is decoded and re-encoded as WebP, at most 1600px on its
 *     longest edge. The re-encode is what drops a photo's EXIF — where it was
 *     taken — and what refuses a file that only claims to be an image: a
 *     declared type is the uploader's word, the decode is the evidence.
 *   • Stored in the database, never under /uploads, which nginx serves to
 *     anybody with the address. Read back only through the route below, which
 *     requires `report.resolve`.
 */
export const SCREENSHOT_LIMIT = 3;
export const SCREENSHOT_WINDOW_MS = 15 * 60 * 1000;
const SCREENSHOT_MAX_INPUT_BYTES = 5 * 1024 * 1024;
const SCREENSHOT_EDGE = 1600;
/* The same decode ceiling avatars use: a guard against a small file that
   expands to an enormous bitmap. */
const SCREENSHOT_MAX_PIXELS = 40 * 1000 * 1000;
const SCREENSHOT_FORMATS = new Set(['png', 'jpeg', 'webp']);

/* Refused uploads are still decoded, so they are bounded too. */
const screenshotLimiter = rateLimit({
  store: createRedisLimitStore({ name: 'issue-shot' }),
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `issue-shot:${req.principal?.userId ?? 'anonymous'}`,
  handler: (req, res) => res.status(429).json({
    error: 'Too many screenshots in a short time. Your report is saved; you can email us the rest.',
    code: 'rate_limited',
  }),
});

const screenshotUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SCREENSHOT_MAX_INPUT_BYTES, files: 1 },
}).single('screenshot');

/** multer's refusals, answered here rather than forwarded to the error handler. */
function receiveScreenshot(req, res, next) {
  screenshotUpload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return res.status(400).json({
        error: err.code === 'LIMIT_FILE_SIZE'
          ? 'That image is larger than 5 MB. A screenshot is usually well under that.'
          : 'Send one image at a time.',
      });
    }
    return next(err);
  });
}

/**
 * POST /api/issues/:reference/screenshots — attach one image to your report.
 */
router.post('/api/issues/:reference/screenshots', authenticateToken, screenshotLimiter, receiveScreenshot, async (req, res) => {
  const issue = await reportForAttaching(db, req.params.reference, req.principal.userId);
  if (!issue) return res.status(404).json({ error: 'No report matches that reference.' });

  if (Date.now() - Date.parse(issue.created_at) > SCREENSHOT_WINDOW_MS) {
    return res.status(409).json({ error: 'Screenshots can be added for fifteen minutes after a report is sent.' });
  }
  const n = await countScreenshots(db, issue.id);
  if (n >= SCREENSHOT_LIMIT) {
    return res.status(409).json({ error: `A report can carry ${SCREENSHOT_LIMIT} screenshots.` });
  }
  if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Choose an image to attach.' });

  let encoded;
  try {
    const meta = await sharp(req.file.buffer, { limitInputPixels: SCREENSHOT_MAX_PIXELS }).metadata();
    if (!SCREENSHOT_FORMATS.has(meta.format)) throw new Error('format');
    encoded = await sharp(req.file.buffer, { limitInputPixels: SCREENSHOT_MAX_PIXELS })
      .rotate()
      .resize(SCREENSHOT_EDGE, SCREENSHOT_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    return res.status(400).json({ error: 'That file is not a PNG, JPEG or WebP image.' });
  }

  try {
    await storeScreenshot(db, { issueId: issue.id, position: n + 1, mimeType: 'image/webp', bytes: encoded });
  } catch (err) {
    /* Two uploads racing for the same position: the key refused the second. */
    console.warn('[issues] screenshot not stored:', err.message);
    return res.status(409).json({ error: 'That screenshot could not be added. Try again.' });
  }

  return res.status(201).json({ position: n + 1 });
});

/**
 * GET /api/issues/:id/screenshots/:position — one image, for staff.
 *
 * `report.resolve`, the capability that already reads reports. `no-store`, so
 * a shared school computer does not keep a copy of somebody's screen in its
 * cache. The bytes are only ever WebP this route encoded itself.
 */
router.get('/api/issues/:id/screenshots/:position', authenticateToken, requireCap('report.resolve'), async (req, res) => {
  const shot = await readScreenshot(db, req.params.id, req.params.position);
  if (!shot) return res.status(404).json({ error: 'No such screenshot.' });

  res.setHeader('Content-Type', shot.mimeType);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', 'inline');
  return res.send(shot.bytes);
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
           u.name AS reporter_name, u.username AS reporter_username,
           (SELECT COUNT(*) FROM issue_report_screenshots s WHERE s.issue_id = i.id) AS screenshots
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
      screenshots: Number(r.screenshots) || 0,
      reporter: r.reporter_name ? { name: r.reporter_name, username: r.reporter_username } : null,
    })),
  });
});

export default router;
