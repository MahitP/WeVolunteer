import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CheckInView from './CheckInView';

/**
 * "Cannot load check-in / Event not found." was two answers printed together.
 *
 * ── Why it matters more here than on most pages ──
 *
 * This is the screen an organizer opens standing at a venue with volunteers
 * arriving. The old panel told them both that the page had failed to load and
 * that the event did not exist, which are opposite instructions: one says wait
 * and try again, the other says the link is wrong and trying again is pointless.
 * It also offered no way out at all — the `action` slot was empty, which is the
 * dead end finding N-16 named — so the only real option was a page reload they
 * had to think of themselves.
 *
 * ── And to the coverage claim ──
 *
 * React Router serves the shell for any path, so `/checkin/anything` answers 200
 * and lands on exactly that URL. The accessibility sweep was measuring that
 * panel and filing the numbers under `/checkin/:eventId`. `notFound` marks the
 * one branch that means "this does not exist", so the sweep discards it instead
 * — and the branch that means "we could not reach the server" stays measured,
 * because that page really did render.
 */

const apiMock = vi.hoisted(() => ({
  fetchEventDetails: vi.fn(),
  fetchCheckins: vi.fn(),
}));
vi.mock('../utils/api', () => ({ api: apiMock }));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useParams: () => ({ eventId: 'no-such-event' }),
  useNavigate: () => vi.fn(),
}));
vi.mock('../components/CheckInScanner', () => ({ default: () => null }));

const draw = () => render(<MemoryRouter><CheckInView /></MemoryRouter>);

beforeEach(() => {
  apiMock.fetchEventDetails.mockReset();
  apiMock.fetchCheckins.mockReset().mockResolvedValue([]);
});

describe('check-in for an event id nobody has', () => {
  it('says the event does not exist rather than that loading failed', async () => {
    apiMock.fetchEventDetails.mockRejectedValue(
      Object.assign(new Error('Not found'), { status: 404 })
    );

    draw();

    expect(await screen.findByText('No such event')).toBeInTheDocument();
    expect(screen.queryByText('Cannot load check-in')).not.toBeInTheDocument();
  });

  it('gives an organizer standing at a venue somewhere to go', async () => {
    /* N-16, on the route where a dead end costs the most. */
    apiMock.fetchEventDetails.mockRejectedValue(
      Object.assign(new Error('Not found'), { status: 404 })
    );

    draw();
    await screen.findByText('No such event');

    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
  });

  it('marks the panel so the accessibility sweep discards the measurement', async () => {
    apiMock.fetchEventDetails.mockRejectedValue(
      Object.assign(new Error('Not found'), { status: 404 })
    );

    const { container } = draw();
    await screen.findByText('No such event');

    expect(container.querySelector('[data-error-kind="404"]')).not.toBeNull();
  });
});

describe('check-in when the server could not be reached', () => {
  it('is reported as a load failure, not a wrong address', async () => {
    /* The over-correction to guard against. A fault at our end is a page that
       genuinely rendered, and marking it would throw away that coverage — and
       tell an organizer their link was wrong when it was not. */
    apiMock.fetchEventDetails.mockRejectedValue(new Error('network down'));

    const { container } = draw();

    expect(await screen.findByText('Cannot load check-in')).toBeInTheDocument();
    expect(screen.queryByText('No such event')).not.toBeInTheDocument();
    expect(container.querySelector('[data-error-kind]')).toBeNull();
  });

  it('offers a retry, because here retrying might work', async () => {
    apiMock.fetchEventDetails.mockRejectedValue(new Error('network down'));

    draw();
    await screen.findByText('Cannot load check-in');

    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
