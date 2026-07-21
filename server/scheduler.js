/**
 * Auto Select Scheduler
 *
 * In the upgraded Run-and-Confirm workflow, selection is triggered manually
 * by the organizer after the deadline passes. Therefore, automatic background
 * execution has been disabled.
 */

export function setSelectionTrigger(fn) {}
export function cancelEventSelection(eventId) {}
export function scheduleEventSelection(event) {}
export function initScheduler() {
  console.log('[Scheduler] Event-driven automatic runs are disabled. Selection is manual.');
}
