import express from 'express';
import fs from 'fs';
import path from 'path';

import { authenticateToken, formatUserResponse, inTransaction } from '../utils.js';
import { db } from '../db.js';
import { notificationService } from '../services/notificationService.js';
import { getMailHealth } from '../email.js';
import { getQueueHealth } from '../workers/notificationWorker.js';
import { requireCap, can, principalFor } from '../authz.js';
import { recordAudit } from '../auditLog.js';

const router = express.Router();

router.get('/api/admin/organizers/pending', authenticateToken, requireCap('organizer.approve'), (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM users WHERE role = 'organizer' AND verified = 0").all();
    const formatted = rows.map(r => formatUserResponse(r));
    res.json(formatted);
  } catch (error) {
    console.error('Pending organizers error:', error);
    res.status(500).json({ error: 'Internal server error fetching pending organizer queue' });
  }
});

// A2. Verify Organizer account
router.post('/api/admin/organizers/:id/approve', authenticateToken, requireCap('organizer.approve'), (req, res) => {
  const orgId = req.params.id;

  try {
    db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(orgId);
    
    // Log the audit event
    recordAudit(db, {
      adminId: req.user.id,
      action: 'APPROVE_ORGANIZER',
      targetUserId: orgId,
      details: 'Approved pending organizer account'
    });

    notificationService.dispatch('ORGANIZER_APPROVED', {}, orgId);
    res.json({ success: true });
  } catch (error) {
    console.error('Verify organizer error:', error);
    res.status(500).json({ error: 'Internal server error verifying account' });
  }
});

