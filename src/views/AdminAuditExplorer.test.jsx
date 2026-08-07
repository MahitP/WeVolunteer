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

const PAGE = (over = {}) => ({ logs: [LOG()], total: 1, totalPages: 1, page: 1, actions: ['ACCOUNT_SUSPENDED'], ...over });

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchAuditLogs.mockResolvedValue(PAGE());
});

describe('AdminAuditExplorer', () => {
  /**
   * The action is shown as a sentence, not as the stored SCREAMING_SNAKE name.
   * A page of `REPORT_EVIDENCE_VIEWED` is a page nobody scans: every row looks
   * like every other row, and the one that matters sits at the same weight as a
   * routine approval. `auditFormat.js` owns the mapping.
   */
  it('renders a row for each audit record, in words', async () => {
    const { container } = render(<AdminAuditExplorer />);
    // Scoped to the list: the same label also names the filter's option, which
    // is correct — both are read by the same person and should agree.
    await screen.findByText('Platform Owner');
    const list = container.querySelector('.audit-list');
    expect(list.textContent).toContain('Account suspended');
    expect(list.textContent).toContain('Priya Patel');
    expect(list.textContent).not.toContain('ACCOUNT_SUSPENDED');
  });

  /**
   * The sentence somebody wrote at the time is the reason the row exists, so it
   * is on the row. The previous design hid it in a modal behind a View button
   * and showed a column of identical action names instead.
   */
  it('shows the details sentence on the row rather than behind a button', async () => {
    render(<AdminAuditExplorer />);
    expect(
      await screen.findByText(/messaging after being asked to stop/i)
    ).toBeInTheDocument();
  });

  /**
   * Date AND time. The old column used `toLocaleDateString()` alone, so every
   * row of a busy afternoon read the same date and the ordering — the whole
   * point of an append-only log — was invisible.
   */
  it('shows a time, not just a date', async () => {
    render(<AdminAuditExplorer />);
    const when = await screen.findByText(/2026/);
    expect(when.textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it('labels an entry with no target as System rather than leaving it blank', async () => {
    api.fetchAuditLogs.mockResolvedValue(PAGE({
      logs: [LOG({ target_user_id: null, target_user_name: null })],
    }));
    render(<AdminAuditExplorer />);
    expect(await screen.findByText(/no one in particular/i)).toBeInTheDocument();
  });

  it('shows an empty state rather than a bare table when nothing matches', async () => {
    api.fetchAuditLogs.mockResolvedValue(PAGE({ logs: [], total: 0, totalPages: 0 }));
    render(<AdminAuditExplorer />);
    expect(await screen.findByText(/nothing matches those filters/i)).toBeInTheDocument();
  });

  /**
   * The filter's options come from the server, derived from the trail itself.
   *
   * The client used to carry a hand-written list that had drifted: it offered
   * `ORGANIZER_APPROVED` and `ORGANIZER_DENIED` when the real actions are
   * `APPROVE_ORGANIZER` and `DENY_ORGANIZER`, so those two filters could only
   * ever return nothing, and it omitted most of what the table contains. On an
   * accountability surface a filter that silently returns nothing says "this
   * never happened" when the truth is "nobody writes that string".
   */
  it('offers only actions the trail actually contains', async () => {
    api.fetchAuditLogs.mockResolvedValue(PAGE({
      actions: ['ACCOUNT_SUSPENDED', 'APPROVE_ORGANIZER'],
    }));
    render(<AdminAuditExplorer />);

    const select = await screen.findByLabelText(/^action$/i);
    const options = [...select.querySelectorAll('option')].map((o) => o.value);
    expect(options).toEqual(['', 'ACCOUNT_SUSPENDED', 'APPROVE_ORGANIZER']);
    // Offered in words, like the rows.
    expect(screen.getByRole('option', { name: 'Organizer approved' })).toBeInTheDocument();
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

    const box = screen.getByLabelText(/search the record/i);
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

    fireEvent.change(screen.getByLabelText(/search the record/i), { target: { value: 'SEARCHABLE' } });
    fireEvent.submit(screen.getByLabelText(/search the record/i).closest('form'));

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
