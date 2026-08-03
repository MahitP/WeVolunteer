import express from 'express';
import fs from 'fs';
import path from 'path';

import { authenticateToken, formatUserResponse } from '../utils.js';
import { db } from '../db.js';
import { notificationService } from '../services/notificationService.js';
import { getMailHealth } from '../email.js';
import { getQueueHealth } from '../workers/notificationWorker.js';
import { requireCap } from '../authz.js';
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

    db.prepare("DELETE FROM users WHERE id = ? AND role = 'organizer' AND verified = 0").run(orgId);
    
    // Log the audit event
    recordAudit(db, {
      adminId: req.user.id,
      action: 'DENY_ORGANIZER',
      targetUserId: orgId,
      details: 'Denied and deleted pending organizer account request'
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
    const reports = db.prepare(`
      SELECT r.*, u.name as reporter_name, u.email as reporter_email
      FROM reports r
      JOIN users u ON r.reporter_id = u.id
      ORDER BY 
        CASE WHEN r.status = 'open' THEN 1 ELSE 2 END,
        r.created_at DESC
    `).all();
    
    // Enrich with target info
    for (const report of reports) {
      if (report.target_type === 'event') {
        const event = db.prepare('SELECT title FROM events WHERE id = ?').get(report.target_id);
        report.target_title = event ? event.title : 'Deleted Event';
      } else if (report.target_type === 'comment') {
        const comment = db.prepare('SELECT body FROM event_comments WHERE id = ?').get(report.target_id);
        report.target_title = comment ? comment.body : 'Deleted Comment';
      }
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

export default router;
