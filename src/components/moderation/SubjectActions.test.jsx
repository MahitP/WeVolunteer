/**
 * Acting on the person a report is about.
 *
 * ── What this file is responsible for ──
 *
 * Not authorization: `server/routes.warning.test.js` and
 * `server/routes.suspension.test.js` prove both endpoints refuse the roles and the
 * targets they must, and the server re-checks every capability regardless of what
 * renders here.
 *
 * This covers the three things only the client can get wrong:
 *
 *   1. A control is not offered to somebody who would be 403'd — the "UI shows a
 *      button the API rejects" drift `src/authz.js` exists to prevent.
 *   2. Nothing is offered when there is no person to act on. The server refuses to
 *      fall back to the reporter, and a UI that invented a subject would point a
 *      "warn them" button at the child who filed the report.
 *   3. The end date means the end of the chosen day. A date input yields
 *      `YYYY-MM-DD`, which `new Date()` reads as UTC midnight — sending that
 *      verbatim ends the suspension at the START of the chosen day and quietly
 *      cuts it a day short.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SubjectActions from './SubjectActions';
import { api } from '../../utils/api';

vi.mock('../../utils/api');

const SUBJECT = {
  id: 'u_org', name: 'Chris Vale', role: 'organizer',
  accountStatus: 'active', suspendedUntil: null,
};

const ADMIN = { id: 'u_admin', role: 'admin' };
/** Can tell somebody to stop; cannot lock them out. The grant the split exists for. */
const WARN_ONLY = { id: 'u_helper', role: 'student', grants: ['user.warn'] };
const STUDENT = { id: 'u_stu', role: 'student' };

const REASON = 'Kept messaging a student after being asked to stop.';

beforeEach(() => {
  vi.clearAllMocks();
  api.warnUser.mockResolvedValue({ success: true });
  api.suspendUser.mockResolvedValue({ success: true });
});

const show = (props = {}) => render(
  <SubjectActions subject={SUBJECT} user={ADMIN} addToast={vi.fn()} {...props} />
);

