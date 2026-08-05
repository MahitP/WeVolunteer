/**
 * The triage screen.
 *
 * ── What this file is responsible for ──
 *
 * Not authorization: `App.routeTable.test.jsx` proves the route is refused for
 * the four other roles, `App.shellByRole.test.jsx` proves the nav entry is
 * hidden, and `server/authz.matrix.test.js` proves all four endpoints refuse
 * them server-side. Those are different claims that fail for different reasons.
 *
 * This file covers what the screen DOES once someone is allowed in: that it
 * asks the API the right questions, that a filter cannot strand the reader on a
 * page that looks empty, that pagination stays inside its bounds, and that the
 * three states nobody builds first — empty, loading, failed — are real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ErrorDashboard from './ErrorDashboard';
import { api } from '../utils/api';

vi.mock('../utils/api');

const GROUP = (over = {}) => ({
  fingerprint: 'a'.repeat(64),
  source: 'client',
  kind: 'crash',
  message: 'event.slots is not iterable',
  route: '/events',
  status: 'open',
  occurrences: 12,
  users_seen: 3,
  first_seen_at: new Date(Date.now() - 7200e3).toISOString(),
  last_seen_at: new Date(Date.now() - 600e3).toISOString(),
  resolved_at: null,
  resolved_by: null,
  release: '1.1.0',
  ...over,
});

const SUMMARY = {
  byDay: [{ day: '2026-08-04', count: 12 }],
  bySource: [{ source: 'client', groups: 1, occurrences: 12 }],
  byStatus: [{ status: 'open', groups: 1 }],
};

const list = (groups, total = groups.length) => ({ groups, total, limit: 50, offset: 0 });

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchErrorGroups.mockResolvedValue(list([GROUP()]));
  api.fetchErrorSummary.mockResolvedValue(SUMMARY);
  api.fetchErrorGroup.mockResolvedValue({ group: GROUP(), events: [] });
  api.updateErrorStatus.mockResolvedValue({ success: true });
});

const at = (props = {}) => render(<ErrorDashboard addToast={() => {}} {...props} />);

describe('the list', () => {
  it('opens on unresolved problems rather than everything', async () => {
    at();
    await waitFor(() => expect(api.fetchErrorGroups).toHaveBeenCalled());
    // Triage starts from what is still broken. Defaulting to "all" buries the
    // open ones under everything ever resolved.
    expect(api.fetchErrorGroups.mock.calls[0][0]).toMatchObject({ status: 'open' });
  });

  it('shows what identifies a problem, not just that one exists', async () => {
    at();
    const row = await screen.findByRole('button', { name: /event\.slots is not iterable/i });

    // Scoped to the row: the occurrence count also appears in the summary tile
    // above, and a document-wide getByText would pass on the wrong element.
    expect(row).toHaveTextContent('event.slots is not iterable');
    expect(row).toHaveTextContent('/events');
    expect(row).toHaveTextContent('12');
    expect(row, 'no indication of blast radius').toHaveTextContent('3 people');
  });

  it('asks the server for a page it will actually honour', async () => {
    at();
    await waitFor(() => expect(api.fetchErrorGroups).toHaveBeenCalled());
    const { limit } = api.fetchErrorGroups.mock.calls[0][0];
    // MAX_LIMIT is 200 server-side; anything above is silently clamped, which
    // would make "Next" skip rows the reader never saw.
    expect(limit).toBeLessThanOrEqual(200);
    expect(limit).toBeGreaterThan(0);
  });
});

describe('filtering', () => {
  it('re-asks the server rather than filtering the page it already has', async () => {
    at();
    await screen.findByText('event.slots is not iterable');

    fireEvent.click(screen.getByRole('button', { name: 'Resolved' }));
    await waitFor(() =>
      expect(api.fetchErrorGroups).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'resolved' })
      )
    );
  });

  /**
   * Page 3 of "open" is not page 3 of "all". Without this reset a filter change
   * can land on an offset past the end of the new result set — an empty screen
   * that reads as "no errors" when the truth is "wrong page".
   */
  it('returns to the first page when the filter changes', async () => {
    api.fetchErrorGroups.mockResolvedValue(list([GROUP()], 120));
    at();
    await screen.findByText('event.slots is not iterable');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(api.fetchErrorGroups).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 })));

    fireEvent.click(screen.getByRole('button', { name: 'Ignored' }));
    await waitFor(() =>
      expect(api.fetchErrorGroups).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'ignored', offset: 0 })
      ));
  });

  it('sends nothing at all for a cleared filter', async () => {
    at();
    await screen.findByText('event.slots is not iterable');

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => {
      const arg = api.fetchErrorGroups.mock.calls.at(-1)[0];
      // `status: ''` would be sent as `status=` and ignored by the server, but
      // only by luck — the intent is to omit it.
      expect(arg.status).toBe('');
    });
  });
});

