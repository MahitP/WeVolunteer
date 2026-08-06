import { db } from '../db.js';
import { EVENT_CATEGORIES, getInAppContent, isMandatoryNotice } from './notificationContent.js';
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

      /**
       * The enforcement class ignores both preference checks.
       *
       * A suspended account cannot read an in-app notification at all — it is
       * refused at `authenticateToken` before `req.user` exists — so email is
       * the only channel that reaches the person being told they are suspended.
       * Honouring a notification preference to the point of denying a minor any
       * knowledge of the sanction against them, or of their right to appeal it,
       * is not privacy-protective; it is a failure to serve notice. See
       * MANDATORY_NOTICE_EVENTS in notificationContent.js for the full reasoning
       * and the published statement this makes the code match.
       *
       * The in-app row is still written for these. It is unreadable while the
       * suspension is live, and it is exactly what the person finds waiting the
       * moment they are reinstated.
       */
      const mandatory = isMandatoryNotice(event);
      const inAppEnabled = mandatory || getPref('inapp');
      // If global email_opt_out is 1, force email to false.
      const emailEnabled = mandatory || (user.email_opt_out === 1 ? false : getPref('email'));

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
      /**
       * An enforcement notice that cannot be enqueued must not fail silently.
       *
       * This catch used to swallow everything and return null. `dispatch` is
       * called INSIDE the suspension transaction, so a swallowed failure meant a
       * student could be suspended with no notice, no appeal link and no error
       * anywhere — the suspension committed regardless. Rethrowing rolls the
       * suspension back so it can be retried, which is the same argument the
       * suspend route already makes for keeping its audit row in the
       * transaction: recorded-but-not-enforced and enforced-but-not-recorded are
       * both worse than a clean failure.
       *
       * Everything else keeps the old best-effort behaviour: a missed event
       * reminder must never fail the operation that triggered it.
       */
      if (isMandatoryNotice(event)) {
        console.error(`Failed to dispatch MANDATORY notice ${event} to ${userId}:`, e);
        throw e;
      }
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
