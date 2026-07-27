import express from 'express';

import { authenticateToken, formatUserResponse, createNotification } from '../utils.js';
import { db } from '../db.js';

const router = express.Router();

router.get('/api/admin/organizers/pending', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied: Administrators only' });
  }

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
router.post('/api/admin/organizers/:id/approve', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied: Administrators only' });
  }

  const orgId = req.params.id;

  try {
    db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(orgId);
    createNotification({
      userId: orgId,
      kind: 'approval',
      title: 'Account approved!',
      body: 'Your organizer account is verified. You can now post events.'
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Verify organizer error:', error);
    res.status(500).json({ error: 'Internal server error verifying account' });
  }
});

// A3. Deny Organizer account
router.post('/api/admin/organizers/:id/deny', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied: Administrators only' });
  }

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
    res.json({ success: true });
  } catch (error) {
    console.error('Deny organizer error:', error);
    res.status(500).json({ error: 'Internal server error denying registration request' });
  }
});

// A4. Remove Event Listing

router.get('/api/admin/stats', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
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
router.get('/api/admin/reports', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }
  
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
router.patch('/api/admin/reports/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  const { status } = req.body;
  if (!['open', 'resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  
  try {
    const info = db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, req.params.id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }
    res.json({ success: true, message: 'Report updated' });
  } catch (err) {
    console.error('Update report error:', err);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

export default router;
