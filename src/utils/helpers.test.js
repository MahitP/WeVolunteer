import { describe, it, expect } from 'vitest';
import { eventPermissions, formatHours, usesAutoSelect, selectionMethodLabel } from './helpers.js';

/**
 * `eventPermissions` is the client's copy of the server's refusal rules. These
 * tests exist so the two cannot drift apart quietly: if a guard changes in
 * server.js and not here, the UI starts offering buttons that 409.
 *
 * The mapping under test:
 *   status = 'completed'  → PUT / PATCH / PATCH-status / DELETE all refuse
 *   hasAttendance = true  → DELETE refuses
 */
describe('eventPermissions — completed events are locked', () => {
  const completed = { status: 'completed', hasAttendance: true };

  it('locks details, settings, status and deletion', () => {
    expect(eventPermissions(completed)).toMatchObject({
      canEditDetails: false,
      canChangeStatus: false,
      canChangeSettings: false,
      canDelete: false
    });
  });

  it('still allows duplication, because that writes a new event', () => {
    expect(eventPermissions(completed).canDuplicate).toBe(true);
  });

  it('explains why, so the UI can say something useful', () => {
    expect(eventPermissions(completed).blockedReason).toMatch(/complete/i);
  });

  it('locks a completed event even with no attendance recorded', () => {
    expect(eventPermissions({ status: 'completed', hasAttendance: false }))
      .toMatchObject({ canEditDetails: false, canDelete: false });
  });
});

describe('eventPermissions — attendance protects an event from deletion', () => {
  it('blocks deletion on an open event that already has hours', () => {
    const perms = eventPermissions({ status: 'open', hasAttendance: true });
    expect(perms.canDelete).toBe(false);
    // Still editable — only deletion is blocked by attendance.
    expect(perms.canEditDetails).toBe(true);
    expect(perms.canChangeStatus).toBe(true);
    expect(perms.blockedReason).toMatch(/cancel it instead/i);
  });

  it('points the organizer at cancellation rather than a dead end', () => {
    expect(eventPermissions({ status: 'open', hasAttendance: true }).blockedReason)
      .toMatch(/cancel/i);
  });
});

describe('eventPermissions — everything is available on a fresh event', () => {
  it('allows all actions', () => {
    expect(eventPermissions({ status: 'open', hasAttendance: false })).toEqual({
      canEditDetails: true,
      canChangeStatus: true,
      canChangeSettings: true,
      canDelete: true,
      canDuplicate: true,
      /* An open event has no final roster to freeze, so there is nothing to
         close out yet. `toEqual` on the whole object is deliberate — it fails
         when a key is ADDED, which is how a new permission gets a case here
         rather than shipping unasserted. */
      canCloseOutHours: false,
      hoursClosedOut: false,
      blockedReason: null
    });
  });

  it('treats closed and cancelled as still editable', () => {
    for (const status of ['closed', 'cancelled']) {
      expect(eventPermissions({ status, hasAttendance: false }).canEditDetails).toBe(true);
    }
  });

  it('fails safe on a missing or malformed event', () => {
    // An undefined event must not read as "completed" and must not read as
    // "definitely deletable" through some accident of coercion.
    expect(eventPermissions(undefined).canEditDetails).toBe(true);
    expect(eventPermissions(null).canDelete).toBe(true);
    expect(eventPermissions({}).blockedReason).toBeNull();
  });

  it('treats a missing hasAttendance flag as no attendance', () => {
    // Older cached payloads predate the field; they must not silently lock the UI.
    expect(eventPermissions({ status: 'open' }).canDelete).toBe(true);
  });
});

/**
 * Closing an event's hours out — the separate, one-way act that makes credited
 * hours permanent.
 *
 * ── The distinction these cases exist to hold ──
 *
 * `completed` and "hours are locked" are NOT the same thing, and the whole
 * design turns on their not being. `completed` is written the instant every
 * accepted volunteer has a record — a side effect of ticking the last checkbox —
 * so if it also froze the hours, a single-volunteer event would freeze on its
 * first save with no moment in which to notice a mistyped 40.
 *
 * So a completed event is offered the close-out and remains fully correctable
 * until somebody takes it. `canEditDetails` being false on the same event while
 * `canCloseOutHours` is true is the point, not an inconsistency: the event's
 * DETAILS are frozen by completion and its HOURS are not.
 */
describe('eventPermissions — closing the hours out', () => {
  const completed = (over = {}) => eventPermissions({ status: 'completed', hoursClosedOutAt: null, ...over });

  it('offers it on a completed event whose hours are still open', () => {
    expect(completed().canCloseOutHours).toBe(true);
    expect(completed().hoursClosedOut).toBe(false);
  });

  /** Completion freezes the event's details and deliberately not its hours. */
  it('leaves a completed event\'s hours correctable while its details are not', () => {
    const perms = completed();
    expect(perms.canEditDetails).toBe(false);
    expect(perms.canCloseOutHours).toBe(true);
  });

  it('stops offering it once the hours have been closed out', () => {
    const perms = completed({ hoursClosedOutAt: '2026-08-20T10:00:00.000Z' });
    expect(perms.canCloseOutHours).toBe(false);
    expect(perms.hoursClosedOut).toBe(true);
  });

  /**
   * Closing out an unfinished roster would freeze it with people still to
   * credit, and they could then never be credited by anybody.
   */
  it('refuses it before the event is complete', () => {
    for (const status of ['open', 'closed']) {
      expect(eventPermissions({ status }).canCloseOutHours, status).toBe(false);
    }
  });

  it('refuses it on a cancelled event, which has no hours to freeze', () => {
    expect(eventPermissions({ status: 'cancelled' }).canCloseOutHours).toBe(false);
  });

  it('fails safe on a payload that predates the field', () => {
    /* An older cached event has no `hoursClosedOutAt`. That must read as "not
       closed out" — the direction that offers a control the server may refuse,
       never one that hides a legitimate action. */
    expect(eventPermissions({ status: 'completed' }).canCloseOutHours).toBe(true);
    expect(eventPermissions(undefined).canCloseOutHours).toBe(false);
    expect(eventPermissions(undefined).hoursClosedOut).toBe(false);
  });
});

describe('formatting helpers used on hours surfaces', () => {
  it('renders zero as hours rather than minutes', () => {
    expect(formatHours(0)).toBe('0 hrs');
    expect(formatHours(null)).toBe('0 hrs');
  });

  it('renders partial hours the way people say them', () => {
    expect(formatHours(1.5)).toBe('1 hr 30 min');
    expect(formatHours(0.75)).toBe('45 min');
    expect(formatHours(2)).toBe('2 hrs');
  });
});

describe('Auto Select naming stays behind the legacy field', () => {
  it('reads the legacy autoApprove flag through an honest name', () => {
    expect(usesAutoSelect({ autoApprove: true })).toBe(true);
    expect(usesAutoSelect({ autoApprove: false })).toBe(false);
    expect(selectionMethodLabel({ autoApprove: true })).toBe('Auto Select');
    expect(selectionMethodLabel({ autoApprove: false })).toBe('Manual review');
  });
});
