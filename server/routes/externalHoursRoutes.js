/**
 * External volunteer hours — service done somewhere WeVolunteer does not run.
 *
 * ── What this is NOT ──
 *
 * It is not an event. That is worth stating loudly, because "let students
 * create their own events" is the obvious-looking implementation and it is
 * wrong in a way that is hard to walk back. An `events` row with a student as
 * its organizer would be visible in Browse Opportunities, appliable to by other
 * students, editable through the event routes, countable in organizer
 * dashboards, and — because credited hours are derived from attendance on
 * events — a way to write your own service record.
 *
 * So these live in their own table with no slots, no applications and no
 * roster. There is no code path by which an external record can be listed as an
 * opportunity, applied to, or attended, because the structures those things
 * require do not exist for it. The guarantee is structural, not a rule someone
 * has to remember.
 *
 * ── Self-attested, and labelled as such everywhere ──
 *
 * A student types these in. The platform already names the power to check them
 * — `service.verify.external`, held by administrators — so a record is
 * 'self_reported' until somebody exercises it, and every surface that shows one
 * says which it is. Nothing here is ever summed into credited hours, and
 * nothing here reaches Auto Select; see the header of weighting.js for why the
 * latter is a security property rather than a formatting choice.
 */

import express from 'express';
import crypto from 'node:crypto';
import { authenticateToken } from '../utils.js';
import { can, requireCap } from '../authz.js';
import { db } from '../db.js';

const router = express.Router();

const ACTIVITY_MAX = 200;
const ORGANIZATION_MAX = 200;
const DESCRIPTION_MAX = 2000;

/**
 * The ceiling on a single entry.
 *
 * Not a guess: a day has 24 hours, and one external record describes one
 * activity on one date. The bound exists because an unbounded REAL from a form
 * is how a volunteer log ends up claiming 100000 hours — which would be
 * obviously wrong to a person and completely invisible to a SUM.
 */
const HOURS_MAX = 24;

export function validateExternalHours(payload, { partial = false } = {}) {
  const out = {};
  const need = (key) => !partial || payload[key] !== undefined;

  if (need('organizationName')) {
    if (typeof payload.organizationName !== 'string' || !payload.organizationName.trim()) {
      return { ok: false, field: 'organizationName', error: 'Who did you volunteer with?' };
    }
    if (payload.organizationName.length > ORGANIZATION_MAX) {
      return { ok: false, field: 'organizationName', error: `That must be ${ORGANIZATION_MAX} characters or fewer.` };
    }
    out.organizationName = payload.organizationName.trim();
  }

  if (need('activityName')) {
    if (typeof payload.activityName !== 'string' || !payload.activityName.trim()) {
      return { ok: false, field: 'activityName', error: 'Give the activity a name.' };
    }
    if (payload.activityName.length > ACTIVITY_MAX) {
      return { ok: false, field: 'activityName', error: `That must be ${ACTIVITY_MAX} characters or fewer.` };
    }
    out.activityName = payload.activityName.trim();
  }

  if (payload.description !== undefined) {
    if (payload.description !== null && typeof payload.description !== 'string') {
      return { ok: false, field: 'description', error: 'The description must be text.' };
    }
    const d = payload.description ?? '';
    if (d.length > DESCRIPTION_MAX) {
      return { ok: false, field: 'description', error: `The description must be ${DESCRIPTION_MAX} characters or fewer.` };
    }
    out.description = d;
  }

  if (need('occurredOn')) {
    const raw = payload.occurredOn;
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
      return { ok: false, field: 'occurredOn', error: 'Pick the date you volunteered.' };
    }
    /**
     * A future date is refused.
     *
     * An external record is a report of something that already happened. A date
     * in the future is either a typo or a claim about work not yet done, and
     * both are better caught at the form than discovered in a service record.
     * Compared as date strings against today's, so a shift earlier today is
     * still accepted regardless of the server's clock time.
     */
    if (raw > new Date().toISOString().slice(0, 10)) {
      return { ok: false, field: 'occurredOn', error: 'That date is in the future.' };
    }
    out.occurredOn = raw;
  }

  if (need('hours')) {
    const h = Number(payload.hours);
    if (!Number.isFinite(h) || h <= 0) {
      return { ok: false, field: 'hours', error: 'Enter how many hours you volunteered.' };
    }
    if (h > HOURS_MAX) {
      return { ok: false, field: 'hours', error: `A single entry cannot be more than ${HOURS_MAX} hours. Split it across the days you worked.` };
    }
    out.hours = Number(h.toFixed(2));
  }

  return { ok: true, value: out };
}

const format = (r) => ({
  id: r.id,
  organizationName: r.organization_name,
  activityName: r.activity_name,
  description: r.description || '',
  occurredOn: r.occurred_on,
  hours: r.hours,
  status: r.status,
  reviewNote: r.review_note || null,
  reviewedAt: r.reviewed_at || null,
  createdAt: r.created_at,
});

/** The caller's own external records. Self-scoped by construction. */
router.get('/api/external-hours', authenticateToken, requireCap('portfolio.write'), (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM external_hours WHERE user_id = ? ORDER BY occurred_on DESC, created_at DESC'
  ).all(req.principal.userId);
  res.json({ entries: rows.map(format) });
});

