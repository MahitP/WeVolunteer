import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import ReportModal from './ReportModal';
import ConversationReportModal from './messages/ReportModal';
import { api } from '../utils/api';
import { CATEGORY_VALUES, categoriesForTarget } from '../moderation';

/**
 * The contract between the report dialogs and the reporting endpoint.
 *
 * ── Why this file exists ──
 *
 * Every bug this surface has had was a contract bug, and none of them was
 * visible from either side alone:
 *
 *   • `messages/ReportModal` offered `spam · harassment · inappropriate · other`
 *     against a server accepting `inappropriate · spam · safety · other`. The
 *     option a student is most likely to reach for was refused with a 400 every
 *     time, and the only error handling was `console.error`, so they pressed
 *     Submit, saw the button come back, and were told nothing.
 *   • `ReportModal` sent free prose where the unified model expected a category.
 *     The server maps prose onto `other` rather than refusing it, so nothing
 *     looked broken — which is exactly why nobody noticed that the eighteen-
 *     category taxonomy, and the priority derived from it, were unreachable from
 *     the product.
 *
 * Both were invisible to the server tests, which sent valid payloads because
 * they were written against the server. So these assertions are deliberately
 * written from the CLIENT's side: what the dialog puts on the wire, checked
 * against the taxonomy the server validates against — the same module, imported,
 * so the two cannot drift again.
 */

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

const noop = () => {};

/** The single call the dialog is supposed to make, captured. */
function captureSubmitReport() {
  return vi.spyOn(api, 'submitReport').mockResolvedValue({ success: true, reportId: 'rep_1' });
}
function captureReportConversation() {
  return vi.spyOn(api, 'reportConversation').mockResolvedValue({ success: true, reportId: 'rep_1' });
}

const chooseCategory = (value) =>
  fireEvent.change(screen.getByLabelText(/what is (wrong|happening)/i), { target: { value } });

describe('ReportModal offers the real taxonomy', () => {
  it('offers only categories the server will accept', () => {
    render(<ReportModal targetType="comment" targetId="cm-1" onClose={noop} addToast={noop} />);

    const offered = [...screen.getByLabelText(/what is wrong/i).querySelectorAll('option')]
      .map(o => o.value)
      .filter(Boolean);

    expect(offered.length, 'no categories offered at all').toBeGreaterThan(0);
    for (const value of offered) {
      expect(CATEGORY_VALUES, `${value} is not a category the server knows`).toContain(value);
    }
  });

  /**
   * Eighteen options in one flat list is not something anybody reads, least of
   * all somebody upset enough to be filing a report.
   */
  it('groups the options under headings', () => {
    render(<ReportModal targetType="comment" targetId="cm-1" onClose={noop} addToast={noop} />);
    const groups = screen.getByLabelText(/what is wrong/i).querySelectorAll('optgroup');
    expect(groups.length).toBeGreaterThan(1);
  });

  /**
   * The filter is presentation only — the server accepts any valid category for
   * any target — but the offer should still make sense for what is on screen.
   */
  it('narrows the offer to what can apply to the target', () => {
    const { unmount } = render(
      <ReportModal targetType="certificate" targetId="WEV-A2B3-C4D5" onClose={noop} addToast={noop} />
    );
    const certOptions = [...screen.getByLabelText(/what is wrong/i).querySelectorAll('option')]
      .map(o => o.value).filter(Boolean);
    expect(certOptions).toEqual(categoriesForTarget('certificate').map(c => c.value));
    unmount();

    render(<ReportModal targetType="message" targetId="m-1" onClose={noop} addToast={noop} />);
    const messageOptions = [...screen.getByLabelText(/what is wrong/i).querySelectorAll('option')]
      .map(o => o.value).filter(Boolean);
    expect(messageOptions.length).toBeGreaterThan(certOptions.length);
  });

  it('always leaves a route to “something else”, so nothing is unreportable', () => {
    for (const targetType of ['event', 'comment', 'announcement', 'user', 'certificate', 'message']) {
      const { unmount } = render(
        <ReportModal targetType={targetType} targetId="t-1" onClose={noop} addToast={noop} />
      );
      const values = [...screen.getByLabelText(/what is wrong/i).querySelectorAll('option')]
        .map(o => o.value);
      expect(values, `${targetType} cannot reach 'other'`).toContain('other');
      unmount();
    }
  });
});

