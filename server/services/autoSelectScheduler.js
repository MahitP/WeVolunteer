/**
 * Auto Select scheduler — the safety net for a forgotten draw.
 *
 * ── The failure it closes ──
 *
 * Auto Select needed two manual presses after the deadline: draw, then confirm. If
 * the organizer forgot, every applicant stayed `pending` indefinitely. They received
 * one `DECISION_NEEDED` notification, deduped on `awaiting-decision:<eventId>`, so
 * missing it meant never being told again. Students experience that as being ignored
 * and there is no recovery path but a human noticing.
 *
 * ── Deliberately a safety net, not a replacement ──
 *
 * A scheduler that fires the instant the deadline passes takes the review step away
 * from the organizer, which is a product change rather than a reliability fix. So it
 * waits `AUTO_SELECT_GRACE_HOURS` (default 24) past the deadline. Inside that window
 * the organizer is in charge; outside it, nobody is coming, and leaving students
 * pending is worse than selecting without review.
 *
 * Three properties make this safe to leave running:
 *
 *   • It reuses `computeDraw`/`applyRun` — literally the functions the manual routes
 *     call. Fairness is the same code, not a parallel implementation that can drift.
 *   • Idempotency is durable, not in-process: the guard is
 *     `auto_select_runs.is_confirmed = 1`, which the manual route already treats as
 *     terminal. That is what makes it restart-safe with no extra bookkeeping.
 *   • It never touches an accepted application. The draw reads only `pending` rows
 *     and subtracts already-accepted volunteers from capacity.
 *
 * ── Why no separate "scheduled" table or lock ──
 *
 * Considered and rejected. A `scheduled_draws` table would be a second source of
 * truth about whether a draw has happened, and it could disagree with
 * `auto_select_runs` — the F-1 failure mode. The confirmed-run row already answers
 * the question exactly, and it is written in the same transaction as the selection it
 * describes, so the two cannot diverge.
 *
 * Multi-instance safety comes from `server/instanceLock.js`: a second production
 * instance refuses to boot, so two schedulers cannot race. In-process re-entrancy is
 * handled by the `sweepInFlight` flag below.
 */
import { runAndConfirm, hasConfirmedRun } from './autoSelect.js';
import { notificationService } from './notificationService.js';
import { recordError } from '../errorReporter.js';

/** How long after the deadline the organizer keeps sole control. */
const GRACE_HOURS = Number(process.env.AUTO_SELECT_GRACE_HOURS ?? 24);

/** How often the sweep runs. Matches the notification sweep's cadence. */
const INTERVAL_MS = Number(process.env.AUTO_SELECT_INTERVAL_MS) || 15 * 60 * 1000;

/** Whole feature off-switch, for a district that wants selection strictly manual. */
const ENABLED = process.env.AUTO_SELECT_SCHEDULER !== 'false';

let timer = null;

/**
 * Guards against overlapping sweeps within one process.
 *
 * The sweep is synchronous today (`node:sqlite` is synchronous), so an overlap
 * cannot actually occur — but the flag costs nothing and means a future change that
 * introduces an await cannot silently produce two concurrent sweeps. The durable
 * `is_confirmed` guard is what actually prevents double execution; this is the
 * cheap second layer.
 */
let sweepInFlight = false;

/**
 * Events whose draw is overdue and unrun.
 *
 * Every clause is a condition the manual route also enforces, so the scheduler can
 * never run a draw the organizer could not have run themselves:
 *
 *   auto_approve = 1       — Auto Select events only; manual events are the
 *                            organizer's own accept/decline decision.
 *   deadline <= cutoff     — past the deadline AND past the grace period. Drawing
 *                            early would exclude students still entitled to apply.
 *   status open/closed     — not cancelled, not completed.
 *   pending applications   — something to actually decide. Without this the sweep
 *                            would create a confirmed run for an empty event and
 *                            close it out from under the organizer.
 *   no confirmed run       — the idempotency guard.
 *
 * Timestamps are bound as ISO strings rather than compared against SQLite's
 * `datetime('now')`: the columns are `toISOString()` values, and lexicographic
 * comparison against `datetime('now')`'s space-separated form misclassifies every
 * timestamp on today's date. See server/datetimeComparison.test.js.
 */
/**
 * Records a scheduler failure.
 *
 * `db` is threaded through rather than imported: this module already takes its
 * database as an argument on every entry point, which is what lets a test drive
 * a sweep against a throwaway file, and importing one here to save a parameter
 * would quietly take that away.
 */
function reportSchedulerError(err, db, boundary, context = {}) {
  recordError(db, {
    source: 'worker',
    kind: err?.constructor?.name || 'Error',
    message: err?.message,
    stack: err?.stack,
    context: { component: 'autoSelectScheduler', boundary, ...context }
  });
}

