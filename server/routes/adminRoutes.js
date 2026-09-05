import express from 'express';
import { runInTransaction } from '../db/connectionContext.js';
import crypto from 'node:crypto';

import { authenticateToken, formatUserResponse } from '../utils.js';
import { db } from '../db.js';
import { notificationService } from '../services/notificationService.js';
import { getMailHealth } from '../email.js';
import { csvCell } from '../csv.js';
import { getQueueHealth } from '../workers/notificationWorker.js';
/* Shared with `alerting.js`, which asks the same question for somebody who did
   not come to look. Two definitions of "stale" would drift. */
import { backupStatus } from '../backupStatus.js';
/* Moved to hoursLedger.js, where the ledger lives, when the Owner Center became
   its second reader. Two copies of a parity query is two answers to "do the
   numbers agree". */
import { hoursLedgerStatus } from '../hoursLedger.js';
import { redisStatus } from '../redis/status.js';
import { weatherCacheStats } from './weatherRoutes.js';
import { geocodeCacheStats } from './geocodeRoutes.js';
import { requireCap, can, principalFor, ALL_CAPABILITIES, requireAAL2, ROLE } from '../authz.js';
import { grantsFor } from '../userCapabilities.js';
import { ChallengeNotSpent, refuseReauth, spendChallenge } from '../reauthResponses.js';
import { syncOrganizerCapabilities } from '../organizationRoles.js';
import { recordAudit } from '../auditLog.js';
import { deleteUploadedFile } from './profilePictureRoutes.js';
import { deliveryHealth } from '../resendWebhook.js';
import { insertionTiebreak, caseInsensitiveLike } from '../db/dialectSql.js';
import {
  REPORT_PRIORITIES, REPORT_RESOLUTIONS, REPORT_STATUSES, REPORT_TARGET_TYPES,
  LIVE_REPORT_STATUSES, CATEGORY_VALUES, isValidCategory, normalizeTargetType,
} from '../moderation.js';

const router = express.Router();

router.get('/api/admin/organizers/pending', authenticateToken, requireCap('organizer.approve'), async (req, res) => {
  try {
    const rows = await db.prepare("SELECT * FROM users WHERE role = 'organizer' AND verified = 0").all();
    const formatted = await Promise.all(rows.map(r => formatUserResponse(r)));
    res.json(formatted);
  } catch (error) {
    console.error('Pending organizers error:', error);
    res.status(500).json({ error: 'Internal server error fetching pending organizer queue' });
  }
});

