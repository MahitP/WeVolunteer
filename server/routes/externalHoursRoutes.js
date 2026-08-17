/**
 * External volunteer hours — a student's own record of service done elsewhere.
 *
 * ── What this is ──
 *
 * A personal log, and nothing more. A student volunteers at a food bank, a place
 * of worship, a community clean-up — somewhere WeVolunteer does not run — and
 * wants their volunteering history to be complete. They write it down here.
 *
 * It is **self-reported and unverified, by design**. There is no approval, no
 * review queue, no verification status and no administrative workflow, and none
 * should be added: the feature's whole purpose is personal record-keeping, and a
 * verification pipeline would turn a notebook into an application form. An
 * earlier version of this file carried a `service.verify.external` review flow;
 * it was removed because it was never the product.
 *
 * ── What this is NOT ──
 *
 * It is not an event. That is worth stating loudly, because "let students create
 * their own events" is the obvious-looking implementation and it is wrong in a
 * way that is hard to walk back. An `events` row with a student as its organizer
 * would be visible in Browse Opportunities, appliable to by other students,
 * editable through the event routes, countable in organizer dashboards, and —
 * because credited hours are derived from attendance on events — a way to write
 * your own service record.
 *
 * So these live in their own table with no slots, no applications and no roster.
 * There is no code path by which an external record can be listed as an
 * opportunity, applied to, or attended, because the structures those things
 * require do not exist for it. The guarantee is structural, not a rule somebody
 * has to remember.
 *
 * Nothing here is ever summed into credited hours, and nothing here reaches Auto
 * Select — see the header of weighting.js for why the latter is a security
 * property and not a formatting preference. Every surface that displays one says
 * it is self-reported, so the number is never mistaken for one an organizer
 * confirmed.
 */

import express from 'express';
import crypto from 'node:crypto';
import { authenticateToken } from '../utils.js';
import { requireCap } from '../authz.js';
import { db } from '../db.js';
import { validateExternalHours } from '../externalHoursRules.js';

const router = express.Router();

export { validateExternalHours, HOURS_MAX, ACTIVITY_MAX, ORGANIZATION_MAX, DESCRIPTION_MAX } from '../externalHoursRules.js';

/**
 * `selfReported: true` is emitted on every entry, unconditionally.
 *
 * A constant rather than a stored column, because it is a fact about the whole
 * table rather than a per-row state — there is no other kind of external entry.
 * It is sent so no client has to remember to label these, and so a future
 * consumer that forgets gets an obviously-true field rather than silence.
 */
const format = (r) => ({
  id: r.id,
  organizationName: r.organization_name,
  activityName: r.activity_name,
  description: r.description || '',
  occurredOn: r.occurred_on,
  hours: r.hours,
  selfReported: true,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The caller's own external records. Self-scoped by construction. */
router.get('/api/external-hours', authenticateToken, requireCap('portfolio.write'), async (req, res) => {
  const rows = await db.prepare(
    'SELECT * FROM external_hours WHERE user_id = ? ORDER BY occurred_on DESC, created_at DESC'
  ).all(req.principal.userId);
  res.json({ entries: rows.map(format) });
});

/** Log one. */
router.post('/api/external-hours', authenticateToken, requireCap('portfolio.write'), async (req, res) => {
  const check = validateExternalHours(req.body ?? {});
  if (!check.ok) return res.status(400).json({ error: check.error, field: check.field });

  const now = new Date().toISOString();
  const id = `ext-${crypto.randomUUID()}`;
  await db.prepare(`
    INSERT INTO external_hours
      (id, user_id, organization_name, activity_name, description, occurred_on, hours, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.principal.userId, check.value.organizationName, check.value.activityName,
    check.value.description ?? '', check.value.occurredOn, check.value.hours, now, now);

  res.status(201).json({ entry: format(await db.prepare('SELECT * FROM external_hours WHERE id = ?').get(id)) });
});

/**
 * Edit one. Freely, and at any time.
 *
 * There is no state in which an entry becomes uneditable, because there is
 * nobody else's judgement stored on it. It is the owner's note about their own
 * afternoon; if they wrote down the wrong date they should be able to fix it
 * without deleting and retyping the rest.
 */
router.patch('/api/external-hours/:id', authenticateToken, requireCap('portfolio.write'), async (req, res) => {
  const row = await db.prepare('SELECT * FROM external_hours WHERE id = ?').get(req.params.id);
  /* 404, not 403, for somebody else's record: a distinguishable refusal would
     confirm the id exists. Same rule as the export download in privacyRoutes. */
  if (!row || row.user_id !== req.principal.userId) {
    return res.status(404).json({ error: 'No such entry.', code: 'not_found' });
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

  updates.push('updated_at = ?'); values.push(new Date().toISOString());
  values.push(row.id);
  await db.prepare(`UPDATE external_hours SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  res.json({ entry: format(await db.prepare('SELECT * FROM external_hours WHERE id = ?').get(row.id)) });
});

/** Delete one. The owner's record, the owner's to remove. */
router.delete('/api/external-hours/:id', authenticateToken, requireCap('portfolio.write'), async (req, res) => {
  const row = await db.prepare('SELECT * FROM external_hours WHERE id = ?').get(req.params.id);
  if (!row || row.user_id !== req.principal.userId) {
    return res.status(404).json({ error: 'No such entry.', code: 'not_found' });
  }
  await db.prepare('DELETE FROM external_hours WHERE id = ?').run(row.id);
  res.json({ success: true });
});

export default router;
