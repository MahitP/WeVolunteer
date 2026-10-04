import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import AppealInbox from './AppealInbox';

/**
 * The inbox hides itself when empty, which makes the failure path load-bearing.
 *
 * `if (!appeals || appeals.length === 0) return null;` is a deliberate choice —
 * a permanently empty card at the foot of every organization page is furniture.
 * The cost is that "the request failed" and "there is nothing to review" render
 * identically, and the comment on the catch acknowledged this by saying the
 * toast is where the error is reported.
 *
 * No toast was raised. `addToast` was in scope and used by the decide actions
 * either side of it, but the load catch only set the empty state. So a manager
 * whose inbox failed to load saw no card, was told nothing, and had every
 * reason to conclude nobody was waiting on them.
 */
vi.mock('../../utils/api', () => ({
  api: {
    fetchOrganizationAppeals: vi.fn(),
    decideOrganizationAppeal: vi.fn(),
    reportOrganizationAppeal: vi.fn(),
  },
}));

const { api } = await import('../../utils/api');

beforeEach(() => vi.clearAllMocks());

describe('AppealInbox', () => {
  it('reports a failed load instead of silently looking empty', async () => {
    api.fetchOrganizationAppeals.mockRejectedValue(new Error('network down'));
    const addToast = vi.fn();

    const { container } = render(<AppealInbox orgKey="beach-cleanup" addToast={addToast} />);

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    expect(addToast.mock.calls[0][1]).toBe('error');
    /* The card still hides — that part was intentional. What must not happen is
       hiding it AND saying nothing. */
    expect(container).toBeEmptyDOMElement();
  });

  it('says nothing when the inbox is genuinely empty', async () => {
    /* The counterpart: a real empty inbox must not raise an error toast, or the
       fix above becomes "warn on every quiet day". */
    api.fetchOrganizationAppeals.mockResolvedValue({ appeals: [] });
    const addToast = vi.fn();

    const { container } = render(<AppealInbox orgKey="beach-cleanup" addToast={addToast} />);

    await waitFor(() => expect(api.fetchOrganizationAppeals).toHaveBeenCalled());
    expect(addToast).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });
});

/**
 * "Ofc an organizer can also report a student if they're being annoying and
 * spamming them with appeals even tho they clearly don't want the student"
 * (FX-70). Appeals are limited to five in thirty days; past that, or within
 * it, a manager can hand the matter to the moderators from the appeal itself.
 */
describe('reporting appeal spam', () => {
  it('reports from the appeal, with a note the manager can edit', async () => {
    const { screen, fireEvent, within } = await import('@testing-library/react');
    api.fetchOrganizationAppeals.mockResolvedValue({
      appeals: [{
        id: 'ap1', status: 'open', decision: null, statement: 'Please let me back in. Please. Please.',
        createdAt: '2026-09-30T10:00:00.000Z',
        appellant: { name: 'Maya Chen', username: 'maya' },
        ban: { reason: 'Repeated disruption', active: true },
      }],
    });
    api.reportOrganizationAppeal.mockResolvedValue({ reported: true });
    render(<AppealInbox orgKey="beach-cleanup" addToast={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Report Maya Chen' }));
    const dialog = screen.getByRole('dialog');
    const note = within(dialog).getByLabelText(/What is happening/);
    expect(note.value).toMatch(/appeals/i);
    fireEvent.change(note, { target: { value: 'Five appeals this week.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(api.reportOrganizationAppeal)
      .toHaveBeenCalledWith('beach-cleanup', 'ap1', { description: 'Five appeals this week.' }));
  });
});
