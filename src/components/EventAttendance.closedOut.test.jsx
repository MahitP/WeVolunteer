import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

import EventAttendance from './EventAttendance';
import { api } from '../utils/api';

vi.mock('../utils/api');

/**
 * The Closeout screen, in each of its three states.
 *
 * ── The design being asserted ──
 *
 *   correctable  the ordinary case: marks and hours change, with a reason.
 *   ready        the event is `completed` — everyone accounted for — so the
 *                numbers CAN be made final, and are not yet. Still correctable.
 *   closed out   `hoursClosedOutAt` is set. Nothing here changes again, ever.
 *
 * The middle state is the whole point. Freezing hours the moment an event
 * completes would mean that on a single-volunteer event the first save both
 * credits the student and makes a mistyped number permanent — and completion is
 * not a decision anybody makes, it is what happens when the last checkbox is
 * ticked. So the lock is a separate, confirmed, one-way act, and these cases
 * pin the separation: `status === 'completed'` alone must leave every control
 * working.
 *
 * ── What is being mirrored ──
 *
 * The server refuses any change to an existing record once the hours are closed
 * out (409 `hours_locked`, see `server/attendance.closedOut.test.js`). That
 * refusal is the rule. This file is about the screen not OFFERING the edit — a
 * checkbox that can be ticked and a Save button that can only ever answer "no"
 * is how somebody concludes the product is broken rather than that the record
 * is final.
 */

const SLOT_ENDED = {
  name: 'Morning',
  startDatetime: '2026-08-01T13:00:00.000Z',
  endDatetime: '2026-08-01T16:00:00.000Z',
  hours: 3,
};

const app = (id, { name, attendance = null } = {}) => ({
  id,
  slotId: `slot-${id}`,
  userId: `user-${id}`,
  volunteer: { name: name || `Volunteer ${id}`, avatar: '🧑' },
  slot: { ...SLOT_ENDED },
  attendance,
});

const CREDITED = { present: true, hoursAwarded: 3 };

const draw = (event, acceptedApps, props = {}) => render(
  <EventAttendance
    event={event}
    acceptedApps={acceptedApps}
    onClose={vi.fn()}
    onComplete={vi.fn()}
    addToast={vi.fn()}
    {...props}
  />,
);

/** The screen loads check-ins before it renders anything but a skeleton. */
const settled = () => waitFor(() => expect(api.fetchCheckins).toHaveBeenCalled());

/** The footer's close-out button, which only opens the dialog. */
const closeOutTrigger = () => within(document.querySelector('.modal-foot'))
  .getByRole('button', { name: /Close out hours/i });

/** The confirm button INSIDE the dialog. Both carry the same words on purpose:
 *  the dialog restates the action rather than renaming it. */
const confirmCloseOut = () => within(document.querySelector('.modal-confirm'))
  .getByRole('button', { name: /^Close out hours$/ });

const openEvent = {
  id: 'evt-1', title: 'Park Cleanup', status: 'open', creditsHours: true, hoursClosedOutAt: null,
};
/** Everyone accounted for, nothing frozen yet — the correction window. */
const completeEvent = { ...openEvent, status: 'completed' };
/** The organizer pressed Close out hours. */
const closedEvent = { ...completeEvent, hoursClosedOutAt: '2026-08-20T10:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchCheckins.mockResolvedValue([]);
  api.submitAttendance.mockResolvedValue({ credited: [], revoked: [] });
  api.closeOutHours.mockResolvedValue({ success: true });
  localStorage.clear();
});

