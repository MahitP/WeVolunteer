/**
 * The Audit Explorer screen.
 *
 * ── What this file is responsible for ──
 *
 * Not authorization. `server/routes.adminCapabilitySplit.test.js` proves an
 * administrator is refused the endpoint, `App.shellByRole.test.jsx` proves the
 * nav entry is hidden from them, and `App.routeTable.test.jsx` proves the route
 * is. Those are separate claims that fail for separate reasons, and none of them
 * says anything about what the screen does once the owner is inside it.
 *
 * This file covers that: that it asks the API the right question, that reading a
 * search box does not turn into one query per keystroke against an unindexed
 * LIKE, and that a failure the reader cannot act on is not described as one they
 * caused.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AdminAuditExplorer from './AdminAuditExplorer';
import { api } from '../utils/api';

vi.mock('../utils/api');

const LOG = (over = {}) => ({
  id: 'audit-1',
  admin_id: 'user-super',
  admin_name: 'Platform Owner',
  action: 'ACCOUNT_SUSPENDED',
  target_user_id: 'user-student-2',
  target_user_name: 'Priya Patel',
  details: 'Suspended indefinitely: messaging after being asked to stop',
  created_at: '2026-08-01T12:00:00.000Z',
  ...over,
});

const PAGE = (over = {}) => ({ logs: [LOG()], total: 1, totalPages: 1, page: 1, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchAuditLogs.mockResolvedValue(PAGE());
});

describe('AdminAuditExplorer', () => {
  it('renders a row for each audit record', async () => {
    render(<AdminAuditExplorer />);
    expect(await screen.findByText('ACCOUNT_SUSPENDED')).toBeInTheDocument();
    expect(screen.getByText('Platform Owner')).toBeInTheDocument();
    expect(screen.getByText('Priya Patel')).toBeInTheDocument();
  });

  it('labels an entry with no target as System rather than leaving it blank', async () => {
    api.fetchAuditLogs.mockResolvedValue(PAGE({
      logs: [LOG({ target_user_id: null, target_user_name: null })],
    }));
    render(<AdminAuditExplorer />);
    expect(await screen.findByText('System')).toBeInTheDocument();
  });

  it('shows an empty state rather than a bare table when nothing matches', async () => {
    api.fetchAuditLogs.mockResolvedValue(PAGE({ logs: [], total: 0, totalPages: 0 }));
    render(<AdminAuditExplorer />);
    expect(await screen.findByText(/no logs found/i)).toBeInTheDocument();
  });

  /**
   * The defect: `filters` was one object, every control wrote into it on change,
   * and the fetch effect depended on the whole object. Typing "SEARCHABLE" into
   * the search box was ten renders, ten state updates and **ten requests**, each
   * one a `details LIKE '%…%'` against a table with no index that can serve it
   * and which only ever grows.
   *
   * Search now applies on submit. The form already had a submit handler, which
   * until this fix was a fourth redundant request rather than the point of the
   * control.
   */
  it('does not issue a request per keystroke while typing a search', async () => {
    render(<AdminAuditExplorer />);
    await waitFor(() => expect(api.fetchAuditLogs).toHaveBeenCalledTimes(1));

    const box = screen.getByLabelText(/search details/i);
    fireEvent.change(box, { target: { value: 'S' } });
    fireEvent.change(box, { target: { value: 'SE' } });
    fireEvent.change(box, { target: { value: 'SEA' } });

    expect(
      api.fetchAuditLogs,
      'typing must not query the audit trail on every character'
    ).toHaveBeenCalledTimes(1);
  });

  it('runs the search when the form is submitted', async () => {
    render(<AdminAuditExplorer />);
    await waitFor(() => expect(api.fetchAuditLogs).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText(/search details/i), { target: { value: 'SEARCHABLE' } });
    fireEvent.submit(screen.getByLabelText(/search details/i).closest('form'));

    await waitFor(() => expect(api.fetchAuditLogs).toHaveBeenCalledTimes(2));
    expect(api.fetchAuditLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: 'SEARCHABLE', page: 1 })
    );
  });

  /**
   * Every failure used to render as "Access Denied".
   *
   * For the one person who holds this capability, that is the least likely
   * explanation and the most alarming one — it says the reader did something
   * wrong when the truthful answer is that the request did not come back. A
   * permission problem and a server problem need different words because they
   * need different next actions.
   */
  it('does not call a server failure a permission problem', async () => {
    api.fetchAuditLogs.mockRejectedValue(new Error('Network request failed'));
    render(<AdminAuditExplorer />);

    expect(await screen.findByText(/couldn.t load the audit trail/i)).toBeInTheDocument();
    expect(screen.queryByText(/access denied/i)).not.toBeInTheDocument();
  });
});
