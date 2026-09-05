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

describe('a shift you are not allowed to take', () => {
  /**
   * ── Why the button is disabled and not hidden ──
   *
   * The modal already carries a notice saying WHY — a ban, or an event for the
   * club's own members. Removing the control under that notice would leave the
   * explanation floating above nothing; leaving it enabled offers a press whose
   * only possible outcome is a 403. Disabled beneath the reason is the one
   * arrangement where the page reads as a sentence.
   *
   * The server refuses regardless (`server/routes.eventEligibility.test.js`);
   * this is only about not asking somebody to find that out by pressing.
   */
  const membersOnly = {
    ...withShifts,
    audience: 'organization',
    organizationId: 'org-1',
    organizationName: 'Robotics Club',
  };

  const selectBtn = () => screen.getByRole('button', { name: /^Select$/i });

  it('offers the shift on an ordinary event', () => {
    draw(withShifts);
    expect(selectBtn()).toBeEnabled();
  });

  it('offers it on a members-only event to a member', () => {
    draw({ ...membersOnly, viewerIsMember: true });
    expect(selectBtn()).toBeEnabled();
  });

  it('refuses it on a members-only event to somebody who is not a member', () => {
    draw({ ...membersOnly, viewerIsMember: false });
    expect(selectBtn()).toBeDisabled();
  });

  it('refuses it to somebody the organization has banned', () => {
    draw({ ...withShifts, viewerBan: { banned: true, reason: 'Repeatedly no-showed shifts.' } });
    expect(selectBtn()).toBeDisabled();
  });

  it('does NOT read an ABSENT viewerIsMember as "not a member"', () => {
    /**
     * The two readings — `viewerIsMember === false` and `!viewerIsMember` —
     * differ only on a members-only event where the field is missing entirely:
     * a payload from before the field existed, or a cached one. So that is the
     * case this asserts. Written against an event with no `audience` it proved
     * nothing, because the audience test short-circuits first; the mutation
     * passed and this test did not notice.
     *
     * Failing OPEN is the deliberate choice, and it is the rule `src/authz.js`
     * states for the whole client mirror: over-offer a control the server will
     * refuse, never hide one it would have allowed. The server refuses in the
     * one direction that matters; a stale payload must not lock a real member
     * out of their own club's shift.
     */
    const { audience, organizationId, organizationName } = {
      audience: 'organization', organizationId: 'org-1', organizationName: 'Robotics Club',
    };
    draw({ ...withShifts, audience, organizationId, organizationName });
    expect(selectBtn()).toBeEnabled();
  });

  it('drops the how-selection-works note, which is addressed to an applicant', () => {
    draw({ ...membersOnly, viewerIsMember: false });
    expect(screen.queryByText(/Choose the shifts you want/i)).toBeNull();
  });
});

/* ── The four words a shift row can say, and what each of them promises ───── */

/**
 * ── The bug ──
 *
 * The unselected state said "Request" and the selected one said "Selected".
 * Those are the same verb in two tenses, so pressing the button read as
 * "requested" — the past tense of the act named on its face — while the actual
 * request still sat unsent behind a "Send application" button further down the
 * page. Somebody who ticked their shifts and closed the tab had applied for
 * nothing and had been told, in the only words on the row, that they had.
 *
 * These cases pin the two vocabularies apart:
 *
 *   local, unsent    Select / Selected      driven by `selectedSlots`
 *   sent, on record  Awaiting decision …    driven by `mine`, from the server
 *
 * and the last case is the one that matters most: a reload drops
 * `selectedSlots` (component state) and re-derives `mine` from the API, so the
 * post-reload render is the honest one by construction.
 */