/** Log one. */
router.post('/api/external-hours', authenticateToken, requireCap('portfolio.write'), (req, res) => {
  const check = validateExternalHours(req.body ?? {});
  if (!check.ok) return res.status(400).json({ error: check.error, field: check.field });

  const now = new Date().toISOString();
  const id = `ext-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO external_hours
      (id, user_id, organization_name, activity_name, description, occurred_on, hours, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'self_reported', ?, ?)
  `).run(id, req.principal.userId, check.value.organizationName, check.value.activityName,
    check.value.description ?? '', check.value.occurredOn, check.value.hours, now, now);

  res.status(201).json({ entry: format(db.prepare('SELECT * FROM external_hours WHERE id = ?').get(id)) });
});

/**
 * Edit one.
 *
 * A VERIFIED record cannot be edited by its owner. Somebody with
 * `service.verify.external` has put their name to that number; letting the
 * student then change it would make verification worth nothing, and would do it
 * silently. Editing a verified entry means asking for it to be looked at again,
 * which is a delete-and-relog.
 */
router.patch('/api/external-hours/:id', authenticateToken, requireCap('portfolio.write'), (req, res) => {
  const row = db.prepare('SELECT * FROM external_hours WHERE id = ?').get(req.params.id);
  /* 404, not 403, for somebody else's record: a distinguishable refusal would
     confirm the id exists. Same rule as the export download in privacyRoutes. */
  if (!row || row.user_id !== req.principal.userId) {
    return res.status(404).json({ error: 'No such entry.', code: 'not_found' });
  }
  if (row.status === 'verified') {
    return res.status(409).json({
      error: 'This entry has been verified and can no longer be edited.',
      code: 'verified',
    });
  }

  const check = validateExternalHours(req.body ?? {}, { partial: true });
  if (!check.ok) return res.status(400).json({ error: check.error, field: check.field });

  const map = {
    organizationName: 'organization_name', activityName: 'activity_name',
    description: 'description', occurredOn: 'occurred_on', hours: 'hours',
  };
  const updates = [], values = [];
  for (const [key, column] of Object.entries(map)) {
    if (check.value[key] !== undefined) { updates.push(`${column} = ?`); values.push(check.value[key]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update.' });

  /* A rejected entry that is edited goes back into the queue, rather than
     staying rejected forever with new content nobody will look at. */
  if (row.status === 'rejected') { updates.push(`status = 'self_reported'`, 'review_note = NULL'); }
  updates.push('updated_at = ?'); values.push(new Date().toISOString());
  values.push(row.id);
  db.prepare(`UPDATE external_hours SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  res.json({ entry: format(db.prepare('SELECT * FROM external_hours WHERE id = ?').get(row.id)) });
});

/** Delete one. Verified entries are the owner's to withdraw; see below. */
router.delete('/api/external-hours/:id', authenticateToken, requireCap('portfolio.write'), (req, res) => {
  const row = db.prepare('SELECT * FROM external_hours WHERE id = ?').get(req.params.id);
  if (!row || row.user_id !== req.principal.userId) {
    return res.status(404).json({ error: 'No such entry.', code: 'not_found' });
  }
  /**
   * Deleting a verified entry IS allowed, where editing it is not.
   *
   * The asymmetry is deliberate. Editing a verified number launders an
   * unverified claim through somebody else's signature; removing the entry
   * makes no claim at all, and the record is the student's own to withdraw.
   * Nothing downstream depends on it, because external hours are never summed
   * into credited hours.
   */
  db.prepare('DELETE FROM external_hours WHERE id = ?').run(row.id);
  res.json({ success: true });
});

/* ── Review ─────────────────────────────────────────────────────────────── */

/** The queue of unreviewed entries. */
router.get('/api/admin/external-hours', authenticateToken, requireCap('service.verify.external'), (req, res) => {
  const status = ['self_reported', 'verified', 'rejected'].includes(req.query.status)
    ? req.query.status : 'self_reported';
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const rows = db.prepare(`
    SELECT x.*, u.name AS volunteerName, u.username AS volunteerUsername
    FROM external_hours x
    JOIN users u ON u.id = x.user_id
    WHERE x.status = ?
    ORDER BY x.created_at ASC
    LIMIT ?
  `).all(status, limit);
  res.json({
    entries: rows.map(r => ({
      ...format(r),
      volunteer: { id: r.user_id, name: r.volunteerName, username: r.volunteerUsername },
    })),
  });
});

/** Verify or reject one. */
router.patch('/api/admin/external-hours/:id', authenticateToken, requireCap('service.verify.external'), (req, res) => {
  const status = req.body?.status;
  if (!['verified', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Decision must be verified or rejected.', field: 'status' });
  }
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 1000) : null;
  const row = db.prepare('SELECT * FROM external_hours WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'No such entry.', code: 'not_found' });

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE external_hours SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ?
    WHERE id = ?
  `).run(status, req.principal.userId, now, note, now, row.id);

  res.json({ entry: format(db.prepare('SELECT * FROM external_hours WHERE id = ?').get(row.id)) });
});

export default router;
