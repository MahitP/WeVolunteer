import React, { useState, useEffect } from 'react';
import {
  Loader2, Sun, Cloud, CloudSun, CloudFog, CloudDrizzle, CloudRain, CloudSnow, CloudLightning
} from 'lucide-react';
import { getForecast, isForecastable, weatherKey } from '../../utils/weatherCache';
import './LocationDisplay.css';

/**
 * The weather icons this component can actually show, keyed by the name the
 * server sends.
 *
 * This was `import * as LucideIcons from 'lucide-react'` with a
 * `LucideIcons[weather.icon]` lookup. A namespace import defeats tree-shaking by
 * construction — the bundler cannot know which of ~1,600 icons a runtime string
 * will select, so it has to include all of them. That single line was 611 kB of
 * the bundle (157 kB gzipped), for a nine-icon weather badge.
 *
 * It hid inside the 1,270 kB entry chunk until route splitting broke the bundle
 * apart and left it standing alone as the largest remaining chunk.
 *
 * The set is closed and small: server/routes/weatherRoutes.js maps every WMO
 * code to one of these eight names. An unrecognised name falls back to Cloud,
 * which is what the old lookup did too — so behaviour is unchanged, including
 * for a WMO code this table has not seen.
 */
const WEATHER_ICONS = {
  Sun, Cloud, CloudSun, CloudFog, CloudDrizzle, CloudRain, CloudSnow, CloudLightning
};

/**
 * How long a fetch must run before a spinner is worth showing.
 *
 * The forecast is usually a cache hit and resolves in the same tick. Rendering
 * a spinner for it produces a flash of "Forecast…" that reads as jank, not as
 * progress — so the loading state waits until there is genuinely something to
 * wait for.
 */
const SPINNER_DELAY_MS = 300;

/**
 * A one-line forecast for an event, or nothing at all.
 *
 * ── Everything that goes wrong renders nothing ──
 *
 * No coordinates, an event outside the forecast window, a refused request, an
 * outage, a timeout, a browser offline: all render `null`. Weather is an
 * enhancement to a page whose real job is telling somebody where to be and
 * when, and "Weather unavailable" is a line of apology occupying space that the
 * absence of a badge occupies better.
 *
 * The window is checked here rather than left to the server, so an event three
 * weeks out never issues a request that could only have been refused. The
 * dashboard and the calendar are full of events three weeks out.
 */
export default function WeatherSummary({ latitude, longitude, datetime }) {
  const [weather, setWeather] = useState(null);
  const [showSpinner, setShowSpinner] = useState(false);

  /* The identity of the question, so the effect re-runs when the ANSWER would
     differ rather than whenever a parent re-renders with a new object. */
  const key = latitude != null && longitude != null && datetime
    ? weatherKey(latitude, longitude, datetime)
    : null;
  const forecastable = key != null && isForecastable(datetime);

  useEffect(() => {
    if (!forecastable) {
      setWeather(null);
      setShowSpinner(false);
      return undefined;
    }

    /**
     * A plain flag, not an AbortController.
     *
     * The request is shared through the module cache, so aborting it on unmount
     * would cancel it for every other component waiting on the same answer.
     * Ignoring a late result is the version that composes; see weatherCache.js.
     */
    let cancelled = false;
    setWeather(null);

    const spinnerTimer = setTimeout(() => {
      if (!cancelled) setShowSpinner(true);
    }, SPINNER_DELAY_MS);

    getForecast(latitude, longitude, datetime).then((result) => {
      if (cancelled) return;
      clearTimeout(spinnerTimer);
      setShowSpinner(false);
      setWeather(result);
    });

    return () => {
      cancelled = true;
      clearTimeout(spinnerTimer);
    };
  }, [key, forecastable, latitude, longitude, datetime]);

  if (!forecastable) return null;

  if (showSpinner && !weather) {
    return (
      <div className="weather-summary loading" role="status" aria-busy="true">
        <Loader2 className="spinner" size={14} aria-hidden="true" />
        <span className="weather-desc">Checking the forecast</span>
      </div>
    );
  }

  if (!weather) return null;

  const IconComponent = WEATHER_ICONS[weather.icon] || Cloud;

  return (
    <div
      className="weather-summary"
      role="img"
      aria-label={`Forecast: ${weather.condition}, ${weather.temperature} degrees Fahrenheit, feels like ${weather.feelsLike}`}
      title={`Feels like ${weather.feelsLike}°F`}
    >
      <IconComponent size={14} className="weather-icon" aria-hidden="true" />
      <span className="weather-temp" aria-hidden="true">{weather.temperature}°F</span>
      <span className="weather-desc" aria-hidden="true">{weather.condition}</span>
    </div>
  );
}
