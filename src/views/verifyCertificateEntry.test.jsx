import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The way into certificate verification, on every dashboard there is.
 *
 * ── Why one test over three views ──
 *
 * `/` renders VolunteerDashboard, OrganizerDashboard or AdminDashboard
 * depending on the persona, so "there is a verify button on the dashboard" is
 * three separate facts. The requirement was explicit that it hold for all of
 * them — "Make it visible for all roles though student, org, and admin got it?"
 * — and the failure mode is a dashboard being added, or restructured, with the
 * action quietly absent from that one.
 *
 * Testing them together is what makes that visible. A per-view test would pass
 * for the two that still have it.
 *
 * Position is asserted too, not just presence: it is in the first heading row
 * of the content column, which is what makes it the same control in the same
 * place rather than three buttons that happen to share a label.
 */

/**
 * The dashboards' own data is not what is being tested, so every call answers
 * empty — with one exception.
 *
 * `fetchVolunteerStats` never settles. `ServiceInsights` destructures whatever
 * it is handed, so an empty object throws inside it and takes the whole tree
 * down; a promise that never resolves simply leaves that section unrendered,
 * which is the state being modelled anyway.
 *
 * Everything else has to RESOLVE, because AdminDashboard renders a skeleton
 * until its four fetches return. Leaving them pending would test the skeleton.
 */
const NEVER = new Promise(() => {});
vi.mock('../utils/api', () => ({
  api: new Proxy({}, {
    get: (_t, name) => (name === 'fetchVolunteerStats'
      ? () => NEVER
      : () => Promise.resolve([])),
  }),
}));
vi.mock('../utils/errorReporting', () => ({ reportClientError: vi.fn() }));
vi.mock('../contexts/LocationContext', () => ({ useLocationContext: () => ({ location: null }) }));

const { default: VolunteerDashboard } = await import('./VolunteerDashboard');
const { default: OrganizerDashboard } = await import('./OrganizerDashboard');
const { default: AdminDashboard } = await import('./AdminDashboard');

const noop = () => {};

const ROLES = [
  ['student', () => (
    <VolunteerDashboard
      currentUser={{ id: 'u1', name: 'Leo Chen', role: 'student', volunteeredHours: 0, serviceHourGoal: 25 }}
      events={[]} applications={[]} addToast={noop} setActiveTab={noop}
      refreshEvents={noop} refreshApplications={noop} onViewDetails={noop}
    />
  )],
  ['organizer', () => (
    <OrganizerDashboard
      currentUser={{ id: 'u2', name: 'Jordan Whitfield', role: 'organizer', verified: true }}
      events={[]} applications={[]} addToast={noop} setActiveTab={noop}
      refreshEvents={noop} refreshApplications={noop} onViewDetails={noop}
      onViewVolunteerProfile={noop}
    />
  )],
  ['admin', () => (
    <AdminDashboard addToast={noop} user={{ id: 'u3', name: 'System Admin', role: 'admin' }} />
  )],
];

beforeEach(() => { vi.clearAllMocks(); });

describe('every dashboard offers certificate verification', () => {
  for (const [role, view] of ROLES) {
    it(`is there for ${role}`, async () => {
      const { container } = render(<MemoryRouter>{view()}</MemoryRouter>);

      const link = await screen.findByRole('link', { name: /verify a certificate/i });
      expect(link).toHaveAttribute('href', '/verify');

      /* Not the code-in-the-URL form. Somebody who has a code already does not
         need a button; this is for somebody holding a certificate. */
      expect(link.getAttribute('href')).not.toMatch(/\/verify\/./);

      /* Same slot on all three: the heading row at the top of the content
         column, so the control does not move as the reader changes role. */
      await waitFor(() => {
        const row = container.querySelector('.dashboard-greeting');
        expect(row, `${role} has no heading row to hold it`).not.toBeNull();
        expect(row.contains(link)).toBe(true);
      });
    });
  }

  it('is the same component every time, not three lookalikes', async () => {
    /* The label, the destination and the markup all come from one file. If a
       copy is ever pasted into a dashboard instead, this is what notices: the
       class is the component's own. */
    for (const [role, view] of ROLES) {
      const { container, unmount } = render(<MemoryRouter>{view()}</MemoryRouter>);
      await screen.findByRole('link', { name: /verify a certificate/i });
      expect(container.querySelectorAll('.verify-cert-action'), role).toHaveLength(1);
      unmount();
    }
  });
});