describe('what is offered, to whom', () => {
  it('offers both actions to an administrator', () => {
    show();
    expect(screen.getByRole('button', { name: /Warn them/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Suspend/ })).toBeInTheDocument();
  });

  it('offers only the warning to somebody who may not suspend', () => {
    show({ user: WARN_ONLY });
    expect(screen.getByRole('button', { name: /Warn them/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Suspend/ })).not.toBeInTheDocument();
  });

  it('renders nothing at all for somebody who holds neither capability', () => {
    const { container } = show({ user: STUDENT });
    expect(container).toBeEmptyDOMElement();
  });

  /**
   * The case that protects the reporter. `subject` is null for a report about a
   * thing rather than a person, or whose author is gone.
   */
  it('renders nothing when there is no person to act on', () => {
    const { container } = show({ subject: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('does not offer to suspend an already-suspended account, and says why', () => {
    show({ subject: { ...SUBJECT, accountStatus: 'suspended' } });
    expect(screen.getByText(/already suspended/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Suspend$/ })).not.toBeInTheDocument();
  });
});

describe('issuing a warning', () => {
  it('sends the reason and reports it', async () => {
    const addToast = vi.fn();
    show({ addToast });
    fireEvent.click(screen.getByRole('button', { name: /Warn them/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: REASON } });
    fireEvent.click(screen.getByRole('button', { name: /Issue the warning/ }));

    await waitFor(() => expect(api.warnUser).toHaveBeenCalledWith('u_org', REASON));
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('Chris Vale'), 'success');
  });

  /** The text is shown to the person verbatim, so the form has to say so. */
  it('tells the moderator the person reads these words', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /Warn them/ }));
    expect(screen.getByText(/Chris Vale is shown these words/)).toBeInTheDocument();
  });

  it('refuses a reason too short to act on, without calling the API', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /Warn them/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'stop' } });

    // The submit is disabled, so the refusal happens before anything is sent.
    expect(screen.getByRole('button', { name: /Issue the warning/ })).toBeDisabled();
    expect(api.warnUser).not.toHaveBeenCalled();
  });

  it('keeps the typed reason when the server refuses', async () => {
    api.warnUser.mockRejectedValue(new Error('Only a super administrator can do that.'));
    show();
    fireEvent.click(screen.getByRole('button', { name: /Warn them/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: REASON } });
    fireEvent.click(screen.getByRole('button', { name: /Issue the warning/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('super administrator');
    expect(screen.getByRole('textbox')).toHaveValue(REASON);
  });
});

describe('suspending', () => {
  const openSuspend = () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /Suspend/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: REASON } });
  };

  it('sends no end date when none is chosen, and says that means indefinite', async () => {
    openSuspend();
    expect(screen.getByText(/no end date/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Suspend this account/ }));

    await waitFor(() => expect(api.suspendUser).toHaveBeenCalledWith('u_org', {
      reason: REASON, until: null,
    }));
  });

  /**
   * The off-by-a-day. "Until the 14th" has to include the 14th; sending the raw
   * `YYYY-MM-DD` would end it at the start of that day.
   */
  it('ends a dated suspension at the end of the chosen day, not the start', async () => {
    openSuspend();
    fireEvent.change(screen.getByLabelText(/Until/), { target: { value: '2026-09-14' } });
    fireEvent.click(screen.getByRole('button', { name: /Suspend this account/ }));

    await waitFor(() => expect(api.suspendUser).toHaveBeenCalled());
    const { until } = api.suspendUser.mock.calls[0][1];
    const sent = new Date(until);
    expect(sent.getFullYear()).toBe(2026);
    expect(sent.getMonth()).toBe(8);          // September, zero-indexed
    expect(sent.getDate()).toBe(14);
    expect(sent.getHours()).toBe(23);
  });

  it('says an appeal is reviewed against the reason', () => {
    openSuspend();
    expect(screen.getByText(/appeal is reviewed against/)).toBeInTheDocument();
  });

  it('refreshes the caller once the suspension lands', async () => {
    const onDone = vi.fn();
    render(<SubjectActions subject={SUBJECT} user={ADMIN} addToast={vi.fn()} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: /Suspend/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: REASON } });
    fireEvent.click(screen.getByRole('button', { name: /Suspend this account/ }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});

/**
 * Opening a moderation conversation.
 *
 * Offered on `report.resolve`, matching the endpoint, NOT on `message.send`.
 * Participating in a conversation is one thing; picking an arbitrary person by id
 * to start one with is a moderation power, and an organizer holds `message.send`.
 */
describe('messaging the person', () => {
  beforeEach(() => {
    api.resolveAdminConversation.mockResolvedValue({ conversation: { id: 'conv_9' } });
  });

  it('is offered to a moderator, before the enforcement actions', () => {
    show();
    const labels = screen.getAllByRole('button').map(b => b.textContent);
    expect(labels[0]).toMatch(/Message them/);
  });

  it('is not offered to somebody who only holds message.send', () => {
    show({ user: { id: 'u_org', role: 'organizer' } });
    expect(screen.queryByRole('button', { name: /Message them/ })).not.toBeInTheDocument();
  });

  it('opens the thread and navigates to it', async () => {
    const assign = vi.fn();
    // jsdom's window.location is not assignable; replace just what is used.
    const original = window.location;
    delete window.location;
    window.location = { ...original, assign };

    try {
      show();
      fireEvent.click(screen.getByRole('button', { name: /Message them/ }));

      await waitFor(() => expect(api.resolveAdminConversation).toHaveBeenCalledWith('u_org'));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/messages?conversation=conv_9'));
    } finally {
      window.location = original;
    }
  });

  it('shows a failure rather than silently doing nothing', async () => {
    api.resolveAdminConversation.mockRejectedValue(new Error('Person not found'));
    show();
    fireEvent.click(screen.getByRole('button', { name: /Message them/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Person not found');
  });
});
