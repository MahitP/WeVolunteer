import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../../utils/api', () => ({ api: { getWeather: vi.fn() } }));

import { api } from '../../utils/api';
import { __resetWeatherCache } from '../../utils/weatherCache';
import WeatherSummary from './WeatherSummary';

/**
 * The forecast badge, and the promise that it can never break a page.
 *
 * There were no weather tests of any kind. The component's whole contract is
 * that every failure renders nothing, which is exactly the contract that rots
 * silently: a component that renders nothing when it is broken looks identical
 * to one that renders nothing because there is no forecast.
 */

const SOON = () => new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
const FAR = () => new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
const PAST = () => new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();

const ok = (over = {}) => ({
  result: { temperature: 72, feelsLike: 70, condition: 'Clear sky', icon: 'Sun', ...over },
});

/* A distinct place per test so the module cache cannot answer the next one. */
let n = 0;
const place = () => { n += 1; return { latitude: 40 + n * 0.05, longitude: -74 - n * 0.05 }; };

describe('WeatherSummary', () => {
  beforeEach(() => {
    __resetWeatherCache();
    vi.mocked(api.getWeather).mockReset();
  });

  it('shows the temperature and the conditions', async () => {
    vi.mocked(api.getWeather).mockResolvedValue(ok());
    render(<WeatherSummary {...place()} datetime={SOON()} />);

    expect(await screen.findByText('72°F')).toBeInTheDocument();
    expect(screen.getByText('Clear sky')).toBeInTheDocument();
  });

  it('gives a screen reader one sentence instead of three fragments', async () => {
    vi.mocked(api.getWeather).mockResolvedValue(ok());
    render(<WeatherSummary {...place()} datetime={SOON()} />);

    await screen.findByText('72°F');
    expect(screen.getByRole('img', { name: /Clear sky, 72 degrees/i })).toBeInTheDocument();
  });

  it('falls back to a generic icon for a weather code it has never seen', async () => {
    /* The icon table is closed on purpose — a namespace import of lucide-react
       once cost 611 kB — so an unknown name must degrade rather than crash. */
    vi.mocked(api.getWeather).mockResolvedValue(ok({ icon: 'Meteors', condition: 'Unknown conditions' }));
    render(<WeatherSummary {...place()} datetime={SOON()} />);

    expect(await screen.findByText('Unknown conditions')).toBeInTheDocument();
  });

  describe('renders nothing, quietly', () => {
    it('when the server fails', async () => {
      vi.mocked(api.getWeather).mockRejectedValue(new Error('502'));
      const { container } = render(<WeatherSummary {...place()} datetime={SOON()} />);

      await waitFor(() => expect(container.textContent).not.toMatch(/Checking/));
      expect(container.textContent).toBe('');
      /* Specifically: no "Weather unavailable". An apology occupies space that
         the absence of a badge occupies better. */
      expect(container.textContent).not.toMatch(/unavailable/i);
    });

    it('when the event has no coordinates', () => {
      const { container } = render(<WeatherSummary latitude={null} longitude={null} datetime={SOON()} />);
      expect(container).toBeEmptyDOMElement();
      expect(api.getWeather).not.toHaveBeenCalled();
    });

    it('when the event has no time', () => {
      const { container } = render(<WeatherSummary {...place()} datetime={null} />);
      expect(container).toBeEmptyDOMElement();
      expect(api.getWeather).not.toHaveBeenCalled();
    });
  });

  describe('never asks for a forecast that cannot exist', () => {
    it('for an event beyond the provider horizon', () => {
      render(<WeatherSummary {...place()} datetime={FAR()} />);
      /* The dashboard and the calendar are full of events three weeks out.
         Letting each one issue a request the server can only refuse is a lot of
         404s for no forecast. */
      expect(api.getWeather).not.toHaveBeenCalled();
    });

    it('for an event that has already happened', () => {
      render(<WeatherSummary {...place()} datetime={PAST()} />);
      expect(api.getWeather).not.toHaveBeenCalled();
    });
  });

  it('issues one request when two badges want the same forecast', async () => {
    vi.mocked(api.getWeather).mockResolvedValue(ok());
    const where = place();
    const when = SOON();

    render(
      <>
        <WeatherSummary {...where} datetime={when} />
        <WeatherSummary {...where} datetime={when} />
      </>,
    );

    await waitFor(() => expect(screen.getAllByText('72°F')).toHaveLength(2));
    expect(api.getWeather).toHaveBeenCalledTimes(1);
  });

  it('does not flash a spinner for a forecast that resolves immediately', async () => {
    vi.mocked(api.getWeather).mockResolvedValue(ok());
    render(<WeatherSummary {...place()} datetime={SOON()} />);

    /* The spinner waits 300ms before appearing, so a cache hit or a fast
       response never produces a flicker of "Checking the forecast". */
    expect(screen.queryByText(/Checking the forecast/)).toBeNull();
    await screen.findByText('72°F');
  });
});