// A2. Verify Organizer account
router.post('/api/admin/organizers/:id/approve', authenticateToken, requireCap('organizer.approve'), async (req, res) => {
  const orgId = req.params.id;

  try {
    /**
     * Scoped exactly like `deny` twenty lines below, which documents why.
     *
     * This was `UPDATE users SET verified = 1 WHERE id = ?` — no role filter, no
     * pending filter, no existence check, no transaction. Three consequences:
     *
     *   1. Any user id could be marked `verified`. That flag gates event creation
     *      and drives the "Approved by school staff" badge on a profile, so a
     *      student pre-approved this way became a trusted organizer the moment
     *      their role changed — with no record of anybody deciding that.
     *   2. A mistyped or stale id still returned `{ success: true }`, still wrote
     *      an `APPROVE_ORGANIZER` audit row, and still dispatched an approval
     *      notification. The trail recorded an approval that never happened,
     *      which is worse than no trail: it is a false one.
     *   3. The write and its audit row were not atomic, so a failing
     *      `recordAudit` left an approved organizer nobody was recorded as
     *      approving.
     *
     * Already-approved is a 404 rather than a silent success, matching `deny`:
     * "there is no pending request here" is the true answer to both.
     */
    const target = await db.prepare(
      "SELECT id FROM users WHERE id = ? AND role = 'organizer' AND verified = 0"
    ).get(orgId);

    if (!target) {
      return res.status(404).json({
        error: 'No pending organizer request matches that id.',
      });
    }

    await runInTransaction(db, async (tx) => {
      await tx.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(target.id);

      await recordAudit(tx, {
        adminId: req.user.id,
        action: 'APPROVE_ORGANIZER',
        targetUserId: target.id,
        details: 'Approved pending organizer account'
      });
    });

    /* After the commit, deliberately. A notification sent from inside the
       transaction would go out even if the approval rolled back. */
    await notificationService.dispatch('ORGANIZER_APPROVED', {}, target.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Verify organizer error:', error);
    res.status(500).json({ error: 'Internal server error verifying account' });
  }
});

// A3. Deny Organizer account
router.post('/api/admin/organizers/:id/deny', authenticateToken, requireCap('organizer.approve'), async (req, res) => {
  const orgId = req.params.id;

  try {
    // Scoped deliberately. An unscoped delete by id lets a mistyped or guessed
    // id remove a student — and ON DELETE CASCADE takes their attendance rows
    // with them, silently destroying credited service hours. Denial only ever
    // applies to an organizer who has not been approved yet, and who therefore
    // has no events and no volunteers attached.
    // `profile_picture_url` is read here because the row is about to be hard
    // deleted, and the file it names lives on disk outside the database. Once
    // the row is gone there is no pointer left to ever find that file again.
    const target = await db.prepare(
      "SELECT id, profile_picture_url FROM users WHERE id = ? AND role = 'organizer' AND verified = 0"
    ).get(orgId);

    if (!target) {
      return res.status(404).json({
        error: 'No pending organizer request matches that id. Approved organizers cannot be deleted here.'
      });
    }

    await runInTransaction(db, async (tx) => {
      /**
       * Consent rows go with the denied registration, and only here.
       *
       * `legal_acceptances.user_id` is ON DELETE RESTRICT, deliberately: an
       * acceptance record must survive the account, because it is the evidence
       * that the person agreed and it would be needed precisely if they later
       * said they had not. Account deletion is anonymisation — an UPDATE — so
       * that constraint never fires there.
       *
       * This route is the product's one genuine hard delete, and it is a
       * different situation: a pending organizer who is denied never became a
       * user. There is no relationship to evidence, no service record, and
       * nothing they could later dispute — so retaining consent rows about a
       * refused registration would be keeping data on someone we declined,
       * which is the wrong side of the trade.
       *
       * Explicit and scoped to this id rather than relaxing the constraint to
       * CASCADE: RESTRICT is what stops a future hard-delete path silently
       * destroying real users' consent evidence, and that guard is worth more
       * than the two lines it costs here.
       */
      await tx.prepare('DELETE FROM legal_acceptances WHERE user_id = ?').run(orgId);
      await tx.prepare("DELETE FROM users WHERE id = ? AND role = 'organizer' AND verified = 0").run(orgId);

      // Log the audit event
      await recordAudit(tx, {
        adminId: req.user.id,
        action: 'DENY_ORGANIZER',
        targetUserId: orgId,
        details: 'Denied and deleted pending organizer account request'
      });
    });

    /**
     * The photograph goes with the row.
     *
     * A pending organizer can sign in and upload a profile picture —
     * `authenticateToken` gates on `email_verified`, not on `users.verified` —
     * so denial can be destroying an account that has one. The upload is served
     * unauthenticated from `public/uploads/`, so leaving it behind means a
     * picture of a real person stays retrievable at a URL that was already
     * handed out, with the row that pointed at it gone and no way left to find
     * it. Deleting an account we declined has to include what they gave us.
     *
     * After the transaction, matching account deletion in accountRoutes.js: the
     * only tolerable mismatch is a committed delete with a file still on disk,
     * never a live row whose picture has already been destroyed.
     * `deleteUploadedFile` refuses any path resolving outside `public/uploads/`
     * and never throws, so a missing file cannot turn a completed denial into a
     * 500.
     */
    deleteUploadedFile(target.profile_picture_url);

    res.json({ success: true });
  } catch (error) {
    console.error('Deny organizer error:', error);
    res.status(500).json({ error: 'Internal server error denying registration request' });
  }
});

// A4. Remove Event Listing

router.get('/api/admin/stats', authenticateToken, requireCap('analytics.school'), async (req, res) => {
  try {
    /**
     * Deleted accounts are excluded from the role counts, and only from those.
     *
     * A tombstone keeps its `role`, so `role = 'student'` also counts every
     * deleted student and the reserved `system-cli` actor. That inflates the
     * headcount — and because `participationRate` divides real volunteers by
     * `totals.students`, an inflated denominator silently UNDERSTATES
     * participation, which is the figure this page exists to report.
     *
     * `users` is left as a raw count of rows on purpose: it is the size of the
     * table, not a population, and the two tombstone rows belong in it.
     */
    /* Each row is parenthesised before its column is read: `await q.get().c`
       would take `.c` off the pending promise and report every total as
       `undefined`, which the dashboard would render as a blank rather than an
       error. */
    const totals = {
      users: (await db.prepare('SELECT COUNT(*) as c FROM users').get()).c,
      students: (await db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'student' AND account_status <> 'deleted'").get()).c,
      organizers: (await db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'organizer' AND account_status <> 'deleted'").get()).c,
      events: (await db.prepare('SELECT COUNT(*) as c FROM events').get()).c,
      applications: (await db.prepare('SELECT COUNT(*) as c FROM applications').get()).c,
      hours: (await db.prepare('SELECT COALESCE(SUM(hours_awarded),0) as h FROM attendance WHERE present = 1').get()).h,
      pendingOrganizers: (await db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'organizer' AND verified = 0").get()).c
    };

    // ── Rates that tell staff whether the programme is healthy ──
    const attendance = await db.prepare(`
      SELECT COUNT(*) as total, SUM(CASE WHEN present = 1 THEN 1 ELSE 0 END) as present
      FROM attendance
    `).get();
    const attendanceRate = attendance.total > 0
      ? Math.round((attendance.present / attendance.total) * 100) : null;

    const eventStatus = (await db.prepare(`
      SELECT status, COUNT(*) as c FROM events GROUP BY status
    `).all()).reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});
    const finishedEvents = (eventStatus.completed || 0) + (eventStatus.cancelled || 0);
    const completionRate = finishedEvents > 0
      ? Math.round(((eventStatus.completed || 0) / finishedEvents) * 100) : null;

    // How many students actually volunteered vs merely registered
    const activeVolunteers = (await db.prepare(`
      SELECT COUNT(DISTINCT user_id) as c FROM attendance WHERE present = 1
    `).get()).c;
    const participationRate = totals.students > 0
      ? Math.round((activeVolunteers / totals.students) * 100) : null;

    /**
     * The six-month floor is computed in JS and BOUND, not `date('now', …)`.
     *
     * PostgreSQL has no two-argument `date()` and refused both queries outright
     * — "function date(unknown, unknown) does not exist" — so the whole admin
     * stats endpoint answered 500 there. It is also the more correct form: the
     * columns hold ISO-8601 UTC, and a bound ISO string compares against them
     * exactly, where SQLite's `date()` returns `YYYY-MM-DD` and relies on the
     * prefix comparing usefully.
     */
    const sixMonthsAgo = new Date(Date.now() - 182 * 24 * 3600 * 1000).toISOString();

    // Hours per month, last 6 months
    const monthlyHours = await db.prepare(`
      SELECT substr(s.end_datetime, 1, 7) as month,
             COALESCE(SUM(at.hours_awarded), 0) as hours,
             COUNT(DISTINCT at.user_id) as volunteers
      FROM attendance at
      JOIN slots s ON at.slot_id = s.id
      WHERE at.present = 1 AND s.end_datetime >= ?
      GROUP BY month ORDER BY month ASC
    `).all(sixMonthsAgo);

    // Volunteers joining over time
    const signupsByMonth = await db.prepare(`
      SELECT substr(created_at, 1, 7) as month, COUNT(*) as c
      FROM users
      WHERE role = 'student' AND account_status <> 'deleted'
        AND created_at >= ?
      GROUP BY month ORDER BY month ASC
    `).all(sixMonthsAgo);

    const topOrganizers = await db.prepare(`
      SELECT u.id, u.name, u.avatar, u.verified,
             COUNT(DISTINCT e.id) as events,
             COALESCE(SUM(at.hours_awarded), 0) as hours
      FROM users u
      JOIN events e ON e.organizer_id = u.id
      LEFT JOIN attendance at ON at.event_id = e.id AND at.present = 1
      WHERE u.role = 'organizer'
      GROUP BY u.id
      ORDER BY hours DESC, events DESC
      LIMIT 5
    `).all();

    const selectionSplit = (await db.prepare(`
      SELECT COALESCE(auto_approve, 0) as auto, COUNT(*) as c
      FROM events GROUP BY auto
    `).all()).reduce((acc, r) => ({ ...acc, [r.auto === 1 ? 'autoSelect' : 'manual']: r.c }), {});

    res.json({
      ...totals,
      activeVolunteers,
      attendanceRate,
      completionRate,
      participationRate,
      eventStatus,
      monthlyHours: monthlyHours.map(m => ({
        month: m.month, hours: Number(m.hours), volunteers: m.volunteers
      })),
      signupsByMonth: signupsByMonth.map(m => ({ month: m.month, count: m.c })),
      topOrganizers: topOrganizers.map(o => ({
        id: o.id, name: o.name, avatar: o.avatar, verified: o.verified === 1,
        events: o.events, hours: Number(o.hours)
      })),
      selectionSplit: { manual: selectionSplit.manual || 0, autoSelect: selectionSplit.autoSelect || 0 }
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Failed to fetch admin stats' });
  }
});

// A26. Fetch Auto Select Runs (Organizer & Admin only)

/**
 * The live row behind a report, for every target type there is.
 *
 * The version this replaces looked the target up in `events` for an event and in
 * `event_comments` for *everything else*. Five of the seven target types
 * therefore found nothing, had no `target_body_snapshot` either — a conversation
 * report snapshots its bodies into `report_evidence`, not onto the report row —
 * and were flagged as missing, so the queue told the moderator
 * "No copy of this was kept" about reports holding hundreds of preserved
 * messages. That sentence was false about the report type this whole release
 * exists to make visible.
 *
 * Returns `null` when the target genuinely no longer exists, which is a real and
 * expected state: the point of the snapshots is that a report outlives the thing
 * it is about.
 */
/**
 * What the moderator sees for the target, in three honestly-distinguished
 * states. A decision can turn on which one they are reading, so the queue says
 * which it is rather than rendering all three the same way.
 *
 *   live      — the content still exists and this is it
 *   snapshot  — the original is gone; this is the copy taken when the report was
 *               filed, which is why the copy is taken
 *   missing   — genuinely nothing was preserved (pre-snapshot reports only)
 *
 * `target_name_snapshot` is what identifies a target with no body of its own: a
 * conversation, a person, a certificate. Without it those reports render as an
 * unlabelled row, which is the same blank cell a moderator reads as "nothing
 * wrong here".
 *
 * ── Why this is a function rather than a loop inside the queue handler ──
 *
 * The report detail route answers with the same report the queue lists, and a
 * second derivation of these four fields is a second set of rules for what
 * "missing" means. The failure that produces is specific and has already
 * happened once on this surface: `target_missing` was true for every
 * conversation report, so the queue told the moderator no copy was kept about
 * reports holding hundreds of preserved messages. Two copies of that logic means
 * fixing it in one place and leaving the other one lying.
 */
async function describeTarget(report) {
  const live = await liveTarget(db, report);
  const body = live?.text ?? report.target_body_snapshot ?? null;

  report.target_label = report.target_name_snapshot
    ?? (report.target_type === 'certificate' ? `Certificate ${report.target_id}` : null);
  report.target_title = body;
  report.target_is_snapshot = !live && report.target_body_snapshot != null;
  /**
   * Only ever true when there is genuinely nothing to show. A report with
   * preserved evidence is never "missing", whatever happened to the live row —
   * the evidence IS the record, and saying otherwise talks a moderator out of
   * opening it.
   */
  report.target_missing = !live
    && report.target_body_snapshot == null
    && report.target_name_snapshot == null
    && report.evidence_count === 0;
  report.target_exists = Boolean(live);
  return report;
}

async function liveTarget(db, report) {
  const one = async (sql) => await db.prepare(sql).get(report.target_id) ?? null;
  switch (report.target_type) {
    case 'event':
      return one('SELECT title AS text FROM events WHERE id = ?');
    case 'comment':
      return one('SELECT body AS text FROM event_comments WHERE id = ?');
    case 'announcement':
      return one('SELECT body AS text FROM event_announcements WHERE id = ?');
    case 'message':
      return one('SELECT body AS text FROM messages WHERE id = ?');
    case 'conversation':
      // A conversation has no body of its own; its content is the evidence rows.
      return one("SELECT 'Conversation' AS text FROM conversations WHERE id = ?");
    case 'user':
      return one('SELECT name AS text FROM users WHERE id = ?');
    case 'certificate':
      // Deliberately never looked up: the code is a bearer credential and the
      // report endpoint refuses to be an oracle for it, so the queue does not
      // become one either. The snapshot is the whole record.
      return null;
    default:
      return null;
  }
}

/**
 * Statuses a moderator may ask for, and what they get if they ask for nothing.
 *
 * The default is the live band, because that is the work. Closed reports are
 * reachable — `?status=resolved,dismissed`, or `all` — because a moderator has to
 * be able to find a decision they made last month, and a queue that can only show
 * open work makes the archive unreadable.
 */
const QUEUE_DEFAULT_STATUSES = LIVE_REPORT_STATUSES;

// A3. Get All Reports
router.get('/api/admin/reports', authenticateToken, requireCap('report.resolve'), async (req, res) => {
  try {
    /* ── Filters ──────────────────────────────────────────────────────────────
     *
     * Every filter is validated against a closed set and refused with a 400
     * naming the legal values, rather than silently dropped. A mistyped
     * `?status=reviewed` that quietly returns everything, or quietly returns
     * nothing, is a moderator looking at a queue that is not the queue they asked
     * for — and on this surface "I saw no open reports" is the wrong thing to be
     * wrong about.
     */
    const parseCsv = (raw) => String(raw).split(',').map(s => s.trim()).filter(Boolean);

    let statuses = QUEUE_DEFAULT_STATUSES;
    if (req.query.status !== undefined) {
      if (String(req.query.status) === 'all') {
        statuses = REPORT_STATUSES;
      } else {
        statuses = parseCsv(req.query.status);
        const unknown = statuses.filter(s => !REPORT_STATUSES.includes(s));
        if (statuses.length === 0 || unknown.length > 0) {
          return res.status(400).json({
            error: `Unknown status ${unknown.join(', ') || '(none given)'}`,
            code: 'invalid_status_filter', allowed: [...REPORT_STATUSES, 'all'],
          });
        }
      }
    }

    const where = [`r.status IN (${statuses.map(() => '?').join(', ')})`];
    const params = [...statuses];

    if (req.query.priority !== undefined) {
      if (!REPORT_PRIORITIES.includes(String(req.query.priority))) {
        return res.status(400).json({
          error: 'Unknown priority', code: 'invalid_priority_filter', allowed: REPORT_PRIORITIES,
        });
      }
      where.push('r.priority = ?');
      params.push(String(req.query.priority));
    }

    if (req.query.category !== undefined) {
      if (!isValidCategory(String(req.query.category))) {
        return res.status(400).json({
          error: 'Unknown category', code: 'invalid_category_filter', allowed: CATEGORY_VALUES,
        });
      }
      where.push('r.category = ?');
      params.push(String(req.query.category));
    }

    if (req.query.targetType !== undefined) {
      // `organizer` is an alias the client may still speak; it is stored as `user`.
      const targetType = normalizeTargetType(String(req.query.targetType));
      if (!targetType) {
        return res.status(400).json({
          error: 'Unknown target type', code: 'invalid_target_type_filter',
          allowed: REPORT_TARGET_TYPES,
        });
      }
      where.push('r.target_type = ?');
      params.push(targetType);
    }

    if (req.query.assignee !== undefined) {
      const assignee = String(req.query.assignee);
      if (assignee === 'unassigned') {
        where.push('r.assigned_to IS NULL');
      } else {
        where.push('r.assigned_to = ?');
        params.push(assignee === 'me' ? req.user.id : assignee);
      }
    }

    /**
     * LEFT JOIN, not JOIN, and this is load-bearing.
     *
     * `reports.reporter_id` became nullable in migration 011 — it was ON DELETE
     * CASCADE, which meant the retention sweep purging a reporter's anonymised
     * shell destroyed their safety report. With the cascade severed to SET NULL,
     * an inner join would make those reports vanish from this queue instead:
     * the quietest possible failure, and the one a moderator cannot notice,
     * because nothing renders to tell them anything is missing. The same applies
     * to the assignee and resolver joins below.
     *
     * `reporter_name_snapshot` is taken at report time and is what the queue
     * falls back to. The final literal covers reports filed before the snapshot
     * column existed.
     *
     * ── Ordering ──
     *
     * Urgent before normal, then oldest first. Oldest first is the opposite of
     * what a feed does, and deliberately: newest-first starves the oldest
     * unanswered report, which is by construction the one most likely to be a
     * real harm nobody answered — and "reaches a human within one business day"
     * is a promise about the oldest item, not the newest. Live statuses sort
     * above closed ones so that working the queue never means scrolling past
     * finished work; `reviewing` and `escalated` are live and used to sort BELOW
     * resolved reports, so picking a report up pushed it out of sight.
     */
    const liveList = LIVE_REPORT_STATUSES.map(() => '?').join(', ');
    const reports = await db.prepare(`
      SELECT r.*,
             COALESCE(u.name, r.reporter_name_snapshot, 'Account since deleted') AS reporter_name,
             u.email AS reporter_email,
             a.name AS assigned_to_name,
             rb.name AS resolved_by_name,
             (SELECT COUNT(*) FROM report_evidence WHERE report_id = r.id) AS evidence_count
        FROM reports r
        LEFT JOIN users u  ON u.id  = r.reporter_id
        LEFT JOIN users a  ON a.id  = r.assigned_to
        LEFT JOIN users rb ON rb.id = r.resolved_by
       WHERE ${where.join(' AND ')}
       ORDER BY
         CASE WHEN r.status IN (${liveList}) THEN 0 ELSE 1 END,
         CASE WHEN r.priority = 'urgent' THEN 0 ELSE 1 END,
         r.created_at ASC
    `).all(...params, ...LIVE_REPORT_STATUSES);

    for (const report of reports) await describeTarget(report);

    /**
     * The counts are the whole dashboard for a one-person team: how much is
     * waiting, how much of it is urgent, and how much is mine. Computed over the
     * whole table rather than the filtered page, because their job is to tell a
     * moderator what a filter is currently hiding from them.
     */
    const counts = await db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END)                          AS open,
        SUM(CASE WHEN status = 'reviewing' THEN 1 ELSE 0 END)                     AS reviewing,
        SUM(CASE WHEN status = 'escalated' THEN 1 ELSE 0 END)                     AS escalated,
        SUM(CASE WHEN status IN (${liveList}) AND priority = 'urgent' THEN 1 ELSE 0 END) AS "urgentLive",
        SUM(CASE WHEN status IN (${liveList}) AND assigned_to = ? THEN 1 ELSE 0 END)     AS "assignedToMe"
      FROM reports
    `).get(...LIVE_REPORT_STATUSES, ...LIVE_REPORT_STATUSES, req.user.id);

    /**
     * An array, still, because that is what the shipped dashboard reads and a
     * response shape change is not something to bundle with a table rebuild. The
     * counts ride alongside as a header so a client that wants them can have them
     * without either side guessing.
     */
    res.set('X-Report-Counts', JSON.stringify({
      open: counts.open ?? 0,
      reviewing: counts.reviewing ?? 0,
      escalated: counts.escalated ?? 0,
      urgentLive: counts.urgentLive ?? 0,
      assignedToMe: counts.assignedToMe ?? 0,
    }));
    res.json(reports);
  } catch (err) {
    console.error('Fetch reports error:', err);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

/**
 * Which status a report may move to from where.
 *
 * Written down rather than left to "any value in the enum", because two of the
 * transitions a permissive route allows are ones a moderation record must not
 * contain. Resolving an already-resolved report overwrites the first decision's
 * resolution, note, actor and timestamp with a second one and leaves no sign the
 * first existed — the append-only history is what makes that recoverable, but a
 * decision that quietly replaces another is not a thing the route should let
 * happen in the first place. And `resolved -> dismissed` skips the reopen, so a
 * report changes outcome without ever having been open for reconsideration.
 *
 * Reopening IS allowed, from either terminal state, because a moderator who
 * learns something new must be able to act on it. It is a real decision with its
 * own history row, and it clears the previous resolution rather than leaving a
 * report that reads as open and resolved at the same time.
 */
const REPORT_TRANSITIONS = Object.freeze({
  open: ['reviewing', 'escalated', 'resolved', 'dismissed'],
  reviewing: ['open', 'escalated', 'resolved', 'dismissed'],
  escalated: ['open', 'reviewing', 'resolved', 'dismissed'],
  resolved: ['open', 'reviewing'],
  dismissed: ['open', 'reviewing'],
});

const CLOSING_STATUSES = ['resolved', 'dismissed'];
const REOPENING_STATUSES = ['open', 'reviewing'];

/**
 * Same threshold as `MIN_SUSPENSION_REASON`, and for the same reason: the note
 * is what an appeal is reviewed against, and "ok" is not something a decision can
 * be reviewed against a year later.
 */
const MIN_RESOLUTION_NOTE = 20;

/**
 * Is this moderator a party to the report they are trying to act on?
 *
 * Three ways to be involved, and the third is easy to miss: a report whose
 * `target_type` is `user` names its subject in `target_id`, not in
 * `target_author_id`, so a check that reads only the author column misses every
 * report filed directly against a person — which is the shape a report about a
 * moderator almost always takes.
 */
function isPartyToReport(report, userId) {
  return report.reporter_id === userId
    || report.target_author_id === userId
    || (report.target_type === 'user' && report.target_id === userId);
}

/**
 * Who a report is about, for the audit row.
 *
 * `target_user_id` on `admin_audit_logs` is a foreign key to `users`, so it can
 * only ever be a person: an event or a certificate has no row to point at. The
 * reported party is preferred over the reporter because "whose case was this"
 * is the question the trail has to answer later.
 */
function auditSubject(report) {
  if (report.target_type === 'user') return report.target_id ?? report.reporter_id ?? null;
  return report.target_author_id ?? report.reporter_id ?? null;
}

// A4. Update Report Status
router.patch('/api/admin/reports/:id', authenticateToken, requireCap('report.resolve'), async (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { status, priority, assignedTo, resolution, resolutionNote } = body;

  /* ── Shape, before anything is read or written ────────────────────────────
   *
   * Every one of these was reachable as a 500 before: an unknown `resolution`
   * reached the table's CHECK constraint, a non-string `resolutionNote` reached
   * `node:sqlite`'s parameter binding, and an `assignedTo` naming nobody reached
   * the foreign key. A malformed request is the client's mistake and must be
   * answered as one — the same rule `routes.malformed.test.js` exists to hold.
   */
  if (status !== undefined && !REPORT_STATUSES.includes(status)) {
    return res.status(400).json({
      error: 'Invalid status', code: 'invalid_status', allowed: REPORT_STATUSES,
    });
  }
  if (priority !== undefined && !REPORT_PRIORITIES.includes(priority)) {
    return res.status(400).json({
      error: 'Invalid priority', code: 'invalid_priority', allowed: REPORT_PRIORITIES,
    });
  }
  if (resolution !== undefined && resolution !== null && !REPORT_RESOLUTIONS.includes(resolution)) {
    return res.status(400).json({
      error: 'Invalid resolution', code: 'invalid_resolution', allowed: REPORT_RESOLUTIONS,
    });
  }
  /**
   * `assignedTo` is `null` (unassign), `'me'`, or a user id. A non-string
   * anything else is refused here rather than bound into the UPDATE.
   */
  if (assignedTo !== undefined && assignedTo !== null && typeof assignedTo !== 'string') {
    return res.status(400).json({ error: 'Invalid assignee', code: 'invalid_assignee' });
  }

  const closing = CLOSING_STATUSES.includes(status);
  if (closing) {
    if (!resolution) {
      return res.status(400).json({
        error: 'Choose what was done about this report.',
        code: 'resolution_required', allowed: REPORT_RESOLUTIONS,
      });
    }
    /**
     * `typeof` first, and this is the bug that made the rule optional.
     *
     * The check used to be `!resolutionNote || resolutionNote.length < 20`. A
     * number has no `.length`, so `undefined < 20` is false and the guard passed:
     * `resolutionNote: 1` closed a report with a note of "1.0". The one field an
     * appeal is reviewed against could be filled with a single digit by any
     * client sending JSON rather than a form.
     */
    if (typeof resolutionNote !== 'string' || resolutionNote.trim().length < MIN_RESOLUTION_NOTE) {
      return res.status(400).json({
        error: `Say what was decided and why, in at least ${MIN_RESOLUTION_NOTE} characters. `
          + 'This is what an appeal is reviewed against.',
        code: 'resolution_note_required',
      });
    }
  }

  try {
    const report = await db.prepare(`
      SELECT id, reporter_id, target_author_id, target_type, target_id, status, priority, assigned_to,
             -- Read so a reopen can carry the withdrawn decision's reasoning
             -- onto the history row before clearing it here. Without it the
             -- capture below reads undefined and the note is lost as before.
             resolution_note
        FROM reports WHERE id = ?
    `).get(req.params.id);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    /* ── Conflict of interest ─────────────────────────────────────────────────
     *
     * A moderator resolving a report about themselves is the one self-dealing
     * move this surface makes available, and it is available to every account
     * holding `report.resolve`. Reading is deliberately still allowed: a
     * moderator has to be able to see what was said about them. It is deciding
     * it — resolving, dismissing, reprioritising, or quietly assigning it to
     * themselves — that they may not do.
     *
     * ── Why there is an escalation path, and why it does not end in a deadlock ──
     *
     * The Trust & Safety specification stops at "escalates to a principal holding
     * `admin.create`, and when the super_admin is themselves the subject there is
     * no on-platform path". That is defensible on a platform with a moderation
     * department. This one is sized for one to two people, and the failure it
     * produces is concrete: a report naming the only administrator can never
     * leave `open`, so it holds a delete hold on that person's events and a
     * retention hold on every account party to it, for ever, with no route short
     * of someone editing the database by hand. A safety mechanism that cannot be
     * discharged stops being a safety mechanism and becomes a lock.
     *
     * So the most privileged principal may act on a report about themselves, and
     * the price is that it is recorded as exactly that: a `self_review` row in
     * the append-only history and a distinct audit action, both naming them. The
     * mitigation for a self-review is that everyone can see it was one — which is
     * the same trade the Community Guidelines already publishes when it declines
     * to promise an independent reviewer. An unreviewable report helps nobody;
     * a visibly self-reviewed one at least leaves the district something to ask
     * about.
     *
     * Ordered most-privileged-first and ending in an explicit deny, per
     * `server/authz.js`: `can()` answers true for every capability a super_admin
     * asks about, so a chain of `else if (can(...))` is NOT mutually exclusive
     * and a bare `else` would be reached by nobody.
     */
    const involved = isPartyToReport(report, req.user.id);
    const wantsToAct = status !== undefined || priority !== undefined
      || resolution !== undefined || assignedTo !== undefined;
    let selfReview = false;

    if (involved && wantsToAct) {
      if (can(req.principal, 'admin.create')) {
        selfReview = true;                                    // allowed, and recorded as such
      } else if (can(req.principal, 'report.resolve')) {
        return res.status(403).json({
          error: 'You are named in this report, so you cannot decide it. '
            + 'A super administrator can, and their decision is recorded as a self-review.',
          code: 'conflict_of_interest',
        });
      } else {
        return res.status(403).json({ error: 'Forbidden', code: 'conflict_of_interest' });
      }
    }

    /* ── Transition legality ──────────────────────────────────────────────── */
    const changingStatus = status !== undefined && status !== report.status;
    if (status !== undefined && !changingStatus && CLOSING_STATUSES.includes(status)) {
      // Re-resolving an already-resolved report replaces the first decision's
      // note, actor and timestamp with no sign the first existed.
      return res.status(409).json({
        error: `This report is already ${report.status}. Reopen it before deciding it again.`,
        code: 'already_closed',
      });
    }
    if (changingStatus && !REPORT_TRANSITIONS[report.status].includes(status)) {
      return res.status(409).json({
        error: `A ${report.status} report cannot move straight to ${status}.`,
        code: 'invalid_transition',
        allowed: REPORT_TRANSITIONS[report.status],
      });
    }

    /* ── Assignment ───────────────────────────────────────────────────────── */
    let nextAssignee;                       // undefined = leave alone
    if (assignedTo !== undefined) {
      if (assignedTo === null) {
        nextAssignee = null;
      } else {
        const candidateId = assignedTo === 'me' ? req.user.id : assignedTo;
        const candidate = await db.prepare(
          "SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL AND account_status = 'active'"
        ).get(candidateId);
        if (!candidate) {
          return res.status(400).json({ error: 'That moderator does not exist.', code: 'unknown_assignee' });
        }
        /**
         * Asked as a capability, never as a role comparison — Guard 1 fails the
         * build on the latter, and the point stands on its own: `report.resolve`
         * is grantable per-user precisely so a triage-only helper can exist, and
         * a role check would refuse to assign work to exactly that person.
         */
        const candidatePrincipal = principalFor(candidate, { grants: await grantsFor(db, candidate.id) });
        if (!can(candidatePrincipal, 'report.resolve')) {
          return res.status(400).json({
            error: 'That person cannot work reports, so nothing would reach them.',
            code: 'assignee_cannot_moderate',
          });
        }
        // Assigning a report to yourself when you are named in it is the quiet
        // version of deciding it, and is refused above by the same rule.
        nextAssignee = candidate.id;
      }
    }

    const now = new Date().toISOString();
    const reopening = changingStatus
      && REOPENING_STATUSES.includes(status)
      && CLOSING_STATUSES.includes(report.status);

    /* ── One transaction ──────────────────────────────────────────────────────
     *
     * The row, its history and its audit row move together or not at all. They
     * did not before: the UPDATE ran first and on its own, so a failure in the
     * history write left a report whose status had changed with nothing
     * recording who changed it — which is the one state the append-only trail
     * exists to make impossible.
     */
    const changes = [];
    await runInTransaction(db, async (tx) => {
      const sets = ['updated_at = ?'];
      const params = [now];

      if (changingStatus) {
        sets.push('status = ?'); params.push(status);
        changes.push({ action: 'status_changed', from: report.status, to: status });
      }
      if (priority !== undefined && priority !== report.priority) {
        sets.push('priority = ?'); params.push(priority);
        changes.push({ action: 'prioritised', fromPriority: report.priority, toPriority: priority });
      }
      if (nextAssignee !== undefined && nextAssignee !== report.assigned_to) {
        sets.push('assigned_to = ?', 'assigned_at = ?');
        params.push(nextAssignee, nextAssignee === null ? null : now);
        changes.push({ action: nextAssignee === null ? 'unassigned' : 'assigned' });
      }

      if (closing) {
        sets.push('resolution = ?', 'resolution_note = ?', 'resolved_by = ?', 'resolved_at = ?');
        params.push(resolution, resolutionNote.trim(), req.user.id, now);
        changes.push({ action: 'resolved', toResolution: resolution });
      }

      /**
       * Reopening clears the decision it reverses — and carries its words across.
       *
       * Left in place, a reopened report reads as open AND resolved by a named
       * person at a named time, and the next moderator to pick it up acts on a
       * decision that has been withdrawn.
       *
       * This comment used to say the withdrawn decision was not lost because it
       * lived in `moderation_actions`. That was false: the table records the
       * resolution ENUM (`warning_issued`, `no_action`) and had no column for
       * text, so `resolution_note` — the moderator's account of what they decided
       * and why — was destroyed. `ResolutionModal.jsx` tells the moderator
       * writing it that it is "kept permanently and… what an appeal is reviewed
       * against", so a student appealing a reopened decision was appealing
       * against nothing, with the interface still promising otherwise.
       *
       * Migration 028 added the column. The note is captured here and written
       * onto the `reopened` history row below, which is the row that withdrew it
       * and is retention-exempt.
       */
      if (reopening) {
        sets.push('resolution = NULL', 'resolution_note = NULL', 'resolved_by = NULL', 'resolved_at = NULL');
        changes.push({
          action: 'reopened',
          note: report.resolution_note ?? null,
        });
      }

      if (changes.length === 0) return;      // nothing asked for; nothing recorded

      params.push(report.id);
      await tx.prepare(`UPDATE reports SET ${sets.join(', ')} WHERE id = ?`).run(...params);

      /**
       * One history row per field changed, not one blob.
       *
       * Assigning, reprioritising and resolving are three decisions and read as
       * three lines a year later. `actor_id` is always populated here — an
       * anonymous history row says somebody changed this without saying who,
       * which is the single question this table exists to answer.
       */
      const insertAction = await tx.prepare(`
        INSERT INTO moderation_actions
          (id, report_id, actor_id, action, old_status, new_status,
           old_priority, new_priority, old_resolution, new_resolution, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of changes) {
        await insertAction.run(
          `act_${crypto.randomUUID()}`, report.id, req.user.id, c.action,
          c.from ?? null, c.to ?? null,
          c.fromPriority ?? null, c.toPriority ?? null,
          /* `note` carries the WITHDRAWN resolution note on a `reopened` row, so
             the reasoning a later appeal is reviewed against survives the reopen
             that cleared it from the report. Null on every other action. */
          null, c.toResolution ?? null, c.note ?? null, now,
        );
      }
      if (selfReview) {
        await insertAction.run(
          `act_${crypto.randomUUID()}`, report.id, req.user.id, 'self_review',
          /* Twelve values now that `note` exists — this second call site shares the
             prepared statement and was still passing eleven, so `created_at`
             received the note's NULL and the insert failed its NOT NULL. */
          null, null, null, null, null, null, null, now,
        );
      }

      /**
       * The administrative trail, alongside the report-scoped one.
       *
       * Deliberately structural only: which report, what changed, and — when it
       * happened — that the actor was named in it. The resolution note is NOT
       * copied here. It is moderator-authored text about a student's report and
       * frequently quotes it, `admin_audit_logs` is read for operational
       * questions rather than case ones, and the note already lives in two
       * places that are retained longer than this table is.
       */
      await recordAudit(tx, {
        adminId: req.user.id,
        action: selfReview ? 'MODERATE_REPORT_SELF_REVIEW' : 'MODERATE_REPORT',
        targetUserId: auditSubject(report),
        details: `Report ${report.id} (${report.target_type}): `
          + changes.map(c => c.action).join(', ')
          + (changingStatus ? ` [${report.status} -> ${status}]` : '')
          + (closing ? ` resolution=${resolution}` : '')
          + (selfReview ? ' — SELF-REVIEW: the actor is named in this report' : ''),
      });
    });

    res.json({
      success: true,
      message: changes.length === 0 ? 'Nothing to change' : 'Report updated',
      changed: changes.map(c => c.action),
      selfReview,
    });
  } catch (err) {
    console.error('Update report error:', err);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

/**
 * The CSV export is declared ABOVE `/:id`, and the order is load-bearing.
 *
 * Express matches in declaration order, so a `/:id` pattern declared first
 * captures the literal path `/export` with `id = "export"`, and the export answers
 * 404 "Report not found" instead of a CSV — with both routes looking perfectly
 * correct in isolation. `routes.admin.test.js` caught exactly that when `/:id` was
 * first added below it; keeping literal paths ahead of parameterised ones is what
 * stops it recurring.
 */
// A5. Export Data to CSV
/**
 * The student roster, as CSV.
 *
 * Gated on `roster.export` rather than `report.resolve` — see the note on that
 * capability in `server/authz.js`. It returns every active student's name,
 * email, school, join date and credited hours, and the capability that used to
 * open it meant "resolve the safety reports people file".
 */
router.get('/api/admin/reports/export', authenticateToken, requireCap('roster.export'), async (req, res) => {
  try {
    const students = await db.prepare(`
      SELECT 
        u.id, 
        u.name, 
        u.email, 
        u.school, 
        u.created_at,
        COALESCE(SUM(at.hours_awarded), 0) as total_hours
      FROM users u
      LEFT JOIN attendance at ON at.user_id = u.id AND at.present = 1
      -- Deleted accounts keep their row and their role, so the role predicate
      -- alone also matches every tombstone and the reserved system-cli actor.
      -- Without this the export ships anonymised deleted_user-... rows to
      -- whoever asked for a list of volunteers.
      WHERE u.role = 'student' AND u.account_status <> 'deleted'
      GROUP BY u.id
      ORDER BY u.name ASC
    `).all();

    // Create CSV content
    /**
     * No internal `id` column.
     *
     * It was the first field, and it is the one column that is useless outside
     * this system and useful inside a leaked file: a stable identifier is what
     * lets two copies of an export, or an export and some other extract, be
     * correlated into a longer record about a named child. A school reconciling
     * against its own roster joins on name, school and email; nothing it does
     * needs `user-diana`.
     */
    const headers = ['Name', 'Email', 'School/Affiliation', 'Joined Date', 'Total Credited Hours'];
    const rows = students.map(s => [
      csvCell(s.name),
      csvCell(s.email),
      csvCell(s.school),
      s.created_at,
      s.total_hours
    ]);
    
    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

    /**
     * Audited, because a bulk PII egress that leaves no trace is the one thing
     * this endpoint must not be.
     *
     * Written BEFORE the response, and deliberately not caught: `recordAudit`
     * never swallows, so an audit row that cannot be written takes the export
     * down with it. Exported-but-not-recorded is the failure this prevents, and
     * it is the same ordering `BADGE_AWARDED` uses for the same reason.
     *
     * No `targetUserId`: the subject is every student at once, which is
     * precisely what makes the row worth having. The count is the part an
     * incident review needs.
     */
    await recordAudit(db, {
      adminId: req.user.id,
      action: 'ROSTER_EXPORTED',
      details: `Downloaded the student roster as CSV — ${rows.length} student${rows.length === 1 ? '' : 's'}, `
        + 'including name, email, school and credited hours.',
    });

    res.setHeader('Content-Type', 'text/csv');
    /**
     * Datestamped, so a copy found later can be dated.
     *
     * Every export used to arrive as `wevolunteer_students_export.csv`, so a
     * file in somebody's Downloads folder or attached to an old email carried
     * no indication of how stale it was — and two exports a year apart were
     * indistinguishable by name. The `ROSTER_EXPORTED` audit row is the
     * authoritative record; this is what lets a file be matched back to one.
     */
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition',
      `attachment; filename="wevolunteer_students_${stamp}.csv"`);
    res.send(csvContent);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Failed to generate CSV export' });
  }
});

/**
 * One report, with the trail of what has been done to it.
 *
 * ── Why this exists ──
 *
 * `moderation_actions` has been written on every decision since v1.2 and read
 * back by nothing. Status changes, reprioritisations, assignments, resolutions,
 * self-reviews and evidence reads were all recorded, and the only way to see any
 * of it was to open the database by hand. So the append-only trail that exists
 * to answer "who decided this, and why" answered it to nobody — and a moderator
 * picking a report up could not tell that it had already been decided once and
 * reopened, which is precisely the context that changes what they do next.
 *
 * ── Why the evidence bodies are NOT in this response ──
 *
 * This route is gated on `report.resolve`. The bodies are gated on
 * `report.evidence.read`, and `server/authz.js` splits those two capabilities
 * deliberately: the split is what lets a per-user grant create a triage-only
 * helper who sorts the queue and never reads a student's private messages, which
 * is the most invasive power on this platform. Folding the bodies in here would
 * collapse that split silently — the helper would receive them on every open,
 * while the separate capability still looked like it was doing something.
 *
 * So the two reads stay two requests. The cost is one extra round trip when a
 * moderator chooses to open the evidence; the benefit is that choosing to is a
 * distinct, logged act rather than a side effect of viewing a report.
 *
 * ── Why this read is not logged ──
 *
 * `GET /api/admin/reports` already returns every field this route does, to the
 * same capability. Logging one and not the other produces a trail that reads as
 * complete and is not. The read that is logged is the one that discloses message
 * bodies, because that is the act the Youth Safety Guidelines make a promise
 * about.
 */
router.get('/api/admin/reports/:id', authenticateToken, requireCap('report.resolve'), async (req, res) => {
  try {
    /**
     * Same columns and the same LEFT JOINs as the queue, for the same reason:
     * `reporter_id`, `assigned_to` and `resolved_by` are all nullable since the
     * retention sweep's cascades were severed, and an inner join would make a
     * report whose reporter has been purged disappear — the quietest possible
     * failure on a safety surface.
     */
    const report = await db.prepare(`
      SELECT r.*,
             COALESCE(u.name, r.reporter_name_snapshot, 'Account since deleted') AS reporter_name,
             u.email AS reporter_email,
             a.name AS assigned_to_name,
             rb.name AS resolved_by_name,
             (SELECT COUNT(*) FROM report_evidence WHERE report_id = r.id) AS evidence_count
        FROM reports r
        LEFT JOIN users u  ON u.id  = r.reporter_id
        LEFT JOIN users a  ON a.id  = r.assigned_to
        LEFT JOIN users rb ON rb.id = r.resolved_by
       WHERE r.id = ?
    `).get(req.params.id);

    if (!report) return res.status(404).json({ error: 'Report not found' });

    await describeTarget(report);

    /**
     * Who this report is ABOUT, resolved to a person or to nothing.
     *
     * The moderator's next action is frequently against a person — a warning, a
     * suspension — and the report row does not name one in a single place:
     * `target_type = 'user'` puts them in `target_id`, everything else puts the
     * author of the reported content in `target_author_id`. `auditSubject` already
     * encodes that rule for the audit trail; this is the same rule, resolved to a
     * name so the client does not have to re-derive it and get it wrong the way a
     * check reading only `target_author_id` would (it misses every report filed
     * directly against a person, which is the shape a report about an adult almost
     * always takes).
     *
     * Deliberately NOT falling back to the reporter, unlike `auditSubject`. That
     * fallback exists so an audit row always has a foreign key; here it would
     * offer a moderator a "warn this person" button pointed at the child who filed
     * the report.
     */
    const subjectId = report.target_type === 'user'
      ? report.target_id
      : report.target_author_id;

    const subject = subjectId
      ? await db.prepare(
        'SELECT id, name, role, account_status, suspended_until FROM users WHERE id = ? AND account_status != \'deleted\''
      ).get(subjectId)
      : null;

    report.subject = subject
      ? {
        id: subject.id,
        name: subject.name,
        role: subject.role,
        accountStatus: subject.account_status,
        suspendedUntil: subject.suspended_until ?? null,
      }
      : null;

    /**
     * Oldest first, so the timeline reads top-to-bottom in the order things
     * happened. `rowid` breaks ties because one PATCH writes several rows with
     * an identical `created_at` — status, priority and assignment change in one
     * transaction and share its timestamp — and without the tiebreak their order
     * is whatever the query planner felt like, which for a history is not a
     * detail.
     *
     * LEFT JOIN on the actor: `moderation_actions.actor_id` outlives the account
     * that acted, and an inner join would delete a moderator's decisions from the
     * record when they leave the school.
     */
    const history = await db.prepare(`
      SELECT ma.id, ma.action, ma.actor_id, ma.created_at,
             ma.old_status, ma.new_status,
             ma.old_priority, ma.new_priority,
             ma.old_resolution, ma.new_resolution,
             -- The withdrawn decision's reasoning, on the row that withdrew it.
             -- Without this the reviewer of an appeal against a reopened report
             -- has the fact of the reversal and none of the thinking behind it.
             ma.note,
             COALESCE(us.name, 'Account since deleted') AS actor_name
        FROM moderation_actions ma
        LEFT JOIN users us ON us.id = ma.actor_id
       WHERE ma.report_id = ?
       ORDER BY ma.created_at ASC, ${insertionTiebreak(db, 'ma')} ASC
    `).all(req.params.id);

    res.json({ report, history });
  } catch (err) {
    console.error('Fetch report detail error:', err);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

/**
 * Reading the private message bodies a safety report preserved.
 *
 * ── Step-up, added in the v1.2c privacy review ──
 *
 * `requireCap('report.evidence.read')` says this KIND of account may read
 * evidence. `requireAAL2('report.evidence')` says this person, at this moment,
 * has proved they are still themselves. The read was already logged twice — to
 * `admin_audit_logs` and to the retention-exempt `moderation_actions` — so the
 * accountability was in place; what was missing was the deliberation. An idle
 * click on "Show the messages" is now an act somebody has to mean.
 *
 * The grant binds `reportId`, so one verification opens one report. Without the
 * binding a moderator who verified once would hold a five-minute key to every
 * child's messages on the platform, which is worse than the position this
 * replaced.
 *
 * The gate is the early refusal, NOT the check: `spendChallenge` below is what
 * consumes it, as the first statement inside the same transaction as the two log
 * writes. A gate with no spend leaves the grant replayable and every functional
 * test still passes.
 */
router.get('/api/admin/reports/:id/evidence', authenticateToken, requireCap('report.evidence.read'), requireAAL2('report.evidence'), async (req, res) => {
  try {
    const report = await db.prepare(
      'SELECT id, reporter_id, target_author_id, target_type, target_id, status FROM reports WHERE id = ?'
    ).get(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    /**
     * A moderator named in the report cannot read its preserved messages.
     *
     * ── Why this is not covered by the PATCH route's check ──
     *
     * `PATCH /api/admin/reports/:id` refuses a conflicted moderator from ACTING,
     * and its comment says reading is deliberately still allowed because "a
     * moderator has to be able to see what was said about them". That reasoning
     * was written about the report's METADATA — who filed it, what category, what
     * status. This route discloses the preserved private message BODIES, which
     * `sensitiveActions.js` calls the most invasive read on the platform, usually
     * of a minor.
     *
     * So an administrator who is the subject of a safety report could step up and
     * read the private messages of the student who reported them. That is the
     * shape of retaliation this whole conflict rule exists to prevent, and the
     * step-up made it worse rather than better: it produced a clean audit trail
     * of an access that should never have been allowed.
     *
     * ── Same cascade as PATCH, most-privileged-first ──
     *
     * An owner is allowed through and the read is recorded as a self-review,
     * because on a one-to-two-person team refusing outright would mean a report
     * naming the owner can never be looked at by anyone. An ordinary
     * administrator is refused and told a super administrator can do it. Ends in
     * an explicit deny, never a bare else.
     */
    const involved = isPartyToReport(report, req.user.id);
    let selfReview = false;
    if (involved) {
      if (can(req.principal, 'admin.create')) {
        selfReview = true;
      } else if (can(req.principal, 'report.evidence.read')) {
        return res.status(403).json({
          error: 'You are named in this report, so you cannot read its preserved messages. '
            + 'A super administrator can, and their access is recorded as a self-review.',
          code: 'conflict_of_interest',
        });
      } else {
        return res.status(403).json({ error: 'Forbidden', code: 'conflict_of_interest' });
      }
    }

    /**
     * `captured_at` alongside `created_at`, because they are different facts and
     * the difference is the one a moderator needs. `created_at` is when the
     * message was sent; `captured_at` is when this report froze a copy of it. The
     * gap between them is what makes the words "preserved copy" mean something
     * rather than being a label the UI asserts — and it is the answer to "could
     * this have been edited after it was reported", which is no, because the row
     * carrying it has been immutable at the database since migration 013.
     */
    const messages = await db.prepare(`
      SELECT m.message_id, m.sender_id, m.body, m.created_at, m.captured_at,
             COALESCE(u.name, m.sender_name_snapshot, 'Account since deleted') AS sender_name
      FROM report_evidence m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.report_id = ?
      ORDER BY m.created_at ASC
    `).all(req.params.id);

    /**
     * The read is logged before the bodies leave the building, to BOTH trails,
     * and the second one is not redundant.
     *
     * Youth Safety Guidelines, in print: "This is the one situation in which an
     * administrator reads private messages, and it is logged." Until this route
     * existed the sentence described something that could not happen, so it was
     * not logged either.
     *
     * `admin_audit_logs` is swept at 365 days (`retentionWorker.js`). A
     * suspension is permanent and appealable years later, and "who read this
     * student's private messages" is exactly the question a parent or a district
     * asks long after the year is up — at which point the audit row is gone.
     * `moderation_actions` is report-scoped, append-only and exempt from the
     * sweep, so the durable answer lives there. Both, in one transaction: a read
     * that is recorded in one place and not the other is a record that disagrees
     * with itself.
     *
     * `target_user_id` on the audit row is the reported party rather than the
     * reporter, because the question this row answers later is whose private
     * messages were read.
     */
    await runInTransaction(db, async (tx) => {
      /**
       * First statement, and bound to the report actually being read — not to
       * whatever the client claimed. `report.id` comes from the row fetched
       * above, so a grant obtained for one report cannot open another.
       */
      await spendChallenge(tx, req, 'report.evidence', { reportId: report.id });

      await tx.prepare(`
        INSERT INTO moderation_actions (id, report_id, actor_id, action, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        `act_${crypto.randomUUID()}`, report.id, req.user.id,
        selfReview ? 'evidence_viewed_self_review' : 'evidence_viewed',
        new Date().toISOString(),
      );

      await recordAudit(tx, {
        adminId: req.user.id,
        action: 'REPORT_EVIDENCE_VIEWED',
        targetUserId: auditSubject(report),
        /* The self-review case is spelled out in the record rather than left to
           be inferred by comparing the actor against the report's parties later.
           An owner reading the messages of somebody who reported THEM is the one
           access here a reviewer must be able to find without reconstructing it. */
        details: selfReview
          ? `SELF-REVIEW: read ${messages.length} preserved message(s) for report ${report.id}, `
            + 'in which this administrator is named'
          : `Read ${messages.length} preserved message(s) for report ${report.id}`,
      });
    });

    res.json({ reportId: report.id, status: report.status, messages });
  } catch (err) {
    /**
     * A grant that does not cover this read is a 403 the client can act on, not
     * a 500. `spendChallenge` throws `ChallengeNotSpent` when the challenge is
     * missing, expired, already spent, or bound to a DIFFERENT report — the last
     * being exactly the case `bindsParams: ['reportId']` exists to create, so
     * answering it with a server error would make the binding look like a fault.
     */
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result);
    console.error('Fetch report evidence error:', err);
    res.status(500).json({ error: 'Failed to fetch preserved evidence' });
  }
});




// A6. System Status

/**
 * Operational status for the admin dashboard.
 *
 * This used to return `{ smtpConfigured }` and nothing else — which reports that
 * three environment variables are set, not that mail is being delivered. During an
 * SMTP outage it stayed `true` while every verification link silently failed to
 * arrive, and with REQUIRE_EMAIL_VERIFICATION defaulting to ON that is a silent
 * lockout of every new account.
 *
 * Each field below answers a question an operator was previously unable to ask
 * without an SSH session. All of them fail soft: a broken sub-check reports itself
 * as unknown rather than 500-ing the whole panel, because a status endpoint that
 * goes down during an incident is worse than one that admits partial ignorance.
 */
/**
 * Gated on `analytics.school`, not `audit.read`.
 *
 * It was `audit.read` until M1c, which is how a capability named for the audit
 * trail came to be the gate on a mail-and-queue health panel that has nothing to
 * do with it. When `audit.read` moved to SUPER_ONLY, keeping this gate would have
 * taken system status away from every administrator as a side effect of securing
 * a different screen — so the two had to move together, in one commit, or there
 * would be a window with no operational visibility for the people on call.
 *
 * `analytics.school` is what administrators already hold for platform-health
 * figures, and it is what this endpoint actually returns.
 */
router.get('/api/admin/system/status', authenticateToken, requireCap('analytics.school'), async (req, res) => {
  const smtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

  res.json({
    // Retained: still the right answer to "is SMTP set up at all".
    smtpConfigured,
    // New: whether it is actually working. Local parts are never included — see
    // email.js recordFailure.
    mail: getMailHealth(),
    /**
     * What the PROVIDER said became of recent mail.
     *
     * `mail` above answers "can we hand a message over"; this answers "did it
     * arrive". They are different questions and a healthy first one tells you
     * nothing about the second — a message accepted by Resend and then hard-
     * bounced looks like a success everywhere else in this payload.
     *
     * Counts only. No addresses, no subjects, no bodies. `configured: false`
     * means no webhook secret is set, which is the honest answer for a
     * deployment that has not finished the Resend setup rather than a
     * misleading zero.
     */
    delivery: await deliveryHealth(),
    notificationQueue: await getQueueHealth(),
    backup: backupStatus(),
    /**
     * The Redis layer, if there is one.
     *
     * `configured: false` is a supported, unalarming state — the pilot runs
     * without Upstash. The field worth watching is `degraded`, which means
     * configured but currently falling back: nothing is broken for users, and
     * every shared rate limit has quietly become per-process again.
     *
     * Counts and configuration only. No key names, no key contents, and never
     * the token — see redis/status.js, which owns that decision so this handler
     * does not become a second place that makes it.
     */
    redis: redisStatus({
      weather: weatherCacheStats(),
      geocode: geocodeCacheStats(),
    }),
    hoursLedger: await hoursLedgerStatus(db)
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Account suspension
 *
 * ── Why this exists ──
 *
 * `account_status` has accepted 'suspended' since v1.1 and sign-in has refused
 * it for just as long — but no route ever set it, so `user.suspend` was a
 * capability with nothing behind it. The practical consequence was that an
 * administrator holding a credible safety report about an adult messaging a
 * minor could mark the report resolved and delete a comment, and could not
 * remove the person from the platform. On a service whose deliberate design
 * lets organizers message students, that was the gap that made every other
 * safety control theoretical.
 *
 * ── Suspend, never delete ──
 *
 * `/api/admin/organizers/:id/deny` is scoped to `verified = 0` on purpose: its
 * comment explains that an unscoped delete by id would take an approved
 * organizer's events with it via ON DELETE CASCADE, and their volunteers'
 * attendance rows with those — silently destroying credited service hours.
 * That reasoning applies with equal force here, which is why suspension is a
 * status change and not a removal. A suspended organizer keeps their row,
 * their events keep their attendance, and the students who volunteered keep
 * their hours.
 * ──────────────────────────────────────────────────────────────────────────── */

const MIN_SUSPENSION_REASON = 10;

/**
 * How long an appeal link lives.
 *
 * One definition, used by both the suspension path and the manual re-issue
 * below, because those two drifted once already — one wrote a zone-less SQLite
 * datetime and the other an ISO-8601 UTC string, and the same "30 days" meant
 * different instants. The Community Guidelines' five business days is our REPLY
 * time, not the appellant's filing window.
 */
const APPEAL_TOKEN_DAYS = 30;

/**
 * Whether `actor` may act on `target`, given both rows.
 *
 * Deny-by-default and ordered most-privileged-first, following the rule in
 * authz.js: `can()` answers true for every capability a super_admin asks
 * about, so any cascade that tests a narrower capability first puts
 * super_admin in the wrong branch.
 *
 * The specific escalation this closes: `user.suspend` is an ordinary admin
 * capability, and without a role check an admin could suspend the super_admin
 * who could otherwise undo it — locking the owner out of their own platform
 * using a capability granted for moderating students.
 */
function suspensionTargetError(actorPrincipal, actorId, target) {
  if (!target) return { status: 404, error: 'User not found' };
  if (target.id === actorId) {
    return { status: 400, error: 'You cannot suspend your own account.' };
  }
  if (target.account_status === 'deleted') {
    return { status: 409, error: 'That account has already been deleted.' };
  }

  /**
   * The target's privilege is asked as a CAPABILITY question, never as a role
   * comparison — `target.role === 'admin'` is exactly what guard 1 in
   * authz.completeness.test.js fails the build on, and rightly: a role string
   * in an authorization decision is how a new role gets silently mishandled.
   *
   * Built with no per-user grants on purpose. A grant is revocable and
   * individually assigned, so it should not shield its holder from moderation;
   * the question here is "does this KIND of account outrank the actor", which
   * is a property of the base role.
   */
  const targetPrincipal = principalFor(target);

  // `admin.create` is SUPER_ONLY, so this is "the target is a super admin"
  // spelled as a capability. Nobody may suspend one — including another super
  // admin, because the failure mode is a platform with no one able to undo it.
  if (can(targetPrincipal, 'admin.create')) {
    return { status: 403, error: 'A super administrator cannot be suspended.' };
  }

  // The target can themselves suspend people, i.e. is an administrator. Only a
  // super admin may act on one; otherwise `user.suspend` — an ordinary admin
  // capability granted for moderating students — becomes a way for one
  // administrator to remove another.
  if (can(targetPrincipal, 'user.suspend') && !can(actorPrincipal, 'admin.create')) {
    return { status: 403, error: 'Only a super administrator can suspend an administrator.' };
  }

  return null;
}

/**
 * Suspends an account and ends every session it holds.
 *
 * The `token_version` bump is the load-bearing half. Setting `account_status`
 * alone would stop the *next sign-in* and leave every already-issued cookie
 * working for up to seven days — so the person you just suspended for
 * messaging a student could carry on messaging that student for a week.
 * `authenticateToken` re-reads the user on every request and compares
 * `token_version`, so incrementing it invalidates all outstanding sessions on
 * the next request they make.
 *
 * Both writes are in one transaction with the audit row: a suspension that is
 * recorded but not enforced, or enforced but not recorded, are both worse than
 * one that fails cleanly and can be retried.
 */
router.post('/api/admin/users/:id/suspend', authenticateToken, requireCap('user.suspend'), async (req, res) => {
  const targetId = req.params.id;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

  /**
   * A reason is mandatory, and long enough to be a sentence.
   *
   * Suspension is the most consequential action an administrator can take
   * against a user, it is appealable, and the Admin Responsibilities Policy
   * commits to telling the person why. A blank or one-word reason makes that
   * commitment unkeepable at exactly the moment it matters, and the appeal
   * reviewer — often the same small team — has nothing to review.
   */
  if (reason.length < MIN_SUSPENSION_REASON) {
    return res.status(400).json({
      error: `A reason of at least ${MIN_SUSPENSION_REASON} characters is required. The user is told why, and it is what an appeal is reviewed against.`,
      code: 'reason_required'
    });
  }

  /**
   * `until` — an ISO-8601 instant, or absent/null for indefinite.
   *
   * Validated here rather than bound straight into the UPDATE, because every
   * malformed value has a way of becoming a suspension that does not mean what
   * the moderator chose:
   *
   *   - An unparseable string stores as unreadable, and `isSuspended` fails CLOSED
   *     on unreadable dates — so a typo would silently produce the permanent
   *     suspension the moderator was trying to avoid.
   *   - A date already in the past stores a suspension that is over before it
   *     begins. It would end at the next request, which reads to everybody as the
   *     suspension having silently failed.
   *   - A non-string is refused rather than coerced, the same rule
   *     `resolutionNote` learned the hard way: `{ until: 1 }` would otherwise
   *     become "1970-01-01".
   *
   * Normalised to `toISOString()` so both columns that carry a deadline hold the
   * same zone-marked form. The incident behind that is a few lines below, where
   * `datetime('now','+30 days')` wrote a zone-less string that `new Date()` then
   * read as local time.
   */
  const rawUntil = req.body?.until;
  let until = null;
  if (rawUntil !== undefined && rawUntil !== null && rawUntil !== '') {
    if (typeof rawUntil !== 'string') {
      return res.status(400).json({
        error: 'An end date must be an ISO-8601 date string, or omitted for a suspension with no end date.',
        code: 'invalid_until',
      });
    }
    const parsed = Date.parse(rawUntil);
    if (Number.isNaN(parsed)) {
      return res.status(400).json({
        error: `"${rawUntil}" is not a date this can read. Use an ISO-8601 instant, or omit it for no end date.`,
        code: 'invalid_until',
      });
    }
    if (parsed <= Date.now()) {
      return res.status(400).json({
        error: 'That end date has already passed, so the suspension would be over before it started. '
          + 'Choose a future date, or omit it for a suspension with no end date.',
        code: 'until_in_past',
      });
    }
    until = new Date(parsed).toISOString();
  }

  const target = await db.prepare(
    'SELECT id, name, role, account_status FROM users WHERE id = ?'
  ).get(targetId);

  const refusal = suspensionTargetError(req.principal, req.user.id, target);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error });

  if (target.account_status === 'suspended') {
    return res.status(409).json({ error: 'That account is already suspended.', code: 'already_suspended' });
  }

  const now = new Date().toISOString();
  const token = crypto.randomBytes(32).toString('hex');

  /**
   * ISO-8601 UTC, matching the re-issue route below.
   *
   * This was `datetime('now','+30 days')`, which SQLite writes as
   * "2026-09-04 23:29:10" — no zone marker. `new Date()` parses that form as
   * LOCAL time, so the real expiry drifted by the server's UTC offset and the
   * two issuance paths in this file disagreed about when the same 30 days ended.
   */
  const expiresAt = new Date(Date.now() + APPEAL_TOKEN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const appealDeadline = new Date(expiresAt).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  try {
    await runInTransaction(db, async (tx) => {
      /**
       * `suspension_lifted_at` is cleared as well as the deadline set.
       *
       * A previously-suspended account carries the timestamp of when that ended.
       * Leaving it in place would make the new suspension read as already over —
       * the row would say suspended, until this date, and lifted at some earlier
       * one — which is the sort of self-contradicting record that gets a decision
       * overturned on appeal for the wrong reason.
       */
      /**
       * ── `token_version` is deliberately NOT bumped ──
       *
       * It was, and that quietly undid the suspension screen.
       *
       * Bumping invalidates every session the account has, so a suspended
       * student's next click was "Session expired, please sign in again". They
       * then re-entered a password to discover they were locked out — the silent
       * ejection the wall was built to replace, with an extra step in front of
       * it. The person least able to work out what had happened was handed the
       * least information.
       *
       * It bought nothing. Enforcement is decided per request from the DATABASE:
       * `authenticateToken` re-reads `account_status` and `suspended_until` on
       * every call and refuses everything outside the four allowlisted routes
       * (`suspendedAccess.js`). The token carries no authority the row does not
       * confirm — `role` on the JWT is ignored, the principal is built from the
       * row — so a live cookie for a suspended account can reach exactly what a
       * freshly minted one can: the suspension notice, an appeal, and sign-out.
       *
       * Every open session on every device is therefore refused on its very next
       * request, whether or not it was invalidated. Keeping them alive is what
       * lets the wall explain itself on the device the person is already holding.
       *
       * Unsuspension deliberately does not bump either, and now for a matching
       * reason: access returns on the same session, with no second sign-in to
       * discover it.
       */
      await tx.prepare(`
        UPDATE users
        SET account_status = 'suspended',
            suspended_at = ?,
            suspended_until = ?,
            suspension_lifted_at = NULL,
            suspension_reason = ?,
            suspended_by = ?
        WHERE id = ?
      `).run(now, until, reason, req.user.id, targetId);

      await tx.prepare(`
        INSERT INTO appeal_tokens (token, user_id, expires_at)
        VALUES (?, ?, ?)
      `).run(token, targetId, expiresAt);

      /**
       * The duration is part of the decision, so it is part of the record.
       * "Suspended: messaging a student after being asked to stop" and the same
       * words for one week are different administrative acts, and the trail has to
       * be able to tell them apart years later.
       */
      await recordAudit(tx, {
        adminId: req.user.id,
        action: 'ACCOUNT_SUSPENDED',
        targetUserId: targetId,
        details: `Suspended ${until ? `until ${until}` : 'indefinitely'}: ${reason}`
      });

      /**
       * A MANDATORY notice: delivered whatever the account's email preference
       * says, and it THROWS rather than returning null if it cannot be enqueued.
       *
       * That is deliberate and it is why this call is inside the transaction. A
       * suspension whose notice could not be created is a person locked out with
       * no reason given and no appeal link in existence — the dispatch failure
       * used to be swallowed and the suspension committed anyway. Rolling back
       * makes it a clean, retryable failure instead of a silent one.
       */
      /**
       * `suspendedUntil` rides along so the notice can say when it ends.
       *
       * A person told only that they are suspended has no way to distinguish a
       * week from for ever, and will either wait indefinitely for something that
       * already lapsed or appeal something that was about to end on its own. The
       * template falls back to the indefinite wording when it is null, so an
       * indefinite suspension reads exactly as it did before.
       *
       * Kept ABOVE the call, not beside the argument it describes. This comment
       * originally sat between `dispatch(` and `'ACCOUNT_SUSPENDED'`, which hid
       * this dispatch from `notificationContent.coverage.test.js` — a source
       * scanner whose pattern tolerates whitespace but not comments. The suite
       * stayed green while the platform's most consequential mandatory notice
       * lost its copy coverage entirely. The scanner now strips comments before
       * matching, so this placement is no longer load-bearing, but the two-line
       * form reads better anyway and there is no reason to go back.
       */
      await notificationService.dispatch(
        'ACCOUNT_SUSPENDED', { reason, token, appealDeadline, suspendedUntil: until }, targetId
      );
    });
  } catch (err) {
    console.error('Failed to suspend account:', err);
    return res.status(500).json({ error: 'Failed to suspend account' });
  }

  /**
   * Reported, not auto-cancelled.
   *
   * A suspended organizer may still host events with volunteers already
   * accepted onto shifts. Cancelling those automatically would strand students
   * with no notice as a side effect of a moderation action, and un-cancelling
   * is not a thing this product can do. So the count comes back for the
   * administrator to act on deliberately.
   */
  const activeEvents = (await db.prepare(`
    SELECT COUNT(*) AS count FROM events
    WHERE organizer_id = ? AND status NOT IN ('completed', 'cancelled')
  `).get(targetId)).count;

  const duration = until
    ? `until ${new Date(until).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`
    : 'with no end date';

  res.json({
    success: true,
    userId: targetId,
    status: 'suspended',
    suspendedAt: now,
    suspendedUntil: until,
    activeEvents,
    message: activeEvents > 0
      ? `Account suspended ${duration}. This organizer still hosts ${activeEvents} active event(s) — reassign or cancel them.`
      : `Account suspended ${duration}. All of their sessions have been ended.`
  });
});

/** Restores a suspended account. Clears the suspension detail; leaves the audit trail. */
router.post('/api/admin/users/:id/unsuspend', authenticateToken, requireCap('user.suspend'), async (req, res) => {
  const targetId = req.params.id;

  const target = await db.prepare(
    'SELECT id, name, role, account_status FROM users WHERE id = ?'
  ).get(targetId);

  const refusal = suspensionTargetError(req.principal, req.user.id, target);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error });

  if (target.account_status !== 'suspended') {
    return res.status(409).json({ error: 'That account is not suspended.', code: 'not_suspended' });
  }

  const note = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

  try {
    await runInTransaction(db, async (tx) => {
      // token_version is deliberately NOT bumped. There are no live sessions to
      // invalidate — the suspension already ended them — and bumping again
      // would only invalidate the session of an administrator who happened to
      // be acting as this user, which is not a thing that can happen here.
      /**
       * `suspended_until` is cleared with the rest of the suspension detail.
       *
       * It has to be. Left behind, a past deadline is inert but a FUTURE one is
       * not: `isSuspended` reads `account_status` first, so the account works
       * again — until somebody suspends it a second time without naming a
       * deadline, at which point it silently inherits the old one and ends on a
       * date nobody chose. The same class of dormant-value bug as the appeal
       * tokens below, which stayed live through an unsuspend and became usable
       * again on the next suspension.
       *
       * `suspension_lifted_at` is deliberately NOT set here. It records that a
       * suspension ran out on its own (see `suspension.js`); a reinstatement by
       * hand is a different act, and it is the audit row below — which is not
       * swept for a year and names who did it — that records this one. Writing
       * both would make the two indistinguishable on the row.
       */
      await tx.prepare(`
        UPDATE users
        SET account_status = 'active',
            suspended_at = NULL,
            suspended_until = NULL,
            suspension_reason = NULL,
            suspended_by = NULL
        WHERE id = ?
      `).run(targetId);

      /**
       * Outstanding appeal tokens are spent at reinstatement.
       *
       * A token stayed live through an unsuspend. It answered 404 only because
       * the route checked `account_status`, so it lay dormant and became usable
       * again the moment the person was suspended a SECOND time — carrying an
       * appeal window that opened before the thing being appealed, and letting
       * an old link disclose a new suspension's reason. Verified by running it.
       * Expiring them here makes each enforcement action carry its own token.
       */
      await tx.prepare(
        "UPDATE appeal_tokens SET expires_at = ? WHERE user_id = ? AND used_at IS NULL"
      ).run(new Date().toISOString(), targetId);

      /**
       * If a reversed appeal ordered this reinstatement, say so in both trails.
       *
       * Reversing an appeal and reinstating the account are deliberately two
       * actions — the second is behind `user.suspend`, which the deciding
       * reviewer may not hold. The cost of that separation was that nothing
       * connected them: the audit log recorded a reinstatement with no reason
       * anybody could trace back to the appeal that required it, and the appeal's
       * own history stopped at the decision, so "was this person ever actually
       * let back in?" had no answer on the record.
       *
       * Looked up rather than passed in, so the link is recorded however the
       * reinstatement was reached — including by an administrator who never
       * opened the appeal.
       */
      const orderedBy = await tx.prepare(`
        SELECT id FROM appeals
         WHERE user_id = ? AND decision = 'reversed' AND status = 'resolved'
         ORDER BY decided_at DESC LIMIT 1
      `).get(targetId);

      await recordAudit(tx, {
        adminId: req.user.id,
        action: 'ACCOUNT_UNSUSPENDED',
        targetUserId: targetId,
        details: (note ? `Reinstated: ${note}` : 'Reinstated')
          + (orderedBy ? ` (completes reversed appeal ${orderedBy.id})` : '')
      });

      if (orderedBy) {
        await tx.prepare(`
          INSERT INTO appeal_events (id, appeal_id, actor_id, actor_role, action,
                                     from_status, to_status, note, created_at)
          VALUES (?, ?, ?, 'reviewer', 'remedy_completed', 'resolved', 'resolved', ?, ?)
        `).run(
          `apev_${crypto.randomBytes(8).toString('hex')}`,
          orderedBy.id, req.user.id,
          'Account reinstated, completing the reversal.',
          new Date().toISOString()
        );
      }

      /**
       * The good-news half of the enforcement class.
       *
       * Nothing told a reinstated person anything, and they cannot discover it
       * by signing in because they have no reason to try. The override that
       * delivers a suspension notice past an email preference is only defensible
       * if it delivers this one too — an override used for bad news and not good
       * news is the version that looks self-serving in hindsight.
       */
      await notificationService.dispatch('ACCOUNT_REINSTATED', { reason: note || null }, targetId);
    });
  } catch (err) {
    console.error('Failed to unsuspend account:', err);
    return res.status(500).json({ error: 'Failed to reinstate account' });
  }

  res.json({ success: true, userId: targetId, status: 'active' });
});

/**
 * Issues a formal warning: the enforcement step below suspension.
 *
 * ── Why this route had to exist ──
 *
 * `REPORT_RESOLUTIONS` has offered `warning_issued` since v1.2 and
 * `ResolutionModal` has offered "Warning issued to the person reported" in its
 * dropdown. Neither did anything to the person. A moderator could close a report
 * saying they had warned somebody, and that somebody was never told — so the
 * platform's own record said a warning had been issued while the only party it
 * concerned had no idea. That is worse than having no warning at all, because the
 * label counts against them if it happens again.
 *
 * ── What it deliberately does not do ──
 *
 * It changes nothing about the account. No status, no capability, no access. A
 * warning that quietly restricted something would be a suspension wearing a
 * gentler word, and the person is being told explicitly that nothing has been
 * taken away — that promise has to be true.
 *
 * ── Why there is no `already_warned` conflict ──
 *
 * Unlike suspension, a second warning is a real and meaningful act: it is the
 * escalation. Refusing one because a previous warning exists would make the
 * second incident unrecordable.
 */
router.post('/api/admin/users/:id/warn', authenticateToken, requireCap('user.warn'), async (req, res) => {
  const targetId = req.params.id;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

  /**
   * Same floor as a suspension reason, and for the same reason: this text is what
   * the person is shown, verbatim, and it is what a later escalation is justified
   * against. "stop" is not something anybody can act on or contest.
   */
  if (reason.length < MIN_SUSPENSION_REASON) {
    return res.status(400).json({
      error: `A reason of at least ${MIN_SUSPENSION_REASON} characters is required. `
        + 'The person is shown these words, and it is what a later suspension would be justified against.',
      code: 'reason_required',
    });
  }

  const target = await db.prepare(
    'SELECT id, name, role, account_status FROM users WHERE id = ?'
  ).get(targetId);

  /**
   * The same target rules as suspension, reused rather than restated.
   *
   * A warning is a lesser act, but every reason those refusals exist applies
   * unchanged: warning your own account is meaningless, a deleted account cannot
   * read it, and an ordinary admin formally warning the platform owner — or
   * another administrator — is the same privilege-escalation shape, just quieter.
   * Its messages say "suspend"; that is a wording cost worth paying to keep one
   * definition of who may be acted upon.
   */
  const refusal = suspensionTargetError(req.principal, req.user.id, target);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error });

  try {
    await runInTransaction(db, async (tx) => {
      await recordAudit(tx, {
        adminId: req.user.id,
        action: 'ACCOUNT_WARNED',
        targetUserId: targetId,
        details: `Warned: ${reason}`,
      });

      /**
       * Inside the transaction, and it THROWS rather than returning null if the
       * notice cannot be enqueued — the same rule the suspension path follows.
       *
       * A warning recorded in the audit log but never delivered is precisely the
       * defect this route was written to fix, so committing the record while
       * losing the notice would reintroduce it one layer down. Rolling back makes
       * it a clean, retryable failure.
       */
      await notificationService.dispatch('ACCOUNT_WARNED', { reason }, targetId);
    });
  } catch (err) {
    console.error('Failed to warn account:', err);
    return res.status(500).json({ error: 'Failed to issue the warning' });
  }

  res.json({
    success: true,
    userId: targetId,
    warned: true,
    message: `${target.name} has been warned and told why. Their access is unchanged.`,
  });
});

router.post('/api/admin/users/:id/appeal-token', authenticateToken, requireCap('user.suspend'), async (req, res) => {
  const targetId = req.params.id;

  const target = await db.prepare(
    'SELECT id, account_status FROM users WHERE id = ?'
  ).get(targetId);

  if (!target) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (target.account_status !== 'suspended') {
    return res.status(409).json({ error: 'User is not suspended' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + APPEAL_TOKEN_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    await runInTransaction(db, async (tx) => {
      // Invalidate existing tokens
      await tx.prepare('UPDATE appeal_tokens SET expires_at = ? WHERE user_id = ? AND used_at IS NULL').run(new Date().toISOString(), targetId);
      
      await tx.prepare(`
        INSERT INTO appeal_tokens (token, user_id, expires_at)
        VALUES (?, ?, ?)
      `).run(token, targetId, expiresAt);

      await recordAudit(tx, {
        adminId: req.user.id,
        action: 'APPEAL_TOKEN_ISSUED',
        targetUserId: targetId,
        details: 'Appeal token issued manually'
      });
    });
  } catch (err) {
    console.error('Failed to issue appeal token:', err);
    return res.status(500).json({ error: 'Failed to issue appeal token' });
  }

  res.json({ success: true, token, expiresAt });
});

router.get('/api/admin/audit-logs', authenticateToken, requireCap('audit.read'), async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;

  const conditions = [];
  const params = [];

  if (req.query.action) {
    conditions.push('a.action = ?');
    params.push(req.query.action);
  }
  if (req.query.adminId) {
    conditions.push('a.admin_id = ?');
    params.push(req.query.adminId);
  }
  if (req.query.targetUserId) {
    conditions.push('a.target_user_id = ?');
    params.push(req.query.targetUserId);
  }
  if (req.query.startDate) {
    conditions.push('a.created_at >= ?');
    params.push(req.query.startDate);
  }
  if (req.query.endDate) {
    conditions.push('a.created_at <= ?');
    params.push(req.query.endDate);
  }
  if (req.query.search) {
    /* Audit-log search. SQLite's LIKE ignores case, PostgreSQL's does not —
       an administrator searching for a name would miss differently-cased
       records on PostgreSQL and have no way to tell. */
    conditions.push(`a.details ${caseInsensitiveLike(db)} ?`);
    params.push(`%${req.query.search}%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const totalRow = await db.prepare(`
      SELECT COUNT(*) as count 
      FROM admin_audit_logs a
      ${whereClause}
    `).get(...params);
    const total = totalRow.count;

    const logs = await db.prepare(`
      SELECT a.*, 
             COALESCE(u_admin.name, 'Account since deleted') as admin_name,
             COALESCE(u_target.name, 'Account since deleted') as target_user_name
      FROM admin_audit_logs a
      LEFT JOIN users u_admin ON a.admin_id = u_admin.id
      LEFT JOIN users u_target ON a.target_user_id = u_target.id
      ${whereClause}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    /**
     * The action filter's options, derived from the trail itself.
     *
     * The client used to carry a hand-written list, and it had drifted badly:
     * it offered `ORGANIZER_APPROVED` and `ORGANIZER_DENIED` (the real actions
     * are `APPROVE_ORGANIZER` and `DENY_ORGANIZER`), so those two filters could
     * only ever return nothing, and it omitted `ADMIN_PROMOTED`,
     * `ADMIN_REVOKED`, `REPORT_EVIDENCE_VIEWED`, `MODERATE_REPORT` and
     * `ADMIN_CONVERSATION_OPENED` — between them most of what the table
     * actually contains.
     *
     * On an accountability surface that is the worst class of bug: a filter
     * that silently returns nothing tells the reader "this never happened"
     * when the truthful answer is "you searched for a string nobody writes".
     *
     * Deriving it means the list cannot drift, and an action with no rows is
     * simply not offered — filtering by it would have returned nothing anyway.
     * Unfiltered on purpose: the options describe the whole trail, so they must
     * not narrow as the reader filters, or each choice would eliminate the
     * others.
     */
    const actions = (await db.prepare(
      'SELECT DISTINCT action FROM admin_audit_logs ORDER BY action'
    ).all()).map((r) => r.action);

    res.json({
      logs,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      actions,
    });
  } catch (err) {
    console.error('Failed to fetch audit logs:', err);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// P-02: Administrator Roster
router.get('/api/admin/roster', authenticateToken, requireCap('admin.create'), async (req, res) => {
  try {
    const admins = await db.prepare(`
      SELECT id, name, email, role, avatar, last_sign_in_at,
             promoted_at, promoted_by, promotion_reason
      FROM users
      WHERE role IN ('admin', 'super_admin')
      AND account_status = 'active'
    `).all();

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    /* `Promise.all` + async callback: each admin's activity counts are a query
       now, so a bare `.map` would send an array of promises as the roster. */
    const roster = await Promise.all(admins.map(async (admin) => {
      // Recompute capabilities using kernel
      const principal = principalFor(admin, {
        grants: await grantsFor(db, admin.id)
      });
      
      const counts = await db.prepare(`
        SELECT action, COUNT(*) as count
        FROM admin_audit_logs
        WHERE admin_id = ? AND created_at >= ?
        GROUP BY action
      `).all(admin.id, thirtyDaysAgo);

      let decisionCount = 0;
      let evidenceReadCount = 0;
      
      for (const row of counts) {
        if (row.action === 'REPORT_EVIDENCE_VIEWED') {
          evidenceReadCount += row.count;
        } else if (
          row.action === 'MODERATE_REPORT' ||
          row.action === 'MODERATE_REPORT_SELF_REVIEW' ||
          row.action === 'USER_SUSPENDED' ||
          row.action === 'USER_UNSUSPENDED' ||
          row.action === 'USER_WARNED' ||
          row.action === 'APPROVE_ORGANIZER' ||
          row.action === 'DENY_ORGANIZER'
        ) {
          decisionCount += row.count;
        }
      }

      return {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        avatar: admin.avatar,
        lastSignInAt: admin.last_sign_in_at || null,
        promotedAt: admin.promoted_at || null,
        promotedBy: admin.promoted_by || null,
        promotionReason: admin.promotion_reason || null,
        isOwner: admin.role === ROLE.SUPER_ADMIN,
        capabilities: ALL_CAPABILITIES.filter(cap => can(principal, cap)),
        grants: principal.grants,
        withholdings: principal.withheld,
        decisionCount,
        evidenceReadCount
      };
    }));

    res.json(roster);
  } catch (err) {
    console.error('Failed to fetch admin roster:', err);
    res.status(500).json({ error: 'Failed to fetch admin roster' });
  }
});

router.get('/api/admin/users/lookup', authenticateToken, requireCap('admin.create'), async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email query parameter is required' });

  try {
    // This lookup exists to find somebody to promote, so a deleted account must
    // not answer it. Deletion anonymises the row in place and leaves `role`
    // untouched, so without the status predicate a tombstone is reported back as
    // a promotable administrator — and the promote endpoint below would then act
    // on an account nobody can sign in to.
    const user = await db.prepare(
      "SELECT id, name, email, avatar, role FROM users WHERE email = ? COLLATE nocase AND account_status <> 'deleted'"
    ).get(email);
    if (!user) return res.status(404).json({ error: 'No user found with that email address' });

    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      role: user.role
    });
  } catch (err) {
    console.error('Failed to lookup user:', err);
    res.status(500).json({ error: 'Failed to lookup user' });
  }
});

router.post('/api/admin/users/:id/promote', authenticateToken, requireCap('admin.create'), requireAAL2('admin.promote'), async (req, res) => {
  const targetUserId = req.params.id;
  const { reason } = req.body;

  if (!reason || typeof reason !== 'string' || reason.trim() === '') {
    return res.status(400).json({ error: 'Promotion requires a stated reason', field: 'reason' });
  }

  try {
    const target = await db.prepare('SELECT id, role, email, account_status FROM users WHERE id = ?').get(targetUserId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    // Deleted accounts keep their row and their role, so they are reachable by
    // id and would otherwise be promotable — granting administrator to an
    // account nobody can sign in to, and writing an audit record that reads as a
    // real promotion. Refused here, above the transaction, so the refusal does
    // not spend the step-up challenge the caller would then have to repeat.
    if (target.account_status === 'deleted') {
      return res.status(404).json({ error: 'User not found' });
    }
    if (target.role === ROLE.ADMIN || target.role === ROLE.SUPER_ADMIN) {
      return res.status(400).json({ error: 'User is already an administrator' });
    }

    await runInTransaction(db, async (tx) => {
      await spendChallenge(tx, req, 'admin.promote', { targetUserId });

      await tx.prepare(`
        UPDATE users 
        SET role = ?, promoted_at = CURRENT_TIMESTAMP, promoted_by = ?, promotion_reason = ? 
        WHERE id = ?
      `).run(ROLE.ADMIN, req.user.id, reason.trim(), targetUserId);

      await recordAudit(tx, {
        adminId: req.user.id,
        action: 'ADMIN_PROMOTED',
        targetUserId,
        details: `Promoted to administrator. Reason: ${reason.trim()}`
      });
    });

    await notificationService.dispatch('ADMIN_PROMOTED', { reason: reason.trim() }, targetUserId);
    res.json({ success: true });
  } catch (err) {
    /**
     * A grant that does not cover this request is a 403 the client can act on,
     * not a 500.
     *
     * `spendChallenge` throws `ChallengeNotSpent` when the challenge is missing,
     * expired, already spent, or bound to different params. Falling through to
     * the generic handler turned all of those into "Failed to …" with status 500
     * — and `useStepUp` re-prompts on `code: 'reauth_required'`, so a moderator
     * whose verification had simply lapsed saw a server error and had no way
     * forward. `refuseReauth` is the shared shape the account and privacy routes
     * have always used.
     */
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result);
    console.error('Failed to promote user:', err);
    res.status(500).json({ error: 'Failed to promote user' });
  }
});

router.post('/api/admin/users/:id/revoke', authenticateToken, requireCap('admin.create'), requireAAL2('admin.revoke'), async (req, res) => {
  const targetUserId = req.params.id;

  try {
    const target = await db.prepare('SELECT id, role, email FROM users WHERE id = ?').get(targetUserId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    
    if (target.role === ROLE.SUPER_ADMIN) {
      return res.status(403).json({ error: 'Cannot revoke the platform owner' });
    }
    if (targetUserId === req.user.id) {
      return res.status(403).json({ error: 'Cannot revoke your own administrative access' });
    }
    if (target.role !== ROLE.ADMIN) {
      return res.status(400).json({ error: 'User is not an administrator' });
    }

    await runInTransaction(db, async (tx) => {
      await spendChallenge(tx, req, 'admin.revoke', { targetUserId });

      await tx.prepare(`
        UPDATE users
        SET role = ?, promoted_at = NULL, promoted_by = NULL, promotion_reason = NULL
        WHERE id = ?
      `).run(ROLE.STUDENT, targetUserId);

      /**
       * Per-user grants go with the role, in the same transaction.
       *
       * Dropping the role alone is not a revocation. `grantsFor()` reads
       * `user_capabilities` unconditionally and unions it into the principal, so
       * an administrator who had been given a grant — the triage-helper pattern
       * migration 002 exists for — would keep it after being demoted to
       * `student`. The most consequential case is `report.evidence.read`: the
       * ability to read students' private message bodies, which is the most
       * invasive power on this platform and precisely the kind of thing a
       * revocation is meant to end.
       *
       * Wiping unconditionally rather than selectively: a revoked administrator
       * has no grant that should survive, and enumerating which ones might would
       * be a list that goes stale the first time a capability is added.
       */
      await tx.prepare('DELETE FROM user_capabilities WHERE user_id = ?').run(targetUserId);

      /**
       * Then put back whatever their CLUB memberships still say they hold.
       *
       * The wipe above is about administrative grants, and it is right to be
       * indiscriminate about those. But since the Student Organizer rank, a
       * `user_capabilities` row can also be an ordinary membership fact — this
       * person helps run the robotics club — and stripping that as a side
       * effect of ending an unrelated administrative role would silently take
       * away a rank a club president granted, with nothing telling either of
       * them. Recomputing from `organization_members` is the same call the
       * membership routes make, so there is one answer to "what does this
       * person's rank entitle them to" rather than two.
       */
      await syncOrganizerCapabilities(db, targetUserId, req.user.id);

      await recordAudit(tx, {
        adminId: req.user.id,
        action: 'ADMIN_REVOKED',
        targetUserId,
        details: 'Revoked administrative access, including any per-user capability grants'
      });
    });

    await notificationService.dispatch('ADMIN_REVOKED', {}, targetUserId);
    res.json({ success: true });
  } catch (err) {
    /**
     * A grant that does not cover this request is a 403 the client can act on,
     * not a 500.
     *
     * `spendChallenge` throws `ChallengeNotSpent` when the challenge is missing,
     * expired, already spent, or bound to different params. Falling through to
     * the generic handler turned all of those into "Failed to …" with status 500
     * — and `useStepUp` re-prompts on `code: 'reauth_required'`, so a moderator
     * whose verification had simply lapsed saw a server error and had no way
     * forward. `refuseReauth` is the shared shape the account and privacy routes
     * have always used.
     */
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result);
    console.error('Failed to revoke user:', err);
    res.status(500).json({ error: 'Failed to revoke user' });
  }
});

export default router;
