/**
 * The moderation evidence viewer.
 *
 * ── What this file is responsible for ──
 *
 * Not authorization. `server/authz.matrix.test.js` proves both endpoints refuse
 * the roles that must not reach them, and `server/routes.moderationQueue.test.js`
 * proves the server logs the disclosure and returns frozen bodies. Those are
 * server claims and they fail for server reasons.
 *
 * This file covers the two promises the CLIENT is responsible for, because
 * nothing server-side can hold either one:
 *
 *   1. The evidence is not fetched until a moderator asks for it. The server
 *      writes an audit row and a durable `evidence_viewed` row on every call, so
 *      a component that prefetched would manufacture a record of a disclosure
 *      that never happened — and a trail that logs reads nobody performed is
 *      worse than no trail, because it is unusable in the direction it exists to
 *      serve.
 *   2. A moderator without `report.evidence.read` is TOLD the evidence exists
 *      rather than shown an absence. Hiding the control on a safety surface reads
 *      as "there is nothing here", which is the one thing it must not say.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ReportDetail from './ReportDetail';
import { api } from '../../utils/api';

vi.mock('../../utils/api');

const ADMIN = { id: 'u_admin', role: 'admin' };
/** Holds `report.resolve` by grant but not `report.evidence.read` — the
 *  triage-only helper the capability split exists to make possible. */
const TRIAGE_ONLY = { id: 'u_helper', role: 'student', grants: ['report.resolve'] };

const REPORT = (over = {}) => ({
  id: 'rep_1',
  status: 'reviewing',
  priority: 'urgent',
  category: 'harassment',
  target_type: 'conversation',
  target_label: 'Softball Tournament Snack Shack',
  description: 'They kept messaging me after I asked them to stop.',
  reporter_name: 'Maya Torres',
  reporter_email: 'maya@school.test',
  created_at: '2026-08-01T15:04:00.000Z',
  evidence_count: 2,
  resolution: null,
  ...over,
});

const HISTORY = [
  {
    id: 'act_1', action: 'filed', actor_name: 'Maya Torres',
    created_at: '2026-08-01T15:04:00.000Z',
  },
  {
    id: 'act_2', action: 'status_changed', actor_name: 'Dana Reed',
    old_status: 'open', new_status: 'reviewing',
    created_at: '2026-08-02T09:12:00.000Z',
  },
];

const MESSAGES = [
  {
    message_id: 'm1', sender_id: 'u_org', sender_name: 'Chris Vale',
    body: 'answer me',
    created_at: '2026-07-30T18:00:00.000Z',
    captured_at: '2026-08-01T15:04:00.000Z',
  },
  {
    message_id: 'm2', sender_id: 'u_stu', sender_name: 'Maya Torres',
    body: 'please stop',
    created_at: '2026-07-30T18:02:00.000Z',
    captured_at: '2026-08-01T15:04:00.000Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchReport.mockResolvedValue({ report: REPORT(), history: HISTORY });
  api.fetchReportEvidence.mockResolvedValue({
    reportId: 'rep_1', status: 'reviewing', messages: MESSAGES,
  });
});

const open = (user = ADMIN, props = {}) => render(
  <ReportDetail reportId="rep_1" user={user} onClose={() => {}} {...props} />
);

describe('the report record', () => {
  it('shows what the report is and what the reporter said', async () => {
    open();
    expect(await screen.findByText(/Softball Tournament Snack Shack/)).toBeInTheDocument();
    expect(screen.getByText(/kept messaging me/)).toBeInTheDocument();
    // Named twice, correctly: once as the reporter, once as the actor on the
    // `filed` history row. Asserted as "at least once" rather than pinned to one,
    // because which surfaces name them is a layout question, not a promise.
    expect(screen.getAllByText('Maya Torres').length).toBeGreaterThan(0);
    expect(screen.getByText(/maya@school.test/)).toBeInTheDocument();
  });

  it('shows the action history in order, naming who acted', async () => {
    open();
    expect(await screen.findByText('Report filed')).toBeInTheDocument();
    expect(screen.getByText('Status changed')).toBeInTheDocument();
    expect(screen.getByText(/Dana Reed · open → reviewing/)).toBeInTheDocument();
  });

  it('surfaces a load failure rather than an empty dialog', async () => {
    api.fetchReport.mockRejectedValue(new Error('Report not found'));
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('Report not found');
  });
});

