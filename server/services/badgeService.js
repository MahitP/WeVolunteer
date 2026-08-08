import crypto from 'crypto';
import { db } from '../db.js';

/**
 * Service to evaluate whether a user has met the criteria for badges, and award them.
 */
export const badgeService = {
  /**
   * Re-evaluates a user's eligibility for all active badges they don't yet have.
   * Can be called synchronously or asynchronously after a stats-changing event.
   */
  evaluateBadges: (userId) => {
    try {
      // 1. Fetch user's current stats (hours, events attended, events organized, etc.)
      const statsRow = db.prepare(`
        SELECT 
          COALESCE(SUM(at.hours_awarded), 0) as total_hours,
          COUNT(at.id) as total_attended
        FROM attendance at
        WHERE at.user_id = ? AND at.present = 1
      `).get(userId);

      const orgStats = db.prepare(`
        SELECT COUNT(id) as events_created
        FROM events 
        WHERE organizer_id = ? AND status IN ('published', 'completed')
      `).get(userId);
      
      const totalHours = Number(statsRow.total_hours);
      const totalAttended = Number(statsRow.total_attended);
      const eventsCreated = Number(orgStats.events_created);

      // 2. Fetch all active badges the user DOES NOT already have
      const availableBadges = db.prepare(`
        SELECT b.* FROM badges b
        WHERE b.active = 1 
          AND b.id NOT IN (SELECT badge_id FROM user_badges WHERE user_id = ?)
      `).all(userId);

      // 3. Evaluate criteria
      for (const badge of availableBadges) {
        let earned = false;
        
        switch (badge.criteria_type) {
          case 'hours':
            if (totalHours >= badge.criteria_value) earned = true;
            break;
          case 'events_attended':
            if (totalAttended >= badge.criteria_value) earned = true;
            break;
          case 'events_created':
            if (eventsCreated >= badge.criteria_value) earned = true;
            break;
          case 'early_adopter':
            // Logic for early adopter could check if user created_at is before a certain date.
            // For now, let's say it's handled manually or via a different trigger.
            break;
          case 'attendance_rate':
            // E.g., criteria_value = 90 (%)
            const attendanceStats = db.prepare(`
              SELECT 
                COUNT(id) as total_signups,
                SUM(CASE WHEN present = 1 THEN 1 ELSE 0 END) as total_present
              FROM attendance
              WHERE user_id = ?
            `).get(userId);
            if (attendanceStats.total_signups >= 5) { // min threshold
              const rate = (attendanceStats.total_present / attendanceStats.total_signups) * 100;
              if (rate >= badge.criteria_value) earned = true;
            }
            break;
          case 'manual':
          default:
            // Manual badges are not auto-awarded
            break;
        }

        if (earned) {
          // Award badge
          const now = new Date().toISOString();
          db.prepare(`
            INSERT INTO user_badges (id, user_id, badge_id, earned_at)
            VALUES (?, ?, ?, ?)
          `).run(`ub-${crypto.randomUUID()}`, userId, badge.id, now);
          
          // Optionally, generate a notification for the user
          db.prepare(`
            INSERT INTO notifications (id, user_id, kind, title, body, link, read, created_at)
            VALUES (?, ?, 'success', ?, ?, ?, 0, ?)
          `).run(
            `notif-${crypto.randomUUID()}`,
            userId,
            'New Badge Earned! 🏆',
            `Congratulations! You've earned the "${badge.name}" badge.`,
            '/profile?tab=badges',
            now
          );
        }
      }
    } catch (err) {
      console.error(`Error evaluating badges for user ${userId}:`, err);
    }
  }
};
