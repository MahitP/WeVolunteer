import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