// A3. Deny Organizer account
router.post('/api/admin/organizers/:id/deny', authenticateToken, requireCap('organizer.approve'), (req, res) => {
  const orgId = req.params.id;

  try {
    // Scoped deliberately. An unscoped delete by id lets a mistyped or guessed
    // id remove a student — and ON DELETE CASCADE takes their attendance rows
    // with them, silently destroying credited service hours. Denial only ever
    // applies to an organizer who has not been approved yet, and who therefore
    // has no events and no volunteers attached.
    const target = db.prepare(
      "SELECT id FROM users WHERE id = ? AND role = 'organizer' AND verified = 0"
    ).get(orgId);

    if (!target) {
      return res.status(404).json({
        error: 'No pending organizer request matches that id. Approved organizers cannot be deleted here.'
      });
    }

    inTransaction(() => {
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
      db.prepare('DELETE FROM legal_acceptances WHERE user_id = ?').run(orgId);
      db.prepare("DELETE FROM users WHERE id = ? AND role = 'organizer' AND verified = 0").run(orgId);

      // Log the audit event
      recordAudit(db, {
        adminId: req.user.id,
        action: 'DENY_ORGANIZER',
        targetUserId: orgId,
        details: 'Denied and deleted pending organizer account request'
      });
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Deny organizer error:', error);
    res.status(500).json({ error: 'Internal server error denying registration request' });
  }
});

// A4. Remove Event Listing

router.get('/api/admin/stats', authenticateToken, requireCap('analytics.school'), (req, res) => {
  try {
    const totals = {
      users: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
      students: db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'student'").get().c,
      organizers: db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'organizer'").get().c,
      events: db.prepare('SELECT COUNT(*) as c FROM events').get().c,
      applications: db.prepare('SELECT COUNT(*) as c FROM applications').get().c,
      hours: db.prepare('SELECT COALESCE(SUM(hours_awarded),0) as h FROM attendance WHERE present = 1').get().h,
      pendingOrganizers: db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'organizer' AND verified = 0").get().c
    };

    // ── Rates that tell staff whether the programme is healthy ──
    const attendance = db.prepare(`
      SELECT COUNT(*) as total, SUM(CASE WHEN present = 1 THEN 1 ELSE 0 END) as present
      FROM attendance
    `).get();
    const attendanceRate = attendance.total > 0
      ? Math.round((attendance.present / attendance.total) * 100) : null;

    const eventStatus = db.prepare(`
      SELECT status, COUNT(*) as c FROM events GROUP BY status
    `).all().reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});
    const finishedEvents = (eventStatus.completed || 0) + (eventStatus.cancelled || 0);
    const completionRate = finishedEvents > 0
      ? Math.round(((eventStatus.completed || 0) / finishedEvents) * 100) : null;

    // How many students actually volunteered vs merely registered
    const activeVolunteers = db.prepare(`
      SELECT COUNT(DISTINCT user_id) as c FROM attendance WHERE present = 1
    `).get().c;
    const participationRate = totals.students > 0
      ? Math.round((activeVolunteers / totals.students) * 100) : null;

    // Hours per month, last 6 months
    const monthlyHours = db.prepare(`
      SELECT strftime('%Y-%m', s.end_datetime) as month,
             COALESCE(SUM(at.hours_awarded), 0) as hours,
             COUNT(DISTINCT at.user_id) as volunteers
      FROM attendance at
      JOIN slots s ON at.slot_id = s.id
      WHERE at.present = 1 AND s.end_datetime >= date('now', '-6 months')
      GROUP BY month ORDER BY month ASC
    `).all();

    // Volunteers joining over time
    const signupsByMonth = db.prepare(`
      SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as c
      FROM users WHERE role = 'student' AND created_at >= date('now', '-6 months')
      GROUP BY month ORDER BY month ASC
    `).all();

    const topOrganizers = db.prepare(`
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

    const selectionSplit = db.prepare(`
      SELECT COALESCE(auto_approve, 0) as auto, COUNT(*) as c
      FROM events GROUP BY auto
    `).all().reduce((acc, r) => ({ ...acc, [r.auto === 1 ? 'autoSelect' : 'manual']: r.c }), {});

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

// A3. Get All Reports
router.get('/api/admin/reports', authenticateToken, requireCap('report.resolve'), (req, res) => {
  try {
    /**
     * LEFT JOIN, not JOIN, and this is load-bearing.
     *
     * `reports.reporter_id` became nullable in migration 011 — it was ON DELETE
     * CASCADE, which meant the retention sweep purging a reporter's anonymised
     * shell destroyed their safety report. With the cascade severed to SET NULL,
     * an inner join would make those reports vanish from this queue instead:
     * the quietest possible failure, and the one a moderator cannot notice,
     * because nothing renders to tell them anything is missing.
     *
     * `reporter_name_snapshot` is taken at report time and is what the queue
     * falls back to. The final literal covers reports filed before the snapshot
     * column existed.
     */
    const reports = db.prepare(`
      SELECT r.*,
             COALESCE(u.name, r.reporter_name_snapshot, 'Account since deleted') as reporter_name,
             u.email as reporter_email
      FROM reports r
      LEFT JOIN users u ON r.reporter_id = u.id
      ORDER BY
        CASE WHEN r.status = 'open' THEN 1 ELSE 2 END,
        r.created_at DESC
    `).all();

    /**
     * Enrich from the live row, and fall back to the snapshot taken at report
     * time rather than to the words 'Deleted Comment'.
     *
     * That string was the visible symptom of a real hole: the author of a
     * reported comment could delete it and leave the moderator holding a report
     * about nothing. The hold added in this release stops that while a report is
     * live, and the snapshot is what survives once it is resolved.
     */
    for (const report of reports) {
      const live = report.target_type === 'event'
        ? db.prepare('SELECT title AS text FROM events WHERE id = ?').get(report.target_id)
        : db.prepare('SELECT body AS text FROM event_comments WHERE id = ?').get(report.target_id);

      report.target_title = live?.text ?? report.target_body_snapshot ?? null;
      // The moderator is told which of the two they are reading. A snapshot and
      // a live row are different kinds of evidence and a decision may turn on it.
      report.target_is_snapshot = !live && report.target_body_snapshot != null;
      report.target_missing = !live && report.target_body_snapshot == null;
    }

    res.json(reports);
  } catch (err) {
    console.error('Fetch reports error:', err);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// A4. Update Report Status
router.patch('/api/admin/reports/:id', authenticateToken, requireCap('report.resolve'), (req, res) => {
  const { status } = req.body;
  if (!['open', 'resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  
  try {
    /**
     * Read the report BEFORE updating it, so the audit row can name who filed it
     * and what it was about. Afterwards that context is still in the row, but
     * fetching it first also gives the 404 without a wasted write.
     */
    const report = db.prepare('SELECT id, reporter_id, target_type, target_id, status FROM reports WHERE id = ?')
      .get(req.params.id);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, req.params.id);

    /**
     * Moderation decisions are audited.
     *
     * This was the one admin mutation that wrote no audit row — approvals and
     * denials both did. So an administrator could mark a report resolved or
     * dismissed and leave no record of who decided, or when. On a platform where
     * a report may be a student raising a safety concern, "who closed this" is a
     * question the district will ask and nobody could answer.
     *
     * `target_user_id` is the REPORTER, not the reported event: the column is a
     * foreign key to users, and the reporter is the person the follow-up concerns.
     * What was reported is recorded in `details`.
     */
    recordAudit(db, {
      adminId: req.user.id,
      action: 'MODERATE_REPORT',
      targetUserId: report.reporter_id,
      details: `Report ${report.id} (${report.target_type} ${report.target_id}) `
        + `marked ${status} (was ${report.status})`
    });

    res.json({ success: true, message: 'Report updated' });
  } catch (err) {
    console.error('Update report error:', err);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

/* ── Conversation reports ──────────────────────────────────────────────────
 *
 * Why these three routes are in a release about evidence preservation.
 *
 * `conversation_reports` has been write-only since it was created: two INSERTs
 * in messageRoutes.js and no reader anywhere in server/. The most
 * safety-critical report type on the platform — the one the Youth Safety
 * Guidelines point every student at — landed in a table nobody could open.
 *
 * That was survivable while nothing depended on the status column. It stopped
 * being survivable in this release: the delete holds and the retention hold are
 * scoped to reports that are open or being reviewed, and nothing in the product
 * could move a conversation report out of 'open'. A hold with no key is not a
 * safety mechanism, it is a permanent lock on an organizer's events and on a
 * deleted account's shell.
 *
 * So this is the minimum that makes the holds releasable and the preserved
 * evidence readable, and deliberately nothing more. Assignment, notes,
 * categories, priority, cursor pagination and the fold into the main `reports`
 * queue are specified in docs/specs/2026-08-05-trust-and-safety-mvp.md and
 * belong to the moderation-queue release. Ids are preserved by that fold, so
 * these paths survive it.
 */

router.get('/api/admin/reports/conversation', authenticateToken, requireCap('report.resolve'), (req, res) => {
  try {
    /**
     * Every displayed name comes from the snapshot first and the live row only
     * as a refinement, which is the opposite of the usual instinct. The live
     * row is the destructible one: accounts anonymise on deletion, and the
     * event a conversation hung from is the reported organizer's own to delete.
     * The snapshot is what the report actually said at the time it was filed.
     */
    const reports = db.prepare(`
      SELECT cr.id, cr.conversation_id, cr.reason, cr.details, cr.status, cr.created_at,
             COALESCE(cr.reporter_name_snapshot, ru.name, 'Account since deleted') AS reporter_name,
             COALESCE(cr.reported_name_snapshot, pu.name, 'Account since deleted') AS reported_name,
             cr.reported_role_snapshot AS reported_role,
             COALESCE(cr.event_title_snapshot, e.title)  AS event_title,
             (SELECT COUNT(*) FROM conversation_report_messages m WHERE m.report_id = cr.id)
               AS evidence_count,
             (c.id IS NOT NULL) AS conversation_still_exists
      FROM conversation_reports cr
      LEFT JOIN users ru        ON ru.id = cr.reporter_id
      LEFT JOIN users pu        ON pu.id = cr.reported_user_id
      LEFT JOIN conversations c ON c.id  = cr.conversation_id
      LEFT JOIN events e        ON e.id  = cr.event_id_snapshot
      ORDER BY
        CASE WHEN cr.status IN ('open', 'reviewing') THEN 1 ELSE 2 END,
        CASE WHEN cr.reason = 'safety' THEN 1 ELSE 2 END,
        cr.created_at ASC
    `).all();

    /**
     * No message bodies here, deliberately. A list view is scanned, often with
     * somebody else at the desk; a student's disclosure is not scannable
     * content. Bodies come only from the evidence route below, which logs the
     * read — which is what the Youth Safety Guidelines already promise in print.
     *
     * Oldest first within the open band, unlike the `reports` queue above.
     * Newest-first starves the oldest unanswered report, which is by
     * construction the one most likely to be a real harm nobody answered.
     */
    res.json(reports.map(r => ({ ...r, conversation_still_exists: Boolean(r.conversation_still_exists) })));
  } catch (err) {
    console.error('Fetch conversation reports error:', err);
    res.status(500).json({ error: 'Failed to fetch conversation reports' });
  }
});

router.get('/api/admin/reports/conversation/:id/evidence', authenticateToken, requireCap('report.evidence.read'), (req, res) => {
  try {
    const report = db.prepare(
      'SELECT id, reporter_id, reported_user_id, status FROM conversation_reports WHERE id = ?'
    ).get(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const messages = db.prepare(`
      SELECT m.message_id, m.sender_id, m.body, m.created_at,
             COALESCE(u.name, 'Account since deleted') AS sender_name
      FROM conversation_report_messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.report_id = ?
      ORDER BY m.created_at ASC
    `).all(req.params.id);

    /**
     * The read is logged before the bodies leave the building.
     *
     * Youth Safety Guidelines: "This is the one situation in which an
     * administrator reads private messages, and it is logged." Until this route
     * existed the sentence described something that could not happen, so it was
     * not logged either. It can happen now, so it is.
     *
     * `target_user_id` is the reported party rather than the reporter: the
     * question this row has to answer later is whose private messages were
     * read.
     */
    recordAudit(db, {
      adminId: req.user.id,
      action: 'REPORT_EVIDENCE_VIEWED',
      targetUserId: report.reported_user_id || report.reporter_id,
      details: `Read ${messages.length} preserved message(s) for conversation report ${report.id}`
    });

    res.json({ reportId: report.id, status: report.status, messages });
  } catch (err) {
    console.error('Fetch report evidence error:', err);
    res.status(500).json({ error: 'Failed to fetch preserved evidence' });
  }
});

router.patch('/api/admin/reports/conversation/:id', authenticateToken, requireCap('report.resolve'), (req, res) => {
  const { status } = req.body;
  if (!['open', 'reviewing', 'resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const report = db.prepare(
      'SELECT id, reporter_id, reported_user_id, conversation_id, status FROM conversation_reports WHERE id = ?'
    ).get(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    /**
     * Status is the only column this route may write, and migration 011's
     * `conversation_reports_immutable` trigger is what makes that true rather
     * than merely intended: what a report says is a record of what was said,
     * and an UPDATE reaching `details` would abort at the database.
     *
     * Resolving is also what releases the delete hold on the reported event and
     * the retention hold on a deleted party's shell — so it is a decision with
     * consequences beyond the queue, and it is audited for that reason.
     */
    inTransaction(() => {
      db.prepare('UPDATE conversation_reports SET status = ? WHERE id = ?').run(status, req.params.id);

      recordAudit(db, {
        adminId: req.user.id,
        action: 'MODERATE_REPORT',
        targetUserId: report.reported_user_id || report.reporter_id,
        details: `Conversation report ${report.id} marked ${status} (was ${report.status}); `
          + `releases evidence holds on the reported conversation when not open/reviewing`
      });
    });

    res.json({ success: true, message: 'Report updated' });
  } catch (err) {
    console.error('Update conversation report error:', err);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

// A5. Export Data to CSV
router.get('/api/admin/reports/export', authenticateToken, requireCap('report.resolve'), (req, res) => {
  try {
    const students = db.prepare(`
      SELECT 
        u.id, 
        u.name, 
        u.email, 
        u.school, 
        u.created_at,
        COALESCE(SUM(at.hours_awarded), 0) as total_hours
      FROM users u
      LEFT JOIN attendance at ON at.user_id = u.id AND at.present = 1
      WHERE u.role = 'student'
      GROUP BY u.id
      ORDER BY u.name ASC
    `).all();

    const sanitizeCsv = (val) => {
      let str = String(val || '');
      if (/^[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
      }
      return `"${str.replace(/"/g, '""')}"`;
    };

    // Create CSV content
    const headers = ['ID', 'Name', 'Email', 'School/Affiliation', 'Joined Date', 'Total Credited Hours'];
    const rows = students.map(s => [
      s.id,
      sanitizeCsv(s.name),
      sanitizeCsv(s.email),
      sanitizeCsv(s.school),
      s.created_at,
      s.total_hours
    ]);
    
    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="wevolunteer_students_export.csv"');
    res.send(csvContent);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Failed to generate CSV export' });
  }
});

