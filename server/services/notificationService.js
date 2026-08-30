import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { EVENT_CATEGORIES, getInAppContent, isMandatoryNotice } from './notificationContent.js';
import { emitToUser } from '../realtime/events.js';

/**
 * How long a `dedupe_key` suppresses a repeat.
 *
 * Computed in JS and BOUND, never written as `datetime('now','-7 days')`. That
 * form produced `2026-08-09 12:00:00` and compared it against a column holding
 * `2026-08-09T12:00:00.000Z` — two formats compared as text, agreeing only by
 * the accident that `T` sorts above a space. Binding an ISO-8601 cutoff compares
 * like with like, and is the only form PostgreSQL has.
 */
const DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const dedupeCutoff = () => new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();

/**
 * The facts a delivery decision needs about one recipient, in ONE statement.
 *
 * ── What this replaces ──
 *
 * Three separate awaits: the global opt-out off `users`, the dedupe probe, and
 * the per-category preference rows. On `node:sqlite` that cost nothing —
 * `DatabaseSync` is synchronous, so three statements were three function calls.
 * On PostgreSQL each await is a network round trip, and `dispatch` is called
 * once per recipient: an event cancelled on a popular shift paid three round
 * trips per volunteer before it wrote anything.
 *
 * The preferences arrive as two scalar subqueries rather than a row set because
 * only two channels are ever asked for, and `(user_id, category, channel)` is
 * the primary key, so each subquery is a unique index probe returning at most
 * one value.
 *
 * A NULL `dedupeKey` needs no branch: `n.dedupe_key = NULL` is never true, so
 * `deduped` comes back NULL and reads as "not deduplicated", which is exactly
 * what "no key means no deduplication" means. Verified identical on both
 * engines, including the NULL case.
 */
const RECIPIENT_FACTS_SQL = `
  SELECT u.email_opt_out AS email_opt_out,
         (SELECT p.enabled FROM notification_preferences p
           WHERE p.user_id = u.id AND p.category = ? AND p.channel = 'inapp') AS inapp_pref,
         (SELECT p.enabled FROM notification_preferences p
           WHERE p.user_id = u.id AND p.category = ? AND p.channel = 'email') AS email_pref,
         (SELECT 1 FROM notifications n
           WHERE n.user_id = u.id AND n.dedupe_key = ? AND n.created_at > ?) AS deduped
    FROM users u
   WHERE u.id = ?
`;

/**
 * The delivery decision, as a pure function of facts somebody else fetched.
 *
 * ── Why the rules live here and nowhere else ──
 *
 * There are two ways to reach this decision now — one recipient at a time, and a
 * whole fan-out at once — and what it decides is not ordinary product behaviour.
 * It decides whether a suspended minor is told they have been suspended, whether
 * they learn an appeal outcome, and whether a child-safety report reaches a
 * moderator. Two copies of these rules would be two chances for one of those to
 * be silently wrong, and the wrong one would be the batch path, which is the one
 * nobody reads.
 *
 * So both loaders feed this, and `notificationDispatch.characterization.test.js`
 * pins every branch against the behaviour that was here before any of it moved.
 *
 * The preference default is "enabled when no row exists", which is what the
 * previous `getPref` meant by `row ? row.enabled === 1 : true`.
 */
function decideDelivery(event, facts) {
  const mandatory = isMandatoryNotice(event);
  const pref = (value) => (value === null || value === undefined ? true : value === 1);

  /**
   * The enforcement class ignores both preference checks.
   *
   * A suspended account cannot read an in-app notification at all — it is
   * refused at `authenticateToken` before `req.user` exists — so email is the
   * only channel that reaches the person being told they are suspended.
   * Honouring a notification preference to the point of denying a minor any
   * knowledge of the sanction against them, or of their right to appeal it, is
   * not privacy-protective; it is a failure to serve notice. See
   * MANDATORY_NOTICE_EVENTS in notificationContent.js for the full reasoning and
   * the published statement this makes the code match.
   *
   * The in-app row is still written for these. It is unreadable while the
   * suspension is live, and it is exactly what the person finds waiting the
   * moment they are reinstated.
   */
  return {
    inApp: mandatory || pref(facts.inapp_pref),
    // If global email_opt_out is 1, force email to false.
    email: mandatory || (facts.email_opt_out === 1 ? false : pref(facts.email_pref)),
  };
}

/** A notification row, built but not yet written. */
function buildNotification(userId, { kind, priority, title, body, link }, dedupeKey, createdAt) {
  return {
    id: `notif-${randomUUID()}`,
    user_id: userId,
    kind,
    priority: priority || 'NORMAL',
    title,
    body: body || '',
    link,
    read: 0,
    created_at: createdAt,
    dedupe_key: dedupeKey,
  };
}