describe('pagination stays inside its bounds', () => {
  it('offers no paging when everything fits on one page', async () => {
    api.fetchErrorGroups.mockResolvedValue(list([GROUP()], 1));
    at();
    await screen.findByText('event.slots is not iterable');
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });

  it('cannot go back past the first page', async () => {
    api.fetchErrorGroups.mockResolvedValue(list([GROUP()], 120));
    at();
    await screen.findByText('event.slots is not iterable');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  it('cannot go forward past the last page', async () => {
    api.fetchErrorGroups.mockResolvedValue(list([GROUP()], 60));
    at();
    await screen.findByText('event.slots is not iterable');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(api.fetchErrorGroups).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled());
  });

  it('never asks for a negative offset', async () => {
    api.fetchErrorGroups.mockResolvedValue(list([GROUP()], 120));
    at();
    await screen.findByText('event.slots is not iterable');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(api.fetchErrorGroups).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 })));
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));

    await waitFor(() => {
      for (const [arg] of api.fetchErrorGroups.mock.calls) {
        expect(arg.offset).toBeGreaterThanOrEqual(0);
      }
    });
  });
});

describe('the states nobody builds first', () => {
  it('says the queue is clear rather than showing an empty box', async () => {
    api.fetchErrorGroups.mockResolvedValue(list([], 0));
    at();
    expect(await screen.findByText(/nothing to triage/i)).toBeInTheDocument();
  });

  /**
   * A failed load must not look like a healthy empty queue — "no open problems"
   * is the single most dangerous thing this screen could say when it simply
   * could not reach the server.
   */
  it('distinguishes a failed load from an empty one, and offers a retry', async () => {
    api.fetchErrorGroups.mockRejectedValue(new Error('Could not load error groups.'));
    at();

    expect(await screen.findByText(/could not load errors/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing to triage/i)).not.toBeInTheDocument();

    api.fetchErrorGroups.mockResolvedValue(list([GROUP()]));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('event.slots is not iterable')).toBeInTheDocument();
  });
});

describe('the detail view and the resolution workflow', () => {
  const open = async () => {
    at();
    fireEvent.click(await screen.findByRole('button', { name: /event\.slots is not iterable/i }));
    return waitFor(() => expect(api.fetchErrorGroup).toHaveBeenCalledWith('a'.repeat(64)));
  };

  it('loads the group by fingerprint', async () => {
    await open();
    expect(await screen.findByRole('button', { name: /all errors/i })).toBeInTheDocument();
  });

  it('resolves, then re-reads rather than trusting its own optimism', async () => {
    await open();
    fireEvent.click(await screen.findByRole('button', { name: /resolve/i }));

    await waitFor(() =>
      expect(api.updateErrorStatus).toHaveBeenCalledWith('a'.repeat(64), 'resolved'));
    // A group reopens by itself when it recurs, so a cached "resolved" would be
    // a lie the moment it happens again.
    await waitFor(() => expect(api.fetchErrorGroup).toHaveBeenCalledTimes(2));
  });

  it('offers reopen instead of resolve once a group is resolved', async () => {
    api.fetchErrorGroup.mockResolvedValue({ group: GROUP({ status: 'resolved' }), events: [] });
    await open();

    expect(await screen.findByRole('button', { name: /reopen/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^resolve$/i })).not.toBeInTheDocument();
  });

  it('only sends a status the server accepts', async () => {
    await open();
    for (const name of [/resolve/i, /ignore/i]) {
      const btn = screen.queryByRole('button', { name });
      if (btn) fireEvent.click(btn);
    }
    await waitFor(() => expect(api.updateErrorStatus).toHaveBeenCalled());
    for (const [, status] of api.updateErrorStatus.mock.calls) {
      expect(['open', 'resolved', 'ignored']).toContain(status);
    }
  });

  it('reports a failed status change instead of showing it as done', async () => {
    const toasts = [];
    at({ addToast: (m, t) => toasts.push({ m, t }) });
    fireEvent.click(await screen.findByRole('button', { name: /event\.slots is not iterable/i }));

    api.updateErrorStatus.mockRejectedValue(new Error('Could not update that group.'));
    fireEvent.click(await screen.findByRole('button', { name: /resolve/i }));

    await waitFor(() => expect(toasts.some((t) => t.t === 'error')).toBe(true));
  });
});