// A6. System Status
/**
 * How old the newest backup may be before it is reported stale.
 *
 * The timer runs nightly at 03:00 with up to 5 minutes of jitter, so a healthy
 * system is never more than ~24h behind. 26 hours leaves room for the jitter and a
 * slow run while still catching a single missed night — the same threshold the
 * runbook's alerting table uses.
 */
const BACKUP_STALE_HOURS = Number(process.env.BACKUP_STALE_HOURS) || 26;

/**
 * Freshness of the newest backup archive.
 *
 * ── Why the app reports this at all ──
 *
 * The backup runs as a systemd timer that the application knows nothing about, and
 * `deploy/README.md` is honest that "systemd will mark the unit failed, but nothing
 * tells a human". So a failing backup was invisible for as long as nobody thought
 * to SSH in and look — on the volume holding a school's service-hour records.
 *
 * Reading the directory is not a substitute for alerting on the unit, and it does
 * not claim to be: it cannot distinguish "the timer is disabled" from "the timer ran
 * and failed", both of which present as a stale file. What it does give is a number
 * on a screen an administrator already visits, which is the difference between
 * finding out in a week and finding out tonight.
 *
 * The directory path is deliberately NOT returned. Admins here are school staff,
 * not sysadmins; filesystem layout is not theirs to need and it is useful to anyone
 * who reaches an admin session.
 */