/**
 * An outbox job, built but not yet written.
 *
 * The payload carries the dedupe key so the worker can track it; the row itself
 * has no dedupe column, which is why deduplication is enforced on the in-app
 * side and a job is only ever queued for a notification that was not suppressed.
 */
function buildEmailJob(event, payload, userId, dedupeKey, createdAt) {
  return {
    id: `job-${randomUUID()}`,
    channel: 'email',
    payload: JSON.stringify({ event, payload, userId, dedupeKey }),
    next_attempt_at: createdAt,
    created_at: createdAt,
  };
}

const NOTIFICATION_COLUMNS = '(id, user_id, kind, priority, title, body, link, read, created_at, dedupe_key)';
const notificationValues = (n) =>
  [n.id, n.user_id, n.kind, n.priority, n.title, n.body, n.link, n.read, n.created_at, n.dedupe_key];

const JOB_COLUMNS = '(id, channel, payload, next_attempt_at, created_at)';
const jobValues = (j) => [j.id, j.channel, j.payload, j.next_attempt_at, j.created_at];

/** Best-effort realtime nudge. Never allowed to fail the write it follows. */
function emitCreated(notification) {
  try {
    emitToUser(notification.user_id, 'notification.created', notification.id, { notification });
  } catch {
    // Ignore emit errors to not fail the transaction
  }
}

