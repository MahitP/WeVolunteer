import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../../utils/api', () => ({ api: { getTravelTime: vi.fn() } }));

const mockLocation = { current: null };
vi.mock('../../contexts/LocationContext', () => ({
  useLocationContext: () => ({ location: mockLocation.current }),
}));

import TravelTime from './TravelTime';
import { api } from '../../utils/api';

/**
 * The travel-time line.
 *
 * Two things are being held in place. The first is that it renders NOTHING on
 * every failure — no provider configured, no location granted, no route, timed
 * out, offline — because a student who did not ask for this should never be
 * shown its failure. The second is the wording: this number cannot see traffic,
 * so it must never appear as an arrival time or a leave-by time.
 */

const HERE = { latitude: 40.3894, longitude: -74.5223 };
const THERE = { latitude: 40.4406, longitude: -74.4885 };

beforeEach(() => {
  vi.clearAllMocks();
  mockLocation.current = HERE;
  api.getTravelTime.mockResolvedValue({ result: { seconds: 843, label: '14 min', trafficAware: false } });
});

describe('when it has everything it needs', () => {
  it('says about how long the drive is', async () => {
    render(<TravelTime latitude={THERE.latitude} longitude={THERE.longitude} />);
    expect(await screen.findByText('About 14 min by car')).toBeInTheDocument();
  });

  it('sends the origin and the destination once', async () => {
    render(<TravelTime latitude={THERE.latitude} longitude={THERE.longitude} />);

    await waitFor(() => expect(api.getTravelTime).toHaveBeenCalledWith(
      HERE.latitude, HERE.longitude, THERE.latitude, THERE.longitude,
    ));
    expect(api.getTravelTime).toHaveBeenCalledTimes(1);
  });

  it('never presents the figure as an arrival or leave-by time', async () => {
    /**
     * The provider cannot see traffic. "Arrive by 3:47" from a free-flow figure
     * is a number we made up wearing the clothes of one we measured, and it is
     * the specific thing this feature was told not to ship. "About" is the word
     * doing that work.
     */
    const { container } = render(<TravelTime latitude={THERE.latitude} longitude={THERE.longitude} />);
    await screen.findByText(/About 14 min/);

    expect(container.textContent).not.toMatch(/arrive|leave by|be there by|ETA/i);
    expect(container.textContent).toMatch(/^About /);
  });

  it('hides the decorative icon from assistive technology', async () => {
    const { container } = render(<TravelTime latitude={THERE.latitude} longitude={THERE.longitude} />);
    await screen.findByText(/About 14 min/);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('renders nothing at all when', () => {
  const nothing = (container) => expect(container.textContent).toBe('');

  it('the student has not granted location', async () => {
    mockLocation.current = null;
    const { container } = render(<TravelTime latitude={THERE.latitude} longitude={THERE.longitude} />);

    nothing(container);
    expect(api.getTravelTime, 'nothing should be requested without an origin').not.toHaveBeenCalled();
  });

  it('the event has no coordinates', async () => {
    const { container } = render(<TravelTime latitude={null} longitude={null} />);
    nothing(container);
    expect(api.getTravelTime).not.toHaveBeenCalled();
  });

  it('the event has a latitude but no longitude', async () => {
    const { container } = render(<TravelTime latitude={40.4} longitude={undefined} />);
    nothing(container);
    expect(api.getTravelTime).not.toHaveBeenCalled();
  });

  it('the deployment has no routing provider', async () => {
    /* 503 routing_unconfigured is the expected state for a pilot that has not
       signed up. It must be silence, not an error the student reads. */
    api.getTravelTime.mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'routing_unconfigured' }));

    const { container } = render(<TravelTime latitude={THERE.latitude} longitude={THERE.longitude} />);

    await waitFor(() => expect(api.getTravelTime).toHaveBeenCalled());
    nothing(container);
  });

  it('the request fails', async () => {
    api.getTravelTime.mockRejectedValue(new Error('upstream_error'));
    const { container } = render(<TravelTime latitude={THERE.latitude} longitude={THERE.longitude} />);
    await waitFor(() => expect(api.getTravelTime).toHaveBeenCalled());
    nothing(container);
  });

  it('there is no driving route', async () => {
    api.getTravelTime.mockRejectedValue(new Error('no_route'));
    const { container } = render(<TravelTime latitude={THERE.latitude} longitude={THERE.longitude} />);
    await waitFor(() => expect(api.getTravelTime).toHaveBeenCalled());
    nothing(container);
  });

  it('the answer comes back without a label', async () => {
    api.getTravelTime.mockResolvedValue({ result: {} });
    const { container } = render(<TravelTime latitude={THERE.latitude} longitude={THERE.longitude} />);
    await waitFor(() => expect(api.getTravelTime).toHaveBeenCalled());
    nothing(container);
  });

  it('the answer comes back empty', async () => {
    api.getTravelTime.mockResolvedValue(null);
    const { container } = render(<TravelTime latitude={THERE.latitude} longitude={THERE.longitude} />);
    await waitFor(() => expect(api.getTravelTime).toHaveBeenCalled());
    nothing(container);
  });

  it('it never says "travel time unavailable"', async () => {
    /* Same rule WeatherSummary follows. A failure message for something nobody
       asked for is noise on a page a student is trying to read. */
    api.getTravelTime.mockRejectedValue(new Error('timeout'));
    const { container } = render(<TravelTime latitude={THERE.latitude} longitude={THERE.longitude} />);

    await waitFor(() => expect(api.getTravelTime).toHaveBeenCalled());
    expect(container.textContent).not.toMatch(/unavailable|failed|error|try again/i);
  });
});

describe('when the inputs change', () => {
  it('clears the old answer rather than showing it against the new event', async () => {
    /* A stale "14 min" beside a different event is worse than nothing: it is a
       wrong number that looks right. */
    const { rerender, container } = render(<TravelTime latitude={THERE.latitude} longitude={THERE.longitude} />);
    await screen.findByText(/About 14 min/);

    api.getTravelTime.mockImplementation(() => new Promise(() => {}));
    rerender(<TravelTime latitude={41.1} longitude={-75.1} />);

    expect(container.textContent).toBe('');
  });

  it('asks again when the student moves', async () => {
    const { rerender } = render(<TravelTime latitude={THERE.latitude} longitude={THERE.longitude} />);
    await waitFor(() => expect(api.getTravelTime).toHaveBeenCalledTimes(1));

    mockLocation.current = { latitude: 40.9, longitude: -74.9 };
    rerender(<TravelTime latitude={THERE.latitude} longitude={THERE.longitude} />);

    await waitFor(() => expect(api.getTravelTime).toHaveBeenCalledTimes(2));
  });

  it('does not apply an answer that lands after unmount', async () => {
    /**
     * Guarded with a `cancelled` flag rather than an AbortController. Two of
     * these can share a page and an AbortController belonging to one would
     * cancel the other's request when it unmounted — the bug `WeatherSummary`
     * was rewritten to remove.
     */
    let settle;
    api.getTravelTime.mockReturnValue(new Promise(resolve => { settle = resolve; }));

    const { unmount } = render(<TravelTime latitude={THERE.latitude} longitude={THERE.longitude} />);
    await waitFor(() => expect(api.getTravelTime).toHaveBeenCalled());
    unmount();

    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    settle({ result: { label: '14 min' } });
    await Promise.resolve();

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
