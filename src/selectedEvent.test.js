import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Which object the event modal is handed.
 *
 * ── The bug ──
 *
 * `selectedEvent` resolved as `events.find(...) || seenEvents[id]`. Those two
 * are different PROJECTIONS of the same row, not a fresh copy and a stale one:
 * the SessionProvider index is deliberately narrow ("only events this user is
 * involved in"), while a browse response carries `slots` and `viewerBan` —
 * the two fields the modal needs to decide what to render.
 *
 * So whenever an event was in both — every event the reader has applied to —
 * the narrower one won. A banned reader got no ban notice, because `viewerBan`
 * was not on the object the modal received, and the shift list read "No shifts
 * yet" for an event with a live shift. Verified against a real ban: the API
 * returned both fields and the modal rendered neither.
 *
 * ── Why this is a source check ──
 *
 * The resolution is three lines of derived state inside a 1,900-line component
 * that needs a router, a session, a location provider and a dozen mocks to
 * mount. The defect is in the OPERATOR — `||` versus a merge — so the operator
 * is what is pinned, plus the merge order, which is the half that actually
 * decides which projection wins.
 */

const APP = fs.readFileSync(path.join(process.cwd(), 'src', 'App.jsx'), 'utf8');

/** The `selectedEvent` derivation as source text. */
function selectedEventBlock() {
  const start = APP.indexOf('const selectedEvent = selectedEventId');
  expect(start, 'selectedEvent has been renamed or removed').toBeGreaterThan(-1);
  return APP.slice(start, start + 500);
}

describe('the modal is handed a merged event', () => {
  it('does not resolve with a plain fallback between the two sources', () => {
    /**
     * `events.find(...) || seenEvents[id]` is the exact shape of the bug: an
     * event present in both discards the richer object entirely.
     */
    const block = selectedEventBlock();
    expect(
      /events\.find\([^)]*\)\s*\|\|\s*seenEvents/.test(block),
      'selectedEvent picks one projection over the other again — an event in both '
      + 'loses whichever fields the session index omits, which is `slots` and `viewerBan`'
    ).toBe(false);
  });

  it('spreads both, with the browse object layered on top', () => {
    const block = selectedEventBlock();
    /* Order matters and is the whole fix: `seen` last means the response the
       reader was just served wins for any field it carries. */
    expect(block).toMatch(/\{\s*\.\.\.indexed,\s*\.\.\.seen\s*\}/);
  });

  it('still returns null when neither source knows the id', () => {
    /* Otherwise a bad `?event=` parameter renders an empty modal instead of
       the "no longer available" path. */
    const block = selectedEventBlock();
    expect(block).toMatch(/if \(!indexed && !seen\) return null;/);
  });
});

describe('the fields the merge exists to preserve', () => {
  it('are the ones the modal branches on', () => {
    /**
     * Pinned so that a future change to the modal's ban handling cannot quietly
     * stop depending on the field this merge was written to deliver — which
     * would make the merge look removable.
     */
    const modal = fs.readFileSync(
      path.join(process.cwd(), 'src', 'components', 'EventModal.jsx'), 'utf8'
    );
    expect(modal).toMatch(/event\.viewerBan\?\.banned/);
    expect(modal, 'the shift list is no longer suppressed for a banned reader')
      .toMatch(/!event\.viewerBan\?\.banned && \(\s*\n\s*<EventShiftsTab/);
  });
});