class NotificationService {
  /**
   * Dispatches an event to the appropriate channels based on user preferences.
   * This should ideally be called inside the same transaction as the primary action.
   */
  async dispatch(event, payload, userId, dedupeKey = null) {
    try {
      const category = EVENT_CATEGORIES[event] || 'SYSTEM';

      const facts = await db.prepare(RECIPIENT_FACTS_SQL)
        .get(category, category, dedupeKey, dedupeCutoff(), userId);
      if (!facts) return null;
      if (facts.deduped) return false;

      const { inApp, email } = decideDelivery(event, facts);
      const now = new Date().toISOString();

      if (inApp) {
        const notification = buildNotification(userId, getInAppContent(event, payload), dedupeKey, now);
        await db.prepare(
          `INSERT INTO notifications ${NOTIFICATION_COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(...notificationValues(notification));
        emitCreated(notification);
      }

      if (email) {
        const job = buildEmailJob(event, payload, userId, dedupeKey, now);
        await db.prepare(
          `INSERT INTO notification_jobs ${JOB_COLUMNS} VALUES (?, ?, ?, ?, ?)`
        ).run(...jobValues(job));
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

  /**
   * The same event, to many recipients, in a fixed number of statements.
   *
   * ── What this replaces ──
   *
   * A loop of `dispatch` calls. Each cost three reads and up to two writes, so a
   * broadcast to N volunteers was up to 5N round trips inside one HTTP request,
   * and the request grew with how popular the event had been. Measured with
   * `bin/load-test.mjs --db-latency 5` against 150 confirmed volunteers before
   * any of this work: 4,440 ms.
   *
   * This issues at most four statements regardless of N: the recipients' facts,
   * the dedupe probe, and the two batch inserts. `getInAppContent` is computed
   * ONCE — every recipient in a fan-out shares the event and the payload, so
   * rendering the same title and body N times was pure repeated CPU.
   *
   * ── What it does not change ──
   *
   * Every delivery decision goes through `decideDelivery`, the same function
   * `dispatch` uses. The dedupe window, the preference defaults, the mandatory
   * override and the per-recipient realtime emit are all identical, and
   * `notificationDispatch.batch.test.js` asserts the two paths agree recipient by
   * recipient on the same fixtures.
   *
   * ── Failure semantics, which are the subtle part ──
   *
   * A batch write is all-or-nothing, and `dispatch` was per-recipient
   * best-effort: if recipient seven failed, one to six and eight onward still got
   * theirs. So a failed batch of a NON-mandatory notice falls back to dispatching
   * one at a time, which restores exactly that. A mandatory notice rethrows
   * instead, because its caller is inside a transaction that must roll back
   * rather than continue with some recipients silently unnotified.
   *
   * The duplicate that deduplication exists to prevent cannot fail the batch at
   * all: the insert carries `ON CONFLICT DO NOTHING`, so a row racing another
   * writer is skipped rather than raising, and `RETURNING` reports which rows
   * were actually written so the outcome is observed rather than assumed.
   *
   * ── When the payload differs per recipient ──
   *
   * `payloadFor` covers the fan-outs that are uniform in everything except one
   * value — Auto Select tells each waitlisted volunteer their own rank. The
   * reads and the writes still batch, which is where the round trips are; only
   * the content rendering goes back to being per recipient, which is CPU and not
   * a round trip. Without it those loops would have stayed at five round trips
   * each purely because one field varies.
   *
   * @param {(userId: string) => (string|null)} [dedupeKeyFor] per-recipient key.
   * @param {(userId: string) => object} [payloadFor] per-recipient payload. When
   *   omitted, `payload` is used for everybody and its content is rendered once.
   * @returns {Promise<Map<string, true|false|null>>} the same tri-state `dispatch`
   *   returns, per recipient: true delivered, false deduplicated, null skipped.
   */
  async dispatchMany(event, payload, userIds, dedupeKeyFor = null, payloadFor = null) {
    const outcomes = new Map();
    const ids = [...new Set(userIds)].filter(Boolean);
    if (!ids.length) return outcomes;

    const category = EVENT_CATEGORIES[event] || 'SYSTEM';
    const marks = (n) => Array.from({ length: n }, () => '?').join(',');
    const keyFor = (userId) => (dedupeKeyFor ? dedupeKeyFor(userId) : null);

    try {
      /* One statement for the opt-out and both preference channels, for every
         recipient. The same two scalar subqueries as the single path. */
      const factsById = new Map();
      for (const row of await db.prepare(`
        SELECT u.id AS id, u.email_opt_out AS email_opt_out,
               (SELECT p.enabled FROM notification_preferences p
                 WHERE p.user_id = u.id AND p.category = ? AND p.channel = 'inapp') AS inapp_pref,
               (SELECT p.enabled FROM notification_preferences p
                 WHERE p.user_id = u.id AND p.category = ? AND p.channel = 'email') AS email_pref
          FROM users u
         WHERE u.id IN (${marks(ids.length)})
      `).all(category, category, ...ids)) {
        factsById.set(row.id, row);
      }

      /* One statement for the dedupe window, skipped entirely when this
         broadcast has no keys. Matched on the PAIR, because keys are per
         recipient and two recipients may legitimately share one. */
      const alreadySent = new Set();
      const keys = [...new Set(ids.map(keyFor).filter(Boolean))];
      if (keys.length) {
        for (const row of await db.prepare(`
          SELECT user_id, dedupe_key FROM notifications
           WHERE user_id IN (${marks(ids.length)})
             AND dedupe_key IN (${marks(keys.length)})
             AND created_at > ?
        `).all(...ids, ...keys, dedupeCutoff())) {
          alreadySent.add(`${row.user_id} ${row.dedupe_key}`);
        }
      }

      /* Rendered once when the payload is shared, which is the usual case:
         every recipient of a fan-out gets the same title and body, so this was
         the same string built N times. A `payloadFor` fan-out renders per
         recipient because it has to. */
      const sharedContent = payloadFor ? null : getInAppContent(event, payload);
      const payloadOf = (userId) => (payloadFor ? payloadFor(userId) : payload);
      const contentOf = (userId) => (payloadFor ? getInAppContent(event, payloadFor(userId)) : sharedContent);
      const now = new Date().toISOString();

      const notifications = [];
      const jobs = [];
      for (const userId of ids) {
        const facts = factsById.get(userId);
        if (!facts) { outcomes.set(userId, null); continue; }

        const key = keyFor(userId);
        if (key && alreadySent.has(`${userId} ${key}`)) { outcomes.set(userId, false); continue; }

        const { inApp, email } = decideDelivery(event, facts);
        if (inApp) notifications.push(buildNotification(userId, contentOf(userId), key, now));
        if (email) jobs.push(buildEmailJob(event, payloadOf(userId), userId, key, now));
        outcomes.set(userId, true);
      }

      if (notifications.length) {
        const written = await db.prepare(`
          INSERT INTO notifications ${NOTIFICATION_COLUMNS}
          VALUES ${notifications.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
          ON CONFLICT DO NOTHING
          RETURNING id
        `).all(...notifications.flatMap(notificationValues));

        /* Emit only for rows that were actually written. A row skipped by the
           conflict clause was deduplicated by a concurrent writer, and telling a
           client about a notification that does not exist is worse than telling
           it nothing. */
        const writtenIds = new Set(written.map(r => r.id));
        for (const n of notifications) {
          if (writtenIds.has(n.id)) emitCreated(n);
          else outcomes.set(n.user_id, false);
        }
      }

      if (jobs.length) {
        await db.prepare(`
          INSERT INTO notification_jobs ${JOB_COLUMNS}
          VALUES ${jobs.map(() => '(?, ?, ?, ?, ?)').join(', ')}
        `).run(...jobs.flatMap(jobValues));
      }

      return outcomes;
    } catch (e) {
      if (isMandatoryNotice(event)) {
        console.error(`Failed to dispatch MANDATORY notice ${event} to ${ids.length} recipient(s):`, e);
        throw e;
      }
      /* Best-effort, one at a time, exactly as the loop this replaced behaved:
         one bad recipient must not cost everybody else their notification. */
      console.error(`Batched dispatch of ${event} failed; falling back to per-recipient:`, e);
      for (const userId of ids) {
        const own = payloadFor ? payloadFor(userId) : payload;
        outcomes.set(userId, await this.dispatch(event, own, userId, keyFor(userId)));
      }
      return outcomes;
    }
  }
}

export const notificationService = new NotificationService();