describe('an event whose hours have been closed out', () => {
  const roster = () => [app('a', { name: 'Leo Chen', attendance: CREDITED })];

  it('says the hours are final, and drops the advice about changing them', async () => {
    draw(closedEvent, roster());
    await settled();
    expect(screen.getByText(/Hours for this event are final/i)).toBeInTheDocument();
    expect(screen.queryByText(/Only ticked volunteers are credited/i)).toBeNull();
  });

  it('marks the credited row as final', async () => {
    draw(closedEvent, roster());
    await settled();
    expect(screen.getByText('Final')).toBeInTheDocument();
  });

  it('will not let the attendance mark be changed', async () => {
    draw(closedEvent, roster());
    await settled();
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  /** The number is the thing being protected, so it stops being an input. */
  it('shows the credited hours as text rather than as an editable field', async () => {
    draw(closedEvent, roster());
    await settled();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByText('3 hrs')).toBeInTheDocument();
  });

  it('offers no bulk marking', async () => {
    draw(closedEvent, roster());
    await settled();
    expect(screen.queryByRole('button', { name: /All present/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /All absent/i })).toBeNull();
  });

  it('offers no save control at all', async () => {
    draw(closedEvent, roster());
    await settled();
    expect(screen.queryByRole('button', { name: /Credit/i })).toBeNull();
  });

  /* The hint tells the reader to change a number, under a banner that has just
     said the numbers are final and beside a control that no longer exists. */
  it('drops the advice about editing the hours', async () => {
    draw(closedEvent, roster());
    await settled();
    expect(screen.queryByText(/Change the number if a volunteer left early/i)).toBeNull();
  });

  it('never calls the API, because there is nothing it could ask for', async () => {
    draw(closedEvent, roster());
    await settled();
    expect(api.submitAttendance).not.toHaveBeenCalled();
  });

  /**
   * A volunteer accepted after close-out has no record to protect, and the
   * server still credits them. The screen must not lock a row the server would
   * accept — that is the direction the client mirror is not allowed to err in.
   */
  it('leaves a volunteer with no record editable', async () => {
    draw(closedEvent, [app('a', { attendance: CREDITED }), app('b')]);
    await settled();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[0]).toBeDisabled();
    expect(boxes[1]).toBeEnabled();
  });
});

describe('an event that is still open', () => {
  it('keeps every control the organizer had', async () => {
    draw(openEvent, [app('a', { attendance: CREDITED })]);
    await settled();
    expect(screen.getByRole('checkbox')).toBeEnabled();
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /All present/i })).toBeInTheDocument();
    expect(screen.queryByText(/Hours for this event are final/i)).toBeNull();
  });

  /** Closing out an unfinished roster would leave the unmarked uncreditable. */
  it('does not offer to close the hours out', async () => {
    draw(openEvent, [app('a', { attendance: CREDITED })]);
    await settled();
    expect(screen.queryByRole('button', { name: /Close out hours/i })).toBeNull();
  });
});

/* ── The correction window: complete, and deliberately not yet frozen ─────── */

describe('an event that is complete but not closed out', () => {
  const roster = () => [app('a', { name: 'Leo Chen', attendance: CREDITED })];

  /**
   * THE case that separates this design from freezing on `completed`. Every one
   * of these controls would be gone if completion were the lock, and a
   * single-volunteer event would reach this state on its very first save.
   */
  it('leaves every record correctable', async () => {
    draw(completeEvent, roster());
    await settled();
    expect(screen.getByRole('checkbox')).toBeEnabled();
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Credit hours to/i })).toBeInTheDocument();
    expect(screen.queryByText('Final')).toBeNull();
  });

  it('says both things: still correctable, and closeable', async () => {
    draw(completeEvent, roster());
    await settled();
    expect(screen.getByText(/Everyone is accounted for/i)).toBeInTheDocument();
    expect(screen.getByText(/still correct anything below/i)).toBeInTheDocument();
  });

  it('offers the close-out as the primary action', async () => {
    draw(completeEvent, roster());
    await settled();
    expect(closeOutTrigger()).toBeInTheDocument();
  });

  /* ── Resistant to an accidental irreversible press ── */

  it('does not close out on the first press — it asks', async () => {
    draw(completeEvent, roster());
    await settled();
    fireEvent.click(closeOutTrigger());
    expect(api.closeOutHours).not.toHaveBeenCalled();
    expect(screen.getByText(/Close out hours for this event\?/i)).toBeInTheDocument();
  });

  it('names how many people it makes permanent, and that nobody can undo it', async () => {
    draw(completeEvent, [app('a', { attendance: CREDITED }), app('b', { attendance: CREDITED })]);
    await settled();
    fireEvent.click(closeOutTrigger());
    /* Scoped to the dialog: "2 volunteers" also appears on the save button
       behind it, and the assertion is about what the CONFIRMATION says. */
    const dialog = within(document.querySelector('.modal-confirm'));
    expect(dialog.getByText(/2 volunteers/)).toBeInTheDocument();
    expect(dialog.getByText(/not you, and not an administrator/i)).toBeInTheDocument();
  });

  it('backs out without calling the API', async () => {
    draw(completeEvent, roster());
    await settled();
    fireEvent.click(closeOutTrigger());
    fireEvent.click(screen.getByRole('button', { name: /Keep them editable/i }));
    expect(api.closeOutHours).not.toHaveBeenCalled();
    expect(screen.queryByText(/Close out hours for this event\?/i)).toBeNull();
  });

  it('closes out only after the confirmation is accepted', async () => {
    const onComplete = vi.fn();
    draw(completeEvent, roster(), { onComplete });
    await settled();
    fireEvent.click(closeOutTrigger());
    fireEvent.click(confirmCloseOut());
    await waitFor(() => expect(api.closeOutHours).toHaveBeenCalledWith('evt-1'));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  /** A refusal must not leave the screen pretending the hours are frozen. */
  it('keeps the screen editable when the server refuses the close-out', async () => {
    const addToast = vi.fn();
    api.closeOutHours.mockRejectedValue(new Error('Every shift has to have ended'));
    draw(completeEvent, roster(), { addToast });
    await settled();
    fireEvent.click(closeOutTrigger());
    fireEvent.click(confirmCloseOut());
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(
      expect.stringMatching(/Every shift/), 'error',
    ));
    expect(screen.getByRole('checkbox')).toBeEnabled();
  });
});

