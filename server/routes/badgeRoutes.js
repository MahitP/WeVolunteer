import express from 'express';
import crypto from 'crypto';
import { db } from '../db.js';
import { authenticateToken, inTransaction } from '../utils.js';
import { can, requireCap } from '../authz.js';
import { recordAudit } from '../auditLog.js';
import { BADGE_CRITERIA_TYPES, isKnownCriteriaType } from '../services/badgeService.js';

const router = express.Router();

/**
 * ── Both read routes below were UNAUTHENTICATED until this fix ──
 *
 * `GET /api/users/:userId/badges` takes a user id in the path and answered with
 * that person's achievement history and the timestamp of every award, to
 * anybody on the internet, for a population that is mostly minors. User ids
 * appear in ordinary application URLs, so no guessing was required to walk it.
 *
 * They were also invisible to `authz.completeness.test.js` Guard 2, and the
 * reason is worth keeping: that guard walks the router stack for routes which
 * ARE authenticated and carry no capability gate. A route with no
 * `authenticateToken` is not in the set it examines at all — so the weakest
 * routes in the application were precisely the ones the completeness guard
 * could not see. Adding the middleware is what puts them under review; the
 * ROUTE_REGISTRY entries added alongside are where the reasoning is recorded.
 *
 * ── Why authenticated rather than gated further ──
 *
 * The catalogue (`GET /api/badges`) is badge DEFINITIONS — names, icons,
 * criteria. It is not personal data about anyone, so a session is all it needs;
 * requiring one at all is the same reasoning `GET /api/leaderboard` records,
 * which is to keep it off the open internet for scraping.
 *
 * The per-user list is somebody else's achievements, and it takes the posture
 * `GET /api/users/:id/profile` already takes for exactly this class of data —
 * not a new one invented here. That route returns `milestones` (earned
 * achievements) and the full completed-service history to any authenticated
 * caller, gating only contact PII and future whereabouts. Badges carry neither:
 * no contact details, and an `earned_at` is a date in the past, not a place a
 * child will be. `BadgesList` renders on that very profile page, so gating it
 * more tightly than the page around it would break the view for the organizers
 * and staff the profile exists to serve, while the same facts stayed visible
 * two lines up the response.
 */

// GET all badges available in the system
router.get('/api/badges', authenticateToken, (req, res) => {
  try {
    const badges = db.prepare('SELECT * FROM badges WHERE active = 1 ORDER BY category, criteria_value').all();
    res.json({ badges });
  } catch (err) {
    console.error('Failed to get badges:', err);
    res.status(500).json({ error: 'Failed to get badges' });
  }
});

/**
 * GET one person's earned badges.
 *
 * `directory.read` for the same reason `GET /api/users/:id/profile` now carries
 * it, and stated here rather than inherited: this route's recorded posture is
 * explicitly "matching that route's posture for the same class of data", so the
 * two have to move together or the registry entry stops being true. A partner
 * is an external organization and is deliberately outside the member directory;
 * one student's achievement history is inside it.
 */
router.get('/api/users/:userId/badges', authenticateToken, (req, res) => {
  if (!can(req.principal, 'directory.read')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const userBadges = db.prepare(`
      SELECT b.*, ub.earned_at
      FROM user_badges ub
      JOIN badges b ON ub.badge_id = b.id
      WHERE ub.user_id = ?
      ORDER BY ub.earned_at DESC
    `).all(req.params.userId);
    res.json({ badges: userBadges });
  } catch (err) {
    console.error('Failed to get user badges:', err);
    res.status(500).json({ error: 'Failed to get user badges' });
  }
});

// Admin: GET all badges including inactive
router.get('/api/admin/badges', authenticateToken, requireCap('event.moderate'), (req, res) => {
  try {
    const badges = db.prepare('SELECT * FROM badges ORDER BY created_at DESC').all();
    res.json({ badges });
  } catch (err) {
    console.error('Failed to get admin badges:', err);
    res.status(500).json({ error: 'Failed to load badges' });
  }
});

