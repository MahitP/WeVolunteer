import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import EventShiftsTab from './EventShiftsTab';

/**
 * The shifts tab, and specifically the spot count in its header.
 *
 * ── Why this file exists ──
 *
 * A seeded event with no shifts rendered the literal string **"NaN of  spots
 * filled"** directly above an empty state that says, correctly, "No shifts
 * yet". `event.maxSpots` and `event.spotsRemaining` are both absent for such an
 * event, so `maxSpots - spotsRemaining` is `NaN` and `{maxSpots}` renders as
 * nothing at all.
 *
 * It had shipped, no test covered it, and it was found by opening the page in a
 * browser. That is the gap these close: an arithmetic expression interpolated
 * straight into JSX fails silently and legibly-wrongly, and the component had
 * never been rendered by a test at all.
 */

const NO_OP = {
  eventApps: [],
  currentUser: { id: 'stu-1', role: 'student' },
  isStudent: true,
  isOwner: false,
  isAdmin: false,
  signupsClosed: false,
  selectedSlots: [],
  handleSlotSelect: vi.fn(),
  sendApplication: vi.fn(),
  submitting: false,
  onRelease: vi.fn(),
};

const draw = (event) => render(<EventShiftsTab event={event} {...NO_OP} />);

const withShifts = {
  id: 'evt-1',
  title: 'Spring Park Cleanup',
  organizerName: 'David Kim',
  applicantCount: 3,
  maxSpots: 10,
  spotsRemaining: 4,
  slots: [{
    id: 'slot-1',
    name: 'Morning',
    startDatetime: '2026-09-11T14:00:00.000Z',
    endDatetime: '2026-09-11T17:00:00.000Z',
    maxSpots: 10,
    spotsRemaining: 4,
    hours: 3,
  }],
};

describe('the spot count', () => {
  it('says how many are filled when there are shifts', () => {
    draw(withShifts);
    expect(screen.getByText('6 of 10 spots filled')).toBeInTheDocument();
  });

  it('never renders NaN for an event with no shifts', () => {
    /* The bug, exactly. `undefined - undefined` interpolated into JSX. */
    const { container } = draw({ ...withShifts, slots: [], maxSpots: undefined, spotsRemaining: undefined });
    expect(container.textContent).not.toMatch(/NaN/);
  });

  it('omits the count entirely rather than showing blanks around "of"', () => {
    /* " of  spots filled" is worse than nothing: it reads as a rendering
       failure, which is exactly what it was. */
    const { container } = draw({ ...withShifts, slots: [], maxSpots: undefined, spotsRemaining: undefined });
    expect(container.textContent).not.toMatch(/spots filled/);
  });

  it('still shows the empty state, which is the honest thing to say', () => {
    draw({ ...withShifts, slots: [], maxSpots: undefined, spotsRemaining: undefined });
    expect(screen.getByText(/No shifts yet/i)).toBeInTheDocument();
  });

  it('omits the count when only one of the two totals is present', () => {
    /**
     * Guarded on the numbers rather than on `slots.length`, because a malformed
     * event with shifts but no totals produces the same nonsense and would slip
     * straight past a length check.
     */
    const { container } = draw({ ...withShifts, spotsRemaining: undefined });
    expect(container.textContent).not.toMatch(/NaN|spots filled/);
  });

  it('handles a full event', () => {
    draw({ ...withShifts, spotsRemaining: 0 });
    expect(screen.getByText('10 of 10 spots filled')).toBeInTheDocument();
  });

  it('handles an empty event', () => {
    draw({ ...withShifts, spotsRemaining: 10 });
    expect(screen.getByText('0 of 10 spots filled')).toBeInTheDocument();
  });
});

describe('naming the organizer', () => {
  it('names them when the event says who they are', () => {
    const { container } = draw(withShifts);
    expect(container.textContent).toMatch(/David Kim decides who gets each spot/);
  });

  it('never says "undefined decides who gets each spot"', () => {
    /**
     * An event whose organizer has been tombstoned has no `organizerName`, and
     * this was interpolated unguarded — putting the literal word "undefined"
     * into a sentence about who decides whether a student gets a place.
     */
    const { container } = draw({ ...withShifts, organizerName: undefined });

    expect(container.textContent).not.toMatch(/undefined/);
    expect(container.textContent).toMatch(/The organizer decides who gets each spot/);
  });

  it('falls back for an empty string too, not just a missing key', () => {
    const { container } = draw({ ...withShifts, organizerName: '' });
    expect(container.textContent).toMatch(/The organizer decides who gets each spot/);
  });
});