describe('the note before the save that completes the event', () => {
  /**
   * Everybody on the roster ends up accounted for, so this save is the last one
   * that can be corrected.
   */
  it('appears when the save would account for the last volunteer', async () => {
    draw(openEvent, [app('a', { attendance: CREDITED }), app('b')]);
    await settled();
    /* `b` is untouched, so nothing yet — the event stays open. */
    expect(screen.queryByText(/marked complete/i)).toBeNull();

    screen.getAllByRole('checkbox')[1].click();

    await waitFor(() => expect(screen.getByText(/marked complete/i)).toBeInTheDocument());
  });

  /**
   * It must NOT say the hours become permanent, because they do not. A false
   * warning in the place an organizer passes at the end of every event is how
   * people learn to ignore the real one.
   */
  it('says the hours are still correctable afterwards', async () => {
    draw(openEvent, [app('a', { attendance: CREDITED }), app('b')]);
    await settled();
    screen.getAllByRole('checkbox')[1].click();
    await waitFor(() => expect(screen.getByText(/still correct these hours/i)).toBeInTheDocument());
    expect(screen.queryByText(/cannot be changed afterwards/i)).toBeNull();
  });

  it('leaves the save button an ordinary save', async () => {
    draw(openEvent, [app('a', { attendance: CREDITED }), app('b')]);
    await settled();
    screen.getAllByRole('checkbox')[1].click();
    await waitFor(() => expect(
      screen.getByRole('button', { name: /Credit hours to/i }),
    ).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Close out hours/i })).toBeNull();
  });

  /**
   * A volunteer whose shift has not ended cannot be credited yet, so the event
   * cannot close out — and telling somebody it will is worse than saying
   * nothing. This is the case a check against the visible rows alone gets wrong.
   */
  it('stays away while a shift that has not ended is still outstanding', async () => {
    const future = {
      ...app('c'),
      slot: {
        ...SLOT_ENDED,
        startDatetime: '2099-01-01T13:00:00.000Z',
        endDatetime: '2099-01-01T16:00:00.000Z',
      },
    };
    draw(openEvent, [app('a'), future]);
    await settled();
    screen.getAllByRole('checkbox')[0].click();
    await waitFor(() => expect(screen.getByRole('button', { name: /Credit hours to 1/i })).toBeInTheDocument());
    expect(screen.queryByText(/marked complete/i)).toBeNull();
  });

  it('says nothing on an event whose hours are already closed out', async () => {
    draw(closedEvent, [app('a', { attendance: CREDITED })]);
    await settled();
    expect(screen.queryByText(/marked complete/i)).toBeNull();
  });
});