/**
 * Admin: create or update a badge definition.
 *
 * ── Why `criteria_type` is validated ──
 *
 * It was not. Anything the body carried was written straight to the column, so
 * `'hourz'` produced a badge that passed every check in the application,
 * appeared in the catalogue for every signed-in user, and could never be earned:
 * `badgeService`'s switch falls through to "not mine to decide" on a type it
 * does not know. Nothing failed, nothing logged, and the only symptom was a
 * badge nobody ever got — which reads as "nobody has qualified yet".
 *
 * The vocabulary is imported from the evaluator rather than restated here, so
 * the validator and the switch cannot drift apart. Restating it is how they
 * would: adding a criteria type is one edit, and the second edit is the one
 * people forget.
 */
router.post('/api/admin/badges', authenticateToken, requireCap('event.moderate'), (req, res) => {
  const { id, name, description, icon, category, criteria_type, criteria_value, active } = req.body;
  if (!name || !description || !icon || !category || !criteria_type) {
    return res.status(400).json({ error: 'Missing required badge fields.' });
  }

  if (!isKnownCriteriaType(criteria_type)) {
    return res.status(400).json({
      error: `Unknown criteria_type "${criteria_type}". `
        + `Badges are only earnable for: ${BADGE_CRITERIA_TYPES.join(', ')}.`,
      field: 'criteria_type'
    });
  }

  /**
   * A threshold that is not a number is the same defect wearing a different
   * hat: `Number('ten') >= x` is false for every x, so the badge is unearnable
   * and looks fine. `manual` badges legitimately carry no threshold.
   */
  const threshold = criteria_value === undefined || criteria_value === null || criteria_value === ''
    ? 0
    : Number(criteria_value);
  if (!Number.isFinite(threshold) || threshold < 0) {
    return res.status(400).json({
      error: 'criteria_value must be a number of 0 or more.',
      field: 'criteria_value'
    });
  }

  try {
    let badgeId = id;
    let created = false;

    inTransaction(() => {
      if (id) {
        const existing = db.prepare('SELECT id FROM badges WHERE id = ?').get(id);
        if (!existing) {
          const err = new Error('badge_not_found');
          err.notFound = true;
          throw err;
        }
        db.prepare(`
          UPDATE badges SET name = ?, description = ?, icon = ?, category = ?,
                            criteria_type = ?, criteria_value = ?, active = ?
          WHERE id = ?
        `).run(name, description, icon, category, criteria_type, threshold, active ? 1 : 0, id);
      } else {
        badgeId = `badge-${crypto.randomUUID()}`;
        created = true;
        db.prepare(`
          INSERT INTO badges (id, name, description, icon, category, criteria_type, criteria_value, active, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(badgeId, name, description, icon, category, criteria_type, threshold, active ? 1 : 0, new Date().toISOString());
      }

      /* Defining what the platform recognises is an administrative act on every
         student's record at once, so it is audited like one. No targetUserId —
         a definition is about nobody in particular. */
      recordAudit(db, {
        adminId: req.user.id,
        action: created ? 'BADGE_DEFINED' : 'BADGE_DEFINITION_UPDATED',
        details: `"${name}" (${criteria_type} ≥ ${threshold})${active ? '' : ', inactive'}`
      });
    });

    res.json({ success: true, badgeId });
  } catch (err) {
    if (err.notFound) return res.status(404).json({ error: 'Badge not found' });
    console.error('Failed to save badge:', err);
    res.status(500).json({ error: 'Failed to save badge' });
  }
});

/**
 * Admin: award a badge by hand.
 *
 * ── Why this writes an audit row ──
 *
 * It did not, and it was the only administrative action on a student's record
 * that did not. Every other one — approving an organizer, resolving a report,
 * issuing a warning — leaves a row naming who did it. A badge is a permanent,
 * publicly visible statement on a minor's profile that an adult chose to put
 * there, and until now the only trace of who chose was an `awarded_by` column
 * that nothing reads and no screen shows.
 *
 * Inside the transaction with the insert, deliberately: `recordAudit` never
 * catches, so an audit row that cannot be written takes the award down with it.
 * Awarded-but-not-recorded is the failure this is here to prevent.
 */
router.post('/api/admin/badges/award', authenticateToken, requireCap('event.moderate'), (req, res) => {
  const { userId, badgeId, reason } = req.body;
  if (!userId || !badgeId) return res.status(400).json({ error: 'User and Badge required.' });

  try {
    const recipient = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
    if (!recipient) return res.status(404).json({ error: 'Volunteer not found' });

    const badge = db.prepare('SELECT id, name FROM badges WHERE id = ?').get(badgeId);
    if (!badge) return res.status(404).json({ error: 'Badge not found' });

    const existing = db.prepare('SELECT id FROM user_badges WHERE user_id = ? AND badge_id = ?')
      .get(userId, badgeId);
    if (existing) {
      /* 409, not 400. The request is well-formed; it conflicts with the
         UNIQUE(user_id, badge_id) state that already exists. */
      return res.status(409).json({ error: 'This volunteer already holds that badge.' });
    }

    inTransaction(() => {
      db.prepare(`
        INSERT INTO user_badges (id, user_id, badge_id, earned_at, awarded_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(`ub-${crypto.randomUUID()}`, userId, badgeId, new Date().toISOString(), req.user.id);

      recordAudit(db, {
        adminId: req.user.id,
        action: 'BADGE_AWARDED',
        targetUserId: userId,
        details: `Awarded "${badge.name}" by hand${reason ? ` — ${reason}` : ''}`
      });
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to award badge:', err);
    res.status(500).json({ error: 'Failed to award badge' });
  }
});

/**
 * Admin: take a badge back.
 *
 * ── Why this route had to exist ──
 *
 * There was no way to remove a badge at all. Attendance can be un-marked —
 * `finalizeAttendance` produces an `outcome.revoked` list and the hours come
 * back off the ledger — and the badge earned on those hours stayed, permanently,
 * on the profile page that also showed the corrected record. There was likewise
 * no way to undo a manual award made to the wrong student. `badgeService` now
 * withdraws its OWN awards when the criteria stop holding; this route is for
 * the ones it must not touch, which is every award a person made by hand.
 *
 * Gated on `event.moderate` — the same capability as awarding, because taking a
 * recognition away from a student is not a lesser act than giving one, and a
 * split would create a role that can only delete.
 */
router.delete(
  '/api/admin/users/:userId/badges/:badgeId',
  authenticateToken,
  requireCap('event.moderate'),
  (req, res) => {
    const { userId, badgeId } = req.params;
    const reason = req.body?.reason;

    try {
      const held = db.prepare(`
        SELECT ub.id, ub.awarded_by, b.name
        FROM user_badges ub
        JOIN badges b ON b.id = ub.badge_id
        WHERE ub.user_id = ? AND ub.badge_id = ?
      `).get(userId, badgeId);

      /* One 404 for "no such award", whether the cause is an unknown user, an
         unknown badge or a badge this person never held. The route answers a
         question about a pairing, so the pairing is the only thing it reports
         on — and there is nothing here worth distinguishing for a caller who is
         already an administrator. */
      if (!held) return res.status(404).json({ error: 'This volunteer does not hold that badge.' });

      inTransaction(() => {
        db.prepare('DELETE FROM user_badges WHERE id = ?').run(held.id);

        recordAudit(db, {
          adminId: req.user.id,
          action: 'BADGE_REVOKED',
          targetUserId: userId,
          details: `Revoked "${held.name}"`
            + (held.awarded_by ? ' (awarded by hand)' : ' (awarded automatically)')
            + (reason ? ` — ${reason}` : '')
        });
      });

      res.json({ success: true });
    } catch (err) {
      console.error('Failed to revoke badge:', err);
      res.status(500).json({ error: 'Failed to revoke badge' });
    }
  }
);

export default router;