describe('reading preserved evidence', () => {
  /**
   * The load-bearing case. If this ever fails, every moderator who opened a
   * report to read its description was recorded as having read the student's
   * private messages.
   */
  it('does not fetch the evidence when the report is opened', async () => {
    open();
    await screen.findByText(/Softball Tournament Snack Shack/);

    expect(api.fetchReportEvidence).not.toHaveBeenCalled();
    expect(screen.queryByText('answer me')).not.toBeInTheDocument();
  });

  it('warns that the read is recorded, before it is pressed', async () => {
    open();
    expect(await screen.findByText(/recorded permanently against this report/))
      .toBeInTheDocument();
  });

  /**
   * The privacy property, asserted on the client side.
   *
   * Reading a child's preserved messages is the most invasive read on this
   * platform, and until the v1.2c review it was also the cheapest: a session was
   * enough, while downloading your OWN data archive required a fresh
   * verification. The server enforces it (`requireAAL2('report.evidence')` plus a
   * bound `spendChallenge`); this asserts the client actually asks through that
   * path, because a component that called the endpoint directly would get a 403
   * the moderator could not clear and the feature would look broken.
   */
  it('asks for the evidence through the step-up, bound to this report', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Open preserved messages/ }));

    await waitFor(() => expect(api.fetchReportEvidence).toHaveBeenCalled());
    const [, headers] = api.fetchReportEvidence.mock.calls[0];
    expect(headers, 'the call must carry the step-up headers slot').toBeDefined();
  });

  it('fetches and shows the frozen bodies once asked', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Open preserved messages/ }));

    /**
     * A headers argument now, because the read goes through a step-up.
     *
     * `run()` attempts the call first and only prompts if the server refuses
     * with `reauth_required`, so the happy path here carries an empty headers
     * object — and that argument existing is what proves the call is wired
     * through the step-up rather than around it.
     */
    await waitFor(() => expect(api.fetchReportEvidence).toHaveBeenCalledWith('rep_1', {}));
    expect(await screen.findByText('answer me')).toBeInTheDocument();
    expect(screen.getByText('please stop')).toBeInTheDocument();
    expect(screen.getByText('Chris Vale')).toBeInTheDocument();
  });

  /**
   * Both timestamps, because they are two different facts: when the message was
   * sent, and when this report froze a copy of it. The gap between them is what
   * makes "preserved copy" mean something.
   */
  it('shows when each message was sent and when it was preserved', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Open preserved messages/ }));
    await screen.findByText('answer me');

    expect(screen.getAllByText(/Sent .* · preserved /).length).toBe(2);
  });

  it('says the copies cannot be edited or deleted by anyone', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Open preserved messages/ }));

    expect(await screen.findByText(/cannot be\s+edited or deleted by anyone/))
      .toBeInTheDocument();
  });

  /** There is no control that could mutate evidence, and no endpoint behind one. */
  it('offers no way to edit or delete a preserved message', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Open preserved messages/ }));
    await screen.findByText('answer me');

    for (const label of [/edit/i, /delete/i, /remove/i, /redact/i]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('refetches the report so the timeline shows the read it just caused', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Open preserved messages/ }));

    // Once on mount, once after the disclosure is on the record.
    await waitFor(() => expect(api.fetchReport).toHaveBeenCalledTimes(2));
  });

  it('keeps the dialog usable when the evidence read is refused', async () => {
    api.fetchReportEvidence.mockRejectedValue(new Error('Forbidden'));
    const addToast = vi.fn();
    open(ADMIN, { addToast });

    fireEvent.click(await screen.findByRole('button', { name: /Open preserved messages/ }));

    expect(await screen.findByText('Forbidden')).toBeInTheDocument();
    // The record is still readable — a refused disclosure must not take the
    // report away from the moderator who still has to decide it.
    expect(screen.getByText(/kept messaging me/)).toBeInTheDocument();
    expect(addToast).toHaveBeenCalled();
  });
});

describe('a moderator who may not read messages', () => {
  it('is told the evidence exists and who can read it', async () => {
    open(TRIAGE_ONLY);

    expect(await screen.findByText(/2 messages were/)).toBeInTheDocument();
    expect(screen.getByText(/needs the evidence permission/)).toBeInTheDocument();
  });

  it('is offered no button that would 403', async () => {
    open(TRIAGE_ONLY);
    await screen.findByText(/2 messages were/);

    expect(screen.queryByRole('button', { name: /Open preserved messages/ }))
      .not.toBeInTheDocument();
    expect(api.fetchReportEvidence).not.toHaveBeenCalled();
  });
});

describe('a report with nothing preserved', () => {
  it('says so rather than offering a button that returns an empty list', async () => {
    api.fetchReport.mockResolvedValue({
      report: REPORT({ evidence_count: 0, target_type: 'event' }), history: HISTORY,
    });
    open();

    expect(await screen.findByText(/Nothing was preserved with this report/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open preserved messages/ }))
      .not.toBeInTheDocument();
  });
});