function backupStatus() {
  const dir = process.env.WEV_BACKUP_DIR || '/var/backups/wevolunteer';
  try {
    if (!fs.existsSync(dir)) {
      // Unconfigured is distinct from "ran and produced nothing", and an operator
      // needs to be able to tell them apart.
      return { status: 'unconfigured', lastBackupAt: null, ageHours: null, count: 0 };
    }

    const archives = fs.readdirSync(dir)
      .filter(f => f.endsWith('.db.gz'))
      .map(f => {
        try {
          return { mtime: fs.statSync(path.join(dir, f)).mtime };
        } catch {
          return null; // pruned between readdir and stat
        }
      })
      .filter(Boolean);

    if (archives.length === 0) {
      return { status: 'none', lastBackupAt: null, ageHours: null, count: 0 };
    }

    const newest = archives.reduce((a, b) => (b.mtime > a.mtime ? b : a));
    const ageHours = (Date.now() - newest.mtime.getTime()) / 3_600_000;

    return {
      status: ageHours > BACKUP_STALE_HOURS ? 'stale' : 'ok',
      lastBackupAt: newest.mtime.toISOString(),
      ageHours: Math.round(ageHours * 10) / 10,
      count: archives.length,
      staleAfterHours: BACKUP_STALE_HOURS
    };
  } catch (err) {
    console.error('[Admin] Could not read backup directory:', err);
    return { status: 'unknown', lastBackupAt: null, ageHours: null, count: 0 };
  }
}

