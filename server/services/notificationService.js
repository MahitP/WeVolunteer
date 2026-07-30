import { db } from '../db.js';
import { EVENT_CATEGORIES, getInAppContent } from './notificationContent.js';
import { emitToUser } from '../realtime/events.js';

class NotificationService {
  /**
   * Dispatches an event to the appropriate channels based on user preferences.
   * This should ideally be called inside the same transaction as the primary action.
   */
  dispatch(event, payload, userId, dedupeKey = null) {
    try {
      const category = EVENT_CATEGORIES[event] || 'SYSTEM';
      
      // Get user and their global opt out
      const user = db.prepare('SELECT email_opt_out FROM users WHERE id = ?').get(userId);
      if (!user) return null;

      // Deduplication check
      if (dedupeKey) {
        const existing = db.prepare(`
          SELECT 1 FROM notifications 
          WHERE user_id = ? AND dedupe_key = ? 
            AND created_at > datetime('now', '-7 days')
        `).get(userId, dedupeKey);
        
        if (existing) return false;
      }

      // Get preferences for this category
      const prefs = db.prepare(`
        SELECT channel, enabled 
        FROM notification_preferences 
        WHERE user_id = ? AND category = ?
      `).all(userId, category);

      // Map preferences. Default to enabled (1) if no row exists.
      const getPref = (channel) => {
        const row = prefs.find(p => p.channel === channel);
        return row ? row.enabled === 1 : true; // default true
      };

      const inAppEnabled = getPref('inapp');
      // If global email_opt_out is 1, force email to false.
      const emailEnabled = user.email_opt_out === 1 ? false : getPref('email');
      
      const inAppContent = getInAppContent(event, payload);
      
      if (inAppEnabled) {
        this._insertInApp(userId, inAppContent, dedupeKey);
      }

      if (emailEnabled) {
        this._insertEmailJob(event, payload, userId, dedupeKey);
      }
      
      return true;
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return null; // Dedupe catch
      console.error(`Failed to dispatch notification ${event}:`, e);
      return null;
    }
  }

  _insertInApp(userId, { kind, priority, title, body, link }, dedupeKey) {
    const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const notification = {
      id, user_id: userId, kind, priority: priority || 'NORMAL', title, body: body || '', link, read: 0, created_at: new Date().toISOString(), dedupe_key: dedupeKey
    };
    db.prepare(`
      INSERT INTO notifications (id, user_id, kind, priority, title, body, link, read, created_at, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(notification.id, notification.user_id, notification.kind, notification.priority, notification.title, notification.body, notification.link, notification.read, notification.created_at, notification.dedupe_key);
    
    // Best-effort socket emit
    try {
      emitToUser(userId, 'notification.created', notification.id, { notification });
    } catch (e) {
      // Ignore emit errors to not fail the transaction
    }
  }

  _insertEmailJob(event, payload, userId, dedupeKey) {
    const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Storing dedupeKey in the payload so the worker can track it if needed, or we could add a dedupe_key to jobs.
    // For simplicity, we just insert the job.
    db.prepare(`
      INSERT INTO notification_jobs (id, channel, payload, next_attempt_at, created_at)
      VALUES (?, 'email', ?, ?, ?)
    `).run(
      id,
      JSON.stringify({ event, payload, userId, dedupeKey }),
      new Date().toISOString(),
      new Date().toISOString()
    );
  }
}

export const notificationService = new NotificationService();
