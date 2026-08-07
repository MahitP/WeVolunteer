import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import AdminDashboard from './AdminDashboard';

/**
 * The Moderation Center, actually rendered.
 *
 * ── Why this did not exist, and why that mattered ──
 *
 * `AdminDashboard` is stubbed in every test that would otherwise mount it —
 * `App.shellByRole.test.jsx` replaces it with a `<div data-testid="admin-dash">`
 * so the shell tests stay about the shell. That is the right call for those
 * tests, and the consequence was that the most important administrative page on
 * the platform was never rendered by anything.
 *
 * `AdminDashboard.order.test.jsx` reads the file as TEXT and asserts section
 * order by source position. Useful, and not a render: it cannot see a component
 * that throws, a section that renders empty, or — the thing that actually
 * happened — a thirteen-line block comment sitting on the page as visible prose,
 * because in JSX children position a bare `/* … *\/` block is text.
 *
 * That leak survived the build, the linter, and 3,400 tests. It was found by
 * looking at a screenshot. The global teardown in `setupTests.js` now checks
 * every rendered tree for comment markers — but a global check over rendered
 * output is worth exactly as much as the render coverage underneath it, and here
 * there was none. This file is that coverage.
 *
 * ── Deliberately a smoke test ──
 *
 * It asserts that the page mounts, reaches its loaded state, and shows its
 * sections. It does not re-assert section ORDER — `AdminDashboard.order.test.jsx`
 * owns that and does it better, by source position, without needing data
 * fixtures that would make the ordering incidental to whatever the mock returned.
 */

const REPORT = {
  id: 'rep_1',
  status: 'open',
  category: 'harassment',
  createdAt: '2026-08-06T12:00:00.000Z',
  targetType: 'conversation',
  reporterName: 'Priya Patel',
  reporterEmail: 'priya@example.invalid',
  evidenceCount: 1,
};

/* `vi.mock` is hoisted above every top-level binding, so the factory cannot close
   over a `const` declared here — it has to create the mock itself. `vi.hoisted`
   is the sanctioned way to share it with the tests below. */
const apiMock = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  fetchEvents: vi.fn(),
  fetchAdminStats: vi.fn(),
}));

vi.mock('../utils/api', () => ({ api: apiMock }));

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.fetchEvents.mockResolvedValue([]);
  apiMock.fetchAdminStats.mockResolvedValue(null);
  /* `/api/admin/reports` returns the array directly — `loadData` does
     `setReports(rpts)` with no unwrapping. Getting that shape wrong renders an
     empty queue that still passes a "the page mounted" assertion, which is how a
     smoke test quietly stops testing the thing it was written for. */
  apiMock.apiFetch.mockImplementation((path) => {
    if (path.includes('/organizers/pending')) return Promise.resolve([]);
    if (path.includes('/reports')) return Promise.resolve([REPORT]);
    return Promise.resolve({});
  });
});

const renderDash = () =>
  render(<AdminDashboard addToast={() => {}} user={{ id: 'user-admin', role: 'admin' }} />);

describe('the Moderation Center renders', () => {
  /**
   * The whole point: it mounts without throwing.
   *
   * This is not a trivial assertion for this component. Its own header records
   * that five icons were once used in JSX and never imported, so the page threw
   * `ReferenceError: UserX is not defined` the moment the organizer queue held a
   * single pending request — which meant no organizer could ever be approved, and
   * therefore no organizer could ever post an event. A render test with a
   * non-empty queue is what would have caught it.
   */
  it('mounts and reaches its loaded state', async () => {
    renderDash();
    expect(await screen.findByRole('heading', { name: /^Reports$/i })).toBeInTheDocument();
  });

  it('shows the organizer request queue', async () => {
    renderDash();
    expect(await screen.findByRole('heading', { name: /Organizer requests/i })).toBeInTheDocument();
  });

  /**
   * The regression, stated where somebody will find it.
   *
   * `setupTests.js` fails ANY test whose rendered output contains a comment
   * marker, so this case is technically redundant with the global teardown. It is
   * here anyway because a global assertion produces a failure message attached to
   * whatever test happened to be running, and a named case is what tells the next
   * person what broke and where to look.
   */
  it('renders no source comment as visible text', async () => {
    const { container } = renderDash();
    await screen.findByRole('heading', { name: /^Reports$/i });

    const text = container.textContent || '';
    for (const marker of ['/*', '*/', 'viewport', '720px']) {
      expect(text, `"${marker}" is engineering prose on an administrator's page`)
        .not.toContain(marker);
    }
  });

  /**
   * A pending organizer in the queue — the exact condition that used to crash the
   * page, and the reason the empty-queue smoke test above is not sufficient on
   * its own.
   */
  it('renders the approve and deny controls when somebody is waiting', async () => {
    apiMock.apiFetch.mockImplementation((path) => {
      if (path.includes('/organizers/pending')) {
        return Promise.resolve([{
          id: 'user-pending', name: 'Robert Miller', email: 'rmiller@example.invalid',
          affiliation: 'SBPL', bio: 'Library Director.', createdAt: '2026-08-06T12:00:00.000Z',
        }]);
      }
      if (path.includes('/reports')) return Promise.resolve([]);
      return Promise.resolve({});
    });

    renderDash();
    expect(await screen.findByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
  });
});
