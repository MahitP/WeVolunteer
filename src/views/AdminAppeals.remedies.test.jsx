import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import AdminAppeals from './AdminAppeals';

/**
 * Somebody who WON their appeal and is still suspended must be visible.
 *
 * ── The worst state the product could be in ──
 *
 * A reviewer decides "reversed", and reinstatement is a separate second action.
 * If they navigate away before pressing it — close the tab, get called away — the
 * appeal is `resolved`, so it drops out of the default `open,reviewing` queue and
 * no screen mentions it again.
 *
 * The student has been told they were right, and is still locked out. Nobody is
 * looking for them, because from every surface in the product the case is closed.
 *
 * The server has computed `pendingRemedies` since appeals shipped, with a long
 * comment saying exactly this. `AdminAppeals` destructured only `appeals` and
 * threw it away — so the guard existed, was correct, and was connected to
 * nothing.
 *
 * ── Why the assertions are about the PERSON ──
 *
 * Not about a count or a CSS class. What has to be true is that a moderator
 * opening this page sees a name they need to act on, above the queue of people
 * still waiting — because everything below is somebody owed an answer, and this
 * is somebody already owed their account back.
 */

const apiMock = vi.hoisted(() => ({ fetchAdminAppeals: vi.fn() }));
vi.mock('../utils/api', () => ({ api: apiMock }));

const REMEDY = {
  id: 'appeal-1',
  user_id: 'user-student-2',
  user_name: 'Priya Patel',
  decided_at: '2026-08-05T10:00:00.000Z',
  suspension_reason: 'Messaging a student after being asked to stop',
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.fetchAdminAppeals.mockResolvedValue({ appeals: [], pendingRemedies: [] });
});

describe('the appeals queue surfaces unreinstated reversals', () => {
  it('names somebody whose appeal was upheld while they are still suspended', async () => {
    apiMock.fetchAdminAppeals.mockResolvedValue({ appeals: [], pendingRemedies: [REMEDY] });

    render(<AdminAppeals />);

    expect(await screen.findByText(/won their appeal and is still suspended/i)).toBeInTheDocument();
    expect(screen.getByText('Priya Patel')).toBeInTheDocument();
  });

  /**
   * Plural wording, because "1 people won their appeals" is the kind of thing
   * that makes a moderator distrust the rest of the screen.
   */
  it('counts more than one correctly', async () => {
    apiMock.fetchAdminAppeals.mockResolvedValue({
      appeals: [],
      pendingRemedies: [REMEDY, { ...REMEDY, id: 'appeal-2', user_name: 'Leo Chen' }],
    });

    render(<AdminAppeals />);

    expect(await screen.findByText(/2 people won their appeals and are still suspended/i))
      .toBeInTheDocument();
    expect(screen.getByText('Leo Chen')).toBeInTheDocument();
  });

  /**
   * And it stays out of the way when there is nothing to say.
   *
   * A standing warning that is usually empty is one people learn to ignore, which
   * would cost exactly the attention this exists to buy.
   */
  it('shows nothing when every reversal has been carried out', async () => {
    render(<AdminAppeals />);

    expect(await screen.findByText(/Inbox zero/i)).toBeInTheDocument();
    expect(screen.queryByText(/still suspended/i)).not.toBeInTheDocument();
  });

  /**
   * A server that has not been updated yet must not crash the page.
   *
   * `pendingRemedies` is absent from older responses, and `undefined.length`
   * would take out the whole appeals queue — trading a missing warning for no
   * moderation at all.
   */
  it('survives a response with no pendingRemedies field', async () => {
    apiMock.fetchAdminAppeals.mockResolvedValue({ appeals: [] });

    render(<AdminAppeals />);

    expect(await screen.findByText(/Inbox zero/i)).toBeInTheDocument();
  });
});
