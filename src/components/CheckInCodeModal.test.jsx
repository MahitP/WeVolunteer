import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../utils/api', () => ({ api: { createCheckinCode: vi.fn() } }));

import { api } from '../utils/api';
import CheckInCodeModal from './CheckInCodeModal';

/**
 * The volunteer's code, and the promise that the countdown on it is decoration.
 */

const application = { id: 'app-1' };
const event = { title: 'Park Cleanup' };
const slot = { name: 'Morning' };

const code = (over = {}) => ({
  token: 'wev1:abcdefg',
  qr: 'data:image/png;base64,AAA',
  displayName: '@leo',
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  ttlSeconds: 300,
  eventTitle: 'Park Cleanup',
  slotName: 'Morning',
  ...over,
});

const renderIt = () => render(
  <CheckInCodeModal application={application} event={event} slot={slot} onClose={vi.fn()} />,
);

describe('CheckInCodeModal', () => {
  beforeEach(() => { vi.mocked(api.createCheckinCode).mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows the volunteer their own handle, the code and when it was made', async () => {
    vi.mocked(api.createCheckinCode).mockResolvedValue(code());
    renderIt();

    expect(await screen.findByText('@leo')).toBeInTheDocument();
    expect(screen.getByText('Generated')).toBeInTheDocument();
    expect(screen.getByText('Expires in')).toBeInTheDocument();
  });

  it('does not describe the QR image to a screen reader', async () => {
    /* Reading out "a QR code" helps nobody, and what it encodes is a random
       string that would be meaningless spoken. The useful facts — whose code,
       when made, how long left — are text beside it. */
    vi.mocked(api.createCheckinCode).mockResolvedValue(code());
    const { baseElement } = renderIt();

    await screen.findByText('@leo');
    const img = baseElement.querySelector('img');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('aria-hidden')).toBe('true');
  });

  /**
   * Expiry is exercised with a code that is already past its `expiresAt`
   * rather than by advancing fake timers.
   *
   * The behaviour under test is "a code the server would refuse is not
   * presented as usable", and that is decided by comparing `expiresAt` to the
   * clock — not by how many times an interval has fired. Driving it through
   * fake timers made the test depend on the interleaving of a timer and a
   * promise, which passed alone and failed in a full run.
   */
  const expiredCode = () => code({ expiresAt: new Date(Date.now() - 1000).toISOString() });

  it('shows an expired code as expired', async () => {
    vi.mocked(api.createCheckinCode).mockResolvedValue(expiredCode());
    renderIt();

    expect(await screen.findByText(/QR code expired/i)).toBeInTheDocument();
  });

  it('offers a new code in place, without leaving the dialog', async () => {
    vi.mocked(api.createCheckinCode).mockResolvedValue(expiredCode());
    renderIt();

    const button = await screen.findByRole('button', { name: /generate a new qr code/i });
    vi.mocked(api.createCheckinCode).mockResolvedValue(code());
    fireEvent.click(button);

    await waitFor(() => expect(api.createCheckinCode).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(await screen.findByText('Generated')).toBeInTheDocument();
  });

  it('stops presenting a code the server would reject', async () => {
    vi.mocked(api.createCheckinCode).mockResolvedValue(expiredCode());
    const { baseElement } = renderIt();

    await screen.findByText(/QR code expired/i);
    /* Showing a QR the server will refuse would send a volunteer to the front
       of a queue with something that cannot work. */
    expect(baseElement.querySelector('img')).toBeNull();
  });

  describe('when there is no code to give', () => {
    it('explains that the shift has not started', async () => {
      const err = new Error('Your code becomes available when the shift starts.');
      err.code = 'checkin_not_started';
      vi.mocked(api.createCheckinCode).mockRejectedValue(err);
      renderIt();

      /* Two matches on purpose: the visible copy, and the live region that
         announces it. A volunteer who cannot see the dialog still hears why
         there is no code. */
      const shown = await screen.findAllByText(/becomes available when the shift starts/i);
      expect(shown).toHaveLength(2);
    });

    it('always names the roster as the other way in', async () => {
      /* Not every volunteer has a phone that works, and the organizer can
         always check somebody in by name. Saying so is the difference between
         a delay and a dead end. */
      vi.mocked(api.createCheckinCode).mockRejectedValue(new Error('nope'));
      renderIt();

      expect(await screen.findByText(/check you in by name/i)).toBeInTheDocument();
    });

    it('announces the refusal rather than only showing it', async () => {
      vi.mocked(api.createCheckinCode).mockRejectedValue(new Error('nope'));
      renderIt();
      expect(await screen.findByRole('alert')).toBeInTheDocument();
    });
  });

  it('carries one live region on the dialog, not inside a branch that unmounts', async () => {
    vi.mocked(api.createCheckinCode).mockResolvedValue(code());
    const { baseElement } = renderIt();
    await screen.findByText('@leo');

    /* The message that matters most — "this has expired" — is announced by an
       element that must not be the one disappearing as it says it. */
    expect(baseElement.querySelectorAll('[role="status"][aria-live="polite"]')).toHaveLength(1);
  });
});
