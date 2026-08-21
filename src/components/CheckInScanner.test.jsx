import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({ api: { scanCheckinCode: vi.fn() } }));

import CheckInScanner from './CheckInScanner';

/**
 * The scanner, and the two things most likely to be broken by a well-meaning
 * edit: its layering on a phone, and the promise that the roster is always
 * still there.
 */

const originalMediaDevices = navigator.mediaDevices;

function grantCamera() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });
  /* jsdom has no media pipeline; play() is a no-op that must not reject. */
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  return { track, stream };
}

function denyCamera(name = 'NotAllowedError') {
  const err = new Error('denied');
  err.name = name;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockRejectedValue(err) },
  });
}

function removeCameraApi() {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
}

afterEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: originalMediaDevices });
  vi.restoreAllMocks();
});

describe('CheckInScanner', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('layering, which is a hard requirement on a phone', () => {
    it('renders through the modal overlay, which sits above the bottom navigation', () => {
      grantCamera();
      const { baseElement } = render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);

      /**
       * The bottom navigation is `position: fixed; z-index: 100`. The modal
       * overlay is 1000, so rendering through it puts the camera above the nav
       * BY CONSTRUCTION rather than by a number somebody chose. Rendering the
       * camera inline inside CheckInView would put it underneath, on every
       * phone.
       */
      expect(baseElement.querySelector('.modal-overlay')).toBeTruthy();
    });

    it('sets no z-index of its own', () => {
      /* A bespoke z-index here is exactly how correct layering regresses: it
         works until something else moves, and then it is a number nobody can
         reason about. */
      grantCamera();
      const { baseElement } = render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);

      for (const el of baseElement.querySelectorAll('[style]')) {
        expect(el.getAttribute('style')).not.toMatch(/z-index/i);
      }
    });

    it('is a proper dialog, so focus and Escape are handled', () => {
      grantCamera();
      render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);

      const dialog = screen.getByRole('dialog');
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.getAttribute('aria-label')).toBeTruthy();
    });

    it('keeps the close and manual-fallback controls outside the camera preview', () => {
      /* Laid out above and below the video rather than over it, so the preview
         can never occlude them at any width. */
      grantCamera();
      const { baseElement } = render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);

      const viewport = baseElement.querySelector('.scanner-viewport');
      expect(viewport).toBeTruthy();
      expect(viewport.querySelector('button')).toBeNull();

      expect(screen.getByRole('button', { name: /check in by name instead/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /close dialog/i })).toBeInTheDocument();
    });
  });

  describe('when the camera cannot be used', () => {
    it('points at the roster when permission is refused', async () => {
      denyCamera('NotAllowedError');
      render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);

      expect(await screen.findByText(/Camera access was denied/i)).toBeInTheDocument();
      expect(screen.getByText(/manual check-in/i)).toBeInTheDocument();
    });

    it('says so when the device has no camera', async () => {
      denyCamera('NotFoundError');
      render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);
      expect(await screen.findByText(/No camera on this device/i)).toBeInTheDocument();
    });

    it('says so when another app is holding the camera', async () => {
      denyCamera('NotReadableError');
      render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);
      expect(await screen.findByText(/being used by another app/i)).toBeInTheDocument();
    });

    it('says so when the browser has no camera API at all', async () => {
      removeCameraApi();
      render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);
      expect(await screen.findByText(/cannot open the camera|secure connection/i)).toBeInTheDocument();
    });

    it('still offers the roster when the camera has failed', async () => {
      /* The whole point. A broken camera must never be a dead end. */
      denyCamera();
      render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);
      await screen.findByText(/Camera access was denied/i);
      expect(screen.getByRole('button', { name: /check in by name instead/i })).toBeInTheDocument();
    });

    it('announces the failure rather than only showing it', async () => {
      denyCamera();
      render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);
      expect(await screen.findByRole('alert')).toBeInTheDocument();
    });
  });

  describe('the camera stream', () => {
    it('stops every track when the scanner unmounts', async () => {
      const { track } = grantCamera();
      const { unmount } = render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);

      await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
      unmount();

      /* A MediaStream left running keeps the camera light on, which reads to a
         volunteer as being filmed. */
      await waitFor(() => expect(track.stop).toHaveBeenCalled());
    });

    it('asks for the rear camera, which is the one pointed at a volunteer', async () => {
      grantCamera();
      render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);

      await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(
        expect.objectContaining({ video: { facingMode: 'environment' }, audio: false }),
      ));
    });
  });

  describe('what the camera resolves, before anything is sent', () => {
    /**
     * A venue is full of QR codes that are not check-in codes — a wifi card
     * taped to the wall, a poster, the sticker on a laptop lid. Every one of
     * them used to be a round trip and a rate-limit unit spent to be told 422,
     * because the `wev1:` prefix existed and nothing read it. Pointed at a
     * noticeboard, a scanner could burn its whole burst allowance without a
     * single volunteer being checked in.
     *
     * Driven through `BarcodeDetector` because that is the path a real Android
     * scanner takes and it is the one that can be stubbed honestly — the jsQR
     * branch decodes pixels jsdom cannot produce.
     */
    function decodes(rawValue) {
      window.BarcodeDetector = class {
        // eslint-disable-next-line class-methods-use-this
        async detect() { return rawValue === null ? [] : [{ rawValue }]; }
      };
      /* jsdom reports readyState 0 forever; the loop skips anything below 4. */
      Object.defineProperty(window.HTMLMediaElement.prototype, 'readyState', {
        configurable: true,
        get: () => 4,
      });
    }

    afterEach(() => { delete window.BarcodeDetector; });

    it('sends a code that carries the prefix', async () => {
      const { api } = await import('../utils/api');
      api.scanCheckinCode.mockResolvedValue({ volunteer: { name: 'Leo Chen' }, slot: { name: 'Setup' } });
      grantCamera();
      decodes('wev1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);

      await waitFor(() => expect(api.scanCheckinCode).toHaveBeenCalledWith(
        'e1', 'wev1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ));
    });

    it('never posts a wifi QR', async () => {
      const { api } = await import('../utils/api');
      grantCamera();
      decodes('WIFI:S=SouthBrunswickGuest;T=WPA;P=hunter2;;');

      render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);

      /* Rendered twice by design — the visible card and the sr-only live
         region — so this asserts presence, not uniqueness. */
      await screen.findAllByText(/isn't a WeVolunteer check-in code/);
      expect(api.scanCheckinCode).not.toHaveBeenCalled();
    });

    it('never posts a plain URL from a poster', async () => {
      const { api } = await import('../utils/api');
      grantCamera();
      decodes('https://example.org/some-poster');

      render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);

      /* Rendered twice by design — the visible card and the sr-only live
         region — so this asserts presence, not uniqueness. */
      await screen.findAllByText(/isn't a WeVolunteer check-in code/);
      expect(api.scanCheckinCode).not.toHaveBeenCalled();
    });

    it('never posts a code longer than the server would accept', async () => {
      /* A QR can carry kilobytes. A code is 48 characters. Dropping it here
         means the oversized string is never put on the wire at all. */
      const { api } = await import('../utils/api');
      grantCamera();
      decodes(`wev1:${'a'.repeat(500)}`);

      render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);

      /* Rendered twice by design — the visible card and the sr-only live
         region — so this asserts presence, not uniqueness. */
      await screen.findAllByText(/isn't a WeVolunteer check-in code/);
      expect(api.scanCheckinCode).not.toHaveBeenCalled();
    });

    it('tells the organizer why nothing happened, rather than failing silently', async () => {
      /* At a noisy park, "nothing happened" and "the camera is broken" look
         identical. The message is the difference between the organizer
         re-aiming and the organizer giving up on the scanner. */
      grantCamera();
      decodes('not-a-code');

      const { baseElement } = render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);

      await screen.findAllByText(/isn't a WeVolunteer check-in code/);
      expect(baseElement.querySelector('.scanner-result.is-bad')).toBeTruthy();
    });

    it('announces the refusal through the live region', async () => {
      grantCamera();
      decodes('not-a-code');

      const { baseElement } = render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);

      await waitFor(() => expect(
        baseElement.querySelector('[role="status"][aria-live="polite"]').textContent,
      ).toMatch(/isn't a WeVolunteer check-in code/));
    });
  });

  it('carries a live region for scan results on the dialog itself', () => {
    /* On the dialog rather than inside the result card, because the card
       unmounts as the next scan begins — a region that disappears while it is
       being read announces nothing. */
    grantCamera();
    const { baseElement } = render(<CheckInScanner eventId="e1" onClose={vi.fn()} />);
    expect(baseElement.querySelector('[role="status"][aria-live="polite"]')).toBeTruthy();
  });
});