describe('the shift row before an application exists', () => {
  const withMine = (status) => ({
    ...NO_OP,
    eventApps: [{ id: 'app-1', slotId: 'slot-1', userId: 'stu-1', status }],
  });

  it('offers "Select", not the name of the act the page has not performed', () => {
    draw(withShifts);
    expect(screen.getByRole('button', { name: /^Select$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Request$/ })).toBeNull();
  });

  it('says "Selected" once the shift is in the local selection', () => {
    render(<EventShiftsTab event={withShifts} {...NO_OP} selectedSlots={['slot-1']} />);
    expect(screen.getByRole('button', { name: /^Selected$/ })).toBeInTheDocument();
  });

  it('reports selection to assistive technology as a toggle, not a submission', () => {
    render(<EventShiftsTab event={withShifts} {...NO_OP} selectedSlots={['slot-1']} />);
    expect(screen.getByRole('button', { name: /^Selected$/ })).toHaveAttribute('aria-pressed', 'true');
    draw(withShifts);
    expect(screen.getByRole('button', { name: /^Select$/ })).toHaveAttribute('aria-pressed', 'false');
  });

  /**
   * Selecting must not, on its own, produce the control that gives a place up.
   * Withdraw belongs to an application that exists; offering it here would
   * confirm the very impression the wording change exists to remove.
   */
  it('offers no Withdraw while the selection is still local', () => {
    render(<EventShiftsTab event={withShifts} {...NO_OP} selectedSlots={['slot-1']} />);
    expect(screen.queryByRole('button', { name: /Withdraw|Release/ })).toBeNull();
  });

  it('shows the submit control only once something is selected', () => {
    draw(withShifts);
    expect(screen.queryByRole('button', { name: /Send application/ })).toBeNull();
    render(<EventShiftsTab event={withShifts} {...NO_OP} selectedSlots={['slot-1']} />);
    expect(screen.getByRole('button', { name: /Send application for 1 shift/ })).toBeInTheDocument();
  });

  /* ── After the application is really on record ── */

  it('replaces Select with "Awaiting decision" and a Withdraw button', () => {
    render(<EventShiftsTab event={withShifts} {...withMine('pending')} />);
    expect(screen.getByText('Awaiting decision')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Withdraw$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Select(ed)?$/ })).toBeNull();
  });

  /**
   * ── "Can't make it", which replaced "Release" ──
   *
   * Giving up a CONFIRMED place had two names in two places: "Release" here and
   * "Can't make it" on the volunteer dashboard, for the same act through the
   * same endpoint. The dashboard's won because it is what the student is
   * communicating rather than what the seat model does about it — "Release" is
   * domain language borrowed from the capacity code.
   *
   * The pending case above still says "Withdraw", and that is a distinction
   * worth keeping: taking back an application nobody has answered is not the
   * same act as dropping a place somebody was counting on.
   */
  it('says "You\'re confirmed" and offers "Can\'t make it" once accepted', () => {
    render(<EventShiftsTab event={withShifts} {...withMine('accepted')} />);
    expect(screen.getByText("You're confirmed")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Can't make it$/ })).toBeInTheDocument();
    /* The old word is gone from the student's view of a confirmed shift. */
    expect(screen.queryByRole('button', { name: /^Release$/ })).toBeNull();
  });

  /**
   * The reload case, stated directly: a stale local selection cannot outrank the
   * server's answer. `selectedSlots` is passed alongside a real application to
   * prove the `mine` branch wins even when both are present — which is the state
   * the component briefly holds between a successful submit and the refetch.
   */
  it('lets the server\'s answer win over a stale local selection', () => {
    render(<EventShiftsTab event={withShifts} {...withMine('pending')} selectedSlots={['slot-1']} />);
    expect(screen.getByText('Awaiting decision')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Selected$/ })).toBeNull();
  });

  /**
   * A withdrawn application is not an application. The row must return to the
   * offer, or somebody who changed their mind can never change it back.
   */
  it('returns to "Select" after the application is withdrawn', () => {
    render(<EventShiftsTab event={withShifts} {...withMine('withdrawn')} />);
    expect(screen.getByRole('button', { name: /^Select$/ })).toBeInTheDocument();
  });
});