describe('ReportModal sends what the endpoint expects', () => {
  it('puts a taxonomy value on the wire, not prose', async () => {
    const spy = captureSubmitReport();
    render(<ReportModal targetType="comment" targetId="cm-1" onClose={noop} addToast={noop} />);

    chooseCategory('bullying_or_harassment');
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const payload = spy.mock.calls[0][0];
    expect(payload.targetType).toBe('comment');
    expect(payload.targetId).toBe('cm-1');
    expect(CATEGORY_VALUES, 'the dialog sent something the server would reject')
      .toContain(payload.reason);
    expect(payload.reason).toBe('bullying_or_harassment');
  });

  it('preserves what the student typed, as the description', async () => {
    const spy = captureSubmitReport();
    render(<ReportModal targetType="event" targetId="ev-1" onClose={noop} addToast={noop} />);

    chooseCategory('spam_or_advertising');
    fireEvent.change(screen.getByLabelText(/anything else/i), {
      target: { value: 'They are advertising a paid course, not volunteering.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0].details).toBe('They are advertising a paid course, not volunteering.');
  });

  /**
   * The category is required and the description is not, deliberately that way
   * round. Youth Safety: "You do not need proof. You do not need to be sure."
   * Requiring prose is a barrier at the exact moment it costs the most.
   */
  it('files with a category alone, and never sends an empty description', async () => {
    const spy = captureSubmitReport();
    render(<ReportModal targetType="event" targetId="ev-1" onClose={noop} addToast={noop} />);

    chooseCategory('something_feels_wrong');
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0].details).toBeUndefined();
  });

  it('will not submit with no category chosen', async () => {
    const spy = captureSubmitReport();
    render(<ReportModal targetType="event" targetId="ev-1" onClose={noop} addToast={noop} />);

    expect(screen.getByRole('button', { name: /send report/i })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText(/what is wrong/i).closest('form'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * A failure is shown inline AND announced. Previously a failure produced only a
   * transient toast, so somebody who looked away learned nothing and pressed the
   * button again.
   */
  it('announces a refusal instead of closing', async () => {
    vi.spyOn(api, 'submitReport').mockRejectedValue(new Error('You cannot report yourself.'));
    const onClose = vi.fn();
    render(<ReportModal targetType="user" targetId="u-1" onClose={onClose} addToast={noop} />);

    chooseCategory('other');
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/cannot report yourself/i));
    expect(onClose, 'the dialog closed on a refusal the user could act on').not.toHaveBeenCalled();
  });

  /** The safety net has to be reachable from the dialog itself, not a policy page. */
  it('shows the emergency numbers, not "contact your school"', () => {
    render(<ReportModal targetType="event" targetId="ev-1" onClose={noop} addToast={noop} />);
    expect(screen.getByText(/911/)).toBeInTheDocument();
    expect(screen.getByText(/NJ-ABUSE/)).toBeInTheDocument();
  });
});

describe('the conversation report dialog', () => {
  it('offers taxonomy categories, not the four retired legacy reasons', () => {
    render(<ConversationReportModal conversationId="conv-1" onClose={noop} />);

    const offered = [...screen.getByLabelText(/what is happening/i).querySelectorAll('option')]
      .map(o => o.value).filter(Boolean);

    for (const value of offered) {
      expect(CATEGORY_VALUES, `${value} is not a category the server knows`).toContain(value);
    }
    // The exact regression: "Harassment or bullying" was offered and refused.
    expect(offered).toContain('bullying_or_harassment');
    // A conversation is where the safety categories belong, so it offers them all.
    expect(offered).toEqual(CATEGORY_VALUES);
  });

  it('sends the category and the details to the conversation route', async () => {
    const spy = captureReportConversation();
    render(<ConversationReportModal conversationId="conv-1" onClose={noop} />);

    fireEvent.change(screen.getByLabelText(/what is happening/i), {
      target: { value: 'asked_to_meet_alone' },
    });
    fireEvent.change(screen.getByLabelText(/anything else/i), {
      target: { value: 'He keeps asking where I live.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith('conv-1', 'asked_to_meet_alone', 'He keeps asking where I live.');
  });

  /**
   * The failure that made the old dialog unusable: a 400 re-enabled the button
   * and said nothing, so a student reporting harassment had no way to know their
   * report was never filed.
   */
  it('shows a refusal rather than silently re-enabling the button', async () => {
    vi.spyOn(api, 'reportConversation').mockRejectedValue(new Error('Choose a reason for the report.'));
    render(<ConversationReportModal conversationId="conv-1" onClose={noop} />);

    fireEvent.change(screen.getByLabelText(/what is happening/i), {
      target: { value: 'bullying_or_harassment' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/choose a reason/i));
  });

  it('confirms success rather than leaving the form open', async () => {
    captureReportConversation();
    render(<ConversationReportModal conversationId="conv-1" onClose={noop} />);

    fireEvent.change(screen.getByLabelText(/what is happening/i), {
      target: { value: 'something_feels_wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(screen.getByText(/report sent/i)).toBeInTheDocument());
  });
});

describe('both dialogs are usable by somebody who is upset', () => {
  it('labels every control, so a screen reader announces what it is', () => {
    const { unmount } = render(
      <ReportModal targetType="event" targetId="ev-1" onClose={noop} addToast={noop} />
    );
    expect(screen.getByLabelText(/what is wrong/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/anything else/i)).toBeInTheDocument();
    unmount();

    render(<ConversationReportModal conversationId="conv-1" onClose={noop} />);
    expect(screen.getByLabelText(/what is happening/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/anything else/i)).toBeInTheDocument();
  });

  /**
   * Both go through the shared `Modal`, which is what supplies Escape, focus
   * containment, focus restore and scroll lock. Asserted here because both were
   * hand-rolled overlays with none of it, on a surface reachable by somebody in
   * distress who may be on a keyboard or a screen reader.
   */
  it('renders as a real dialog', () => {
    const { unmount } = render(
      <ReportModal targetType="event" targetId="ev-1" onClose={noop} addToast={noop} />
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    unmount();

    render(<ConversationReportModal conversationId="conv-1" onClose={noop} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });
});