export function findDueEvents(db) {
  const cutoff = new Date(Date.now() - GRACE_HOURS * 3600_000).toISOString();

  return db.prepare(`
    SELECT e.id, e.title, e.organizer_id, e.application_deadline,
           COUNT(a.id) AS pending_count
    FROM events e
    JOIN applications a ON a.event_id = e.id AND a.status = 'pending'
    WHERE e.auto_approve = 1
      AND e.application_deadline <= ?
      AND e.status IN ('open', 'closed')
      AND NOT EXISTS (
        SELECT 1 FROM auto_select_runs r
        WHERE r.event_id = e.id AND r.is_confirmed = 1
      )
    GROUP BY e.id
    ORDER BY e.application_deadline ASC
  `).all(cutoff);
}

/**
 * Runs one sweep. Never throws.
 *
 * Each event is handled independently: one failure is logged and the rest continue,
 * because a single bad event must not stop selections for every other. A failed event
 * is simply still due next time — there is no dead-letter state, since the guard is
 * "does a confirmed run exist" and a failure leaves that false.
 */
export function runAutoSelectSweep(db) {
  if (sweepInFlight) {
    console.warn('[AutoSelect] Previous sweep still running; skipping this tick.');
    return { executed: 0, failed: 0, skipped: true };
  }
  sweepInFlight = true;

  let executed = 0;
  let failed = 0;

  try {
    const due = findDueEvents(db);
    if (due.length === 0) return { executed: 0, failed: 0 };

    console.log(`[AutoSelect] ${due.length} event(s) overdue for selection.`);

    for (const event of due) {
      try {
        // Re-checked per event rather than trusted from the query above: between the
        // SELECT and here, the organizer may have confirmed it themselves.
        if (hasConfirmedRun(db, event.id)) continue;

        const result = runAndConfirm(db, event.id, { source: 'scheduler' });
        if (!result.executed) continue;

        executed++;
        console.log(
          `[AutoSelect] Ran selection for "${event.title}" (${event.id}) — `
          + `${result.reusedDraft ? "confirmed the organizer's existing draft" : 'new draw'}, `
          + `deadline was ${event.application_deadline}.`
        );

        // An automatic selection must never be silent. The organizer needs to know
        // volunteers were chosen without them, so they can review and correct.
        notificationService.dispatch('DECISION_NEEDED', {
          eventId: event.id,
          eventTitle: event.title,
          applicantsText: 'Selection ran automatically because the deadline passed and',
          nextStep: result.reusedDraft
            ? 'Your existing draw was confirmed. Review the roster and adjust if needed.'
            : 'Volunteers were chosen by Auto Select. Review the roster and adjust if needed.'
        }, event.organizer_id, `auto-selected:${event.id}`);
      } catch (err) {
        failed++;
        // Left due on purpose: it will be retried on the next sweep.
        console.error(`[AutoSelect] Selection FAILED for ${event.id}:`, err.message);
        /**
         * Reported even though it is retried on the next sweep. Unlike the
         * notification queue there is no attempt ceiling here, so a permanently
         * failing event retries for ever and would otherwise never surface. The
         * repetition is bounded by design rather than by restraint: every
         * occurrence shares a fingerprint, so it is one group with a climbing
         * counter, and the per-hour cap stops the evidence duplicating.
         */
        reportSchedulerError(err, db, 'selection', { eventId: event.id });
      }
    }
  } catch (err) {
    // A failure finding due events at all — a locked or unhealthy database. The
    // interval must survive it; an unhandled rejection here would terminate the
    // process the way the notification worker's used to.
    console.error('[AutoSelect] Sweep failed:', err);
    reportSchedulerError(err, db, 'sweep');
  } finally {
    sweepInFlight = false;
  }

  return { executed, failed };
}

/**
 * Starts the scheduler and runs one catch-up sweep immediately.
 *
 * The immediate sweep is the startup-recovery behaviour: a draw that came due while
 * the process was down should not wait a further fifteen minutes. It is safe to run
 * at boot precisely because the operation is idempotent.
 */
export function startAutoSelectScheduler(db) {
  if (!ENABLED) {
    console.log('[AutoSelect] Scheduler disabled (AUTO_SELECT_SCHEDULER=false).');
    return null;
  }
  if (timer) return timer;

  console.log(
    `[AutoSelect] Scheduler started — every ${Math.round(INTERVAL_MS / 60000)} min, `
    + `${GRACE_HOURS}h grace period after the deadline.`
  );

  runAutoSelectSweep(db);

  timer = setInterval(() => {
    try {
      runAutoSelectSweep(db);
    } catch (err) {
      console.error('[AutoSelect] Scheduler tick failed:', err);
      reportSchedulerError(err, db, 'tick');
    }
  }, INTERVAL_MS);
  // Never the reason the process stays alive; shutdown clears it explicitly.
  timer.unref?.();

  return timer;
}

/** Stops the scheduler. Required for a clean shutdown. */
export function stopAutoSelectScheduler() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  console.log('[AutoSelect] Scheduler stopped.');
}
