import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EventModal from './EventModal';

/**
 * What a banned reader sees on an opportunity.
 *
 * ── The bug this file exists for ──
 *
 * The ban notice rendered, and the shift list rendered underneath it anyway.
 * Its per-slot buttons were `disabled`, which is not the same thing as absent:
 * a greyed-out "Request" still reads as "you could join this", and the reader is
 * left to work out that the red box above is the reason. What was asked for, and
 * what is here now, is that the Join affordance is REPLACED by the appeal one.
 *
 * ── Why the appeal state has three shapes ──
 *
 * No appeal yet, one waiting, one decided. They mean different things to the
 * person: act, wait, and "here is the answer". Collapsing them loses the only
 * information the screen exists to carry.
 */

/**
 * Every api method this tree can reach must exist here.
 *
 * A missing key is not a no-op — it throws `undefined is not a function` from
 * inside a passive effect and surfaces as a confusing hook-order failure rather
 * than as "you forgot to mock getWeather". The same note is on
 * EventModal.test.jsx, which learned it the same way.
 *
 * Promises that never settle, so neither renders and neither races an assertion.
 */
vi.mock('../utils/api', () => ({
  api: {
    fetchCheckins: vi.fn(),
    fetchAutoSelectRuns: vi.fn(),
    getWeather: vi.fn(() => new Promise(() => {})),
    getTravelTime: vi.fn(() => new Promise(() => {})),
  },
}));

/* The modal reads a position from context; null is "not shared", which is what
   every case here wants. Destructured by the component, so it must be an object. */
vi.mock('../contexts/LocationContext', () => ({
  useLocationContext: () => ({ location: null }),
}));

const baseEvent = {
  id: 'ev-1',
  title: 'Riverside Cleanup',
  description: 'A morning by the river.',
  category: 'Other',
  location: 'Riverside Park',
  organizerId: 'org-user',
  organizerName: 'Sarah Jenkins',
  organizationId: 'org-1',
  organizationName: 'River Club',
  organizationSlug: 'river-club',
  audience: 'everyone',
  viewerIsMember: null,
  status: 'active',
  applicationDeadline: new Date(Date.now() + 5 * 864e5).toISOString(),
  tags: [],
  slots: [{
    id: 'slot-1', name: 'Morning', description: 'Litter pick',
    startDatetime: new Date(Date.now() + 6 * 864e5).toISOString(),
    endDatetime: new Date(Date.now() + 6 * 864e5 + 72e5).toISOString(),
    maxSpots: 5, spotsTaken: 0, hours: 2,
  }],
};

const currentUser = { id: 'stu-1', name: 'Alex Thompson', role: 'student' };

const show = (event) => render(
  <MemoryRouter>
    <EventModal
      event={event}
      currentUser={currentUser}
      eventApps={[]}
      onClose={() => {}}
      addToast={() => {}}
    />
  </MemoryRouter>
);

beforeEach(() => vi.clearAllMocks());

describe('a reader who is not banned', () => {
  it('still gets the ordinary shift list', () => {
    /* The control case. Without it, every assertion below would pass just as
       happily against a modal that renders no shifts for anybody. */
    show({ ...baseEvent, viewerBan: null });
    expect(screen.getByText(/Morning/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Appeal$/i })).toBeNull();
  });
});

describe('a banned reader', () => {
  const banned = {
    ...baseEvent,
    viewerBan: { banned: true, reason: 'Missed three shifts without telling anyone.', appeal: null },
  };

  it('is told plainly that they are banned, and from which organization', () => {
    show(banned);
    expect(screen.getByText(/You are banned from River Club/i)).toBeInTheDocument();
  });

  it('is given the reason', () => {
    show(banned);
    expect(screen.getByText(/Missed three shifts/i)).toBeInTheDocument();
  });

  it('gets NO shift list and no Request control', () => {
    /* THE regression. A disabled Join is still a Join. */
    show(banned);
    expect(screen.queryByText(/Morning/), 'the shift list rendered under the ban notice').toBeNull();
    expect(screen.queryByRole('button', { name: /Request/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Send application/i })).toBeNull();
  });

  it('gets a prominent Appeal button instead', () => {
    show(banned);
    const appeal = screen.getByRole('button', { name: /Appeal/i });
    /* Red, not the quiet secondary treatment it had — this is the one action
       available on the screen. */
    expect(appeal.className).toMatch(/btn-danger-solid/);
    expect(appeal).not.toBeDisabled();
  });
});

describe('a banned reader whose appeal is waiting', () => {
  const pending = {
    ...baseEvent,
    viewerBan: {
      banned: true,
      reason: 'Missed three shifts.',
      appeal: { id: 'ap-1', status: 'open', decision: null },
    },
  };

  it('sees Appeal Sent, and cannot send another', () => {
    show(pending);
    const sent = screen.getByRole('button', { name: /Appeal Sent/i });
    expect(sent).toBeDisabled();
    expect(sent).toHaveAttribute('aria-disabled', 'true');
  });

  it('is not offered a fresh Appeal button', () => {
    /* Two controls that both look like "appeal" is how a duplicate gets sent. */
    show(pending);
    expect(screen.queryByRole('button', { name: /^Appeal$/i })).toBeNull();
  });

  it('is told it is being processed', () => {
    show(pending);
    expect(screen.getByText(/with the organization/i)).toBeInTheDocument();
  });

  it('is treated the same way while a manager is reviewing it', () => {
    show({ ...pending, viewerBan: { ...pending.viewerBan, appeal: { id: 'ap-1', status: 'reviewing', decision: null } } });
    expect(screen.getByRole('button', { name: /Appeal Sent/i })).toBeDisabled();
  });
});

describe('a banned reader whose appeal was decided', () => {
  const decided = {
    ...baseEvent,
    viewerBan: {
      banned: true,
      reason: 'Missed three shifts.',
      appeal: { id: 'ap-1', status: 'resolved', decision: 'stands' },
    },
  };

  it('is shown the outcome rather than a stale Appeal Sent', () => {
    /* A finished appeal must not leave the button saying "Sent" forever — that
       was the exact dead end `src/appeals.js` was written to stop. */
    show(decided);
    expect(screen.queryByRole('button', { name: /Appeal Sent/i })).toBeNull();
    expect(screen.getByText(/a manager decided/i)).toBeInTheDocument();
  });

  it('may appeal again, because the server allows it', () => {
    /**
     * The only bar on a fresh appeal is the rate limit (five per subject per
     * rolling thirty days); the duplicate guard blocks a second LIVE appeal,
     * not a second appeal. A UI with no way forward was stricter than the
     * policy, on the one screen a banned student can reach.
     */
    show(decided);
    expect(screen.getByRole('button', { name: /Appeal again/i })).toBeInTheDocument();
  });
});

describe('the ban is scoped to its own organization', () => {
  it('shows nothing banned for an event run by a different organization', () => {
    /**
     * `viewerBan` is computed per organization on the server and is null for one
     * the reader is not banned from. A student banned by Organization A must not
     * see Organization B's opportunity as blocked — asserted here because the
     * component would happily render whatever it is handed.
     */
    show({ ...baseEvent, organizationId: 'org-2', organizationName: 'Other Club', viewerBan: null });
    expect(screen.queryByText(/You are banned/i)).toBeNull();
    expect(screen.getByText(/Morning/)).toBeInTheDocument();
  });
});