/**
 * Whether the append-only ledger still agrees with `attendance`.
 *
 * `attendance` is the source of truth for credited hours and the ledger is the
 * history; a divergence means one of them is wrong about a student's service
 * record. Boot logs a mismatch and carries on by design (taking the platform down
 * over a reporting discrepancy would be worse), and `verifyHours.js` can be run by
 * hand — but neither of those puts the answer in front of the administrator who
 * would be asked to defend the numbers.
 *
 * Counts users rather than rows so the cost stays flat as the ledger grows.
 */
function hoursLedgerStatus() {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS mismatches FROM (
        SELECT a.user_id
        FROM attendance a
        WHERE a.present = 1
        GROUP BY a.user_id
        HAVING COALESCE(SUM(a.hours_awarded), 0) <> COALESCE((
          SELECT SUM(l.delta) FROM hours_ledger l WHERE l.user_id = a.user_id
        ), 0)
      )
    `).get();

    return { inParity: row.mismatches === 0, mismatchedUsers: row.mismatches };
  } catch (err) {
    console.error('[Admin] Could not check hours ledger parity:', err);
    return { inParity: null, mismatchedUsers: null, error: true };
  }
}

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
router.get('/api/admin/system/status', authenticateToken, requireCap('audit.read'), (req, res) => {
  const smtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

  res.json({
    // Retained: still the right answer to "is SMTP set up at all".
    smtpConfigured,
    // New: whether it is actually working. Local parts are never included — see
    // email.js recordFailure.
    mail: getMailHealth(),
    notificationQueue: getQueueHealth(),
    backup: backupStatus(),
    hoursLedger: hoursLedgerStatus()
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
router.post('/api/admin/users/:id/suspend', authenticateToken, requireCap('user.suspend'), (req, res) => {
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

  const target = db.prepare(
    'SELECT id, name, role, account_status FROM users WHERE id = ?'
  ).get(targetId);

  const refusal = suspensionTargetError(req.principal, req.user.id, target);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error });

  if (target.account_status === 'suspended') {
    return res.status(409).json({ error: 'That account is already suspended.', code: 'already_suspended' });
  }

  const now = new Date().toISOString();

  try {
    inTransaction(() => {
      db.prepare(`
        UPDATE users
        SET account_status = 'suspended',
            suspended_at = ?,
            suspension_reason = ?,
            suspended_by = ?,
            token_version = token_version + 1
        WHERE id = ?
      `).run(now, reason, req.user.id, targetId);

      recordAudit(db, {
        adminId: req.user.id,
        action: 'ACCOUNT_SUSPENDED',
        targetUserId: targetId,
        details: `Suspended: ${reason}`
      });
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
  const activeEvents = db.prepare(`
    SELECT COUNT(*) AS count FROM events
    WHERE organizer_id = ? AND status NOT IN ('completed', 'cancelled')
  `).get(targetId).count;

  res.json({
    success: true,
    userId: targetId,
    status: 'suspended',
    suspendedAt: now,
    activeEvents,
    message: activeEvents > 0
      ? `Account suspended. This organizer still hosts ${activeEvents} active event(s) — reassign or cancel them.`
      : 'Account suspended. All of their sessions have been ended.'
  });
});

/** Restores a suspended account. Clears the suspension detail; leaves the audit trail. */
router.post('/api/admin/users/:id/unsuspend', authenticateToken, requireCap('user.suspend'), (req, res) => {
  const targetId = req.params.id;

  const target = db.prepare(
    'SELECT id, name, role, account_status FROM users WHERE id = ?'
  ).get(targetId);

  const refusal = suspensionTargetError(req.principal, req.user.id, target);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error });

  if (target.account_status !== 'suspended') {
    return res.status(409).json({ error: 'That account is not suspended.', code: 'not_suspended' });
  }

  const note = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

  try {
    inTransaction(() => {
      // token_version is deliberately NOT bumped. There are no live sessions to
      // invalidate — the suspension already ended them — and bumping again
      // would only invalidate the session of an administrator who happened to
      // be acting as this user, which is not a thing that can happen here.
      db.prepare(`
        UPDATE users
        SET account_status = 'active',
            suspended_at = NULL,
            suspension_reason = NULL,
            suspended_by = NULL
        WHERE id = ?
      `).run(targetId);

      recordAudit(db, {
        adminId: req.user.id,
        action: 'ACCOUNT_UNSUSPENDED',
        targetUserId: targetId,
        details: note ? `Reinstated: ${note}` : 'Reinstated'
      });
    });
  } catch (err) {
    console.error('Failed to unsuspend account:', err);
    return res.status(500).json({ error: 'Failed to reinstate account' });
  }

  res.json({ success: true, userId: targetId, status: 'active' });
});

export default router;
