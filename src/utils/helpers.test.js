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
