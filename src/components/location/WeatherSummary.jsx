import React, { useState, useEffect } from 'react';
import {
  Loader2, Sun, Cloud, CloudSun, CloudFog, CloudDrizzle, CloudRain, CloudSnow, CloudLightning
} from 'lucide-react';

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
import { api } from '../../utils/api';
import './LocationDisplay.css';

export default function WeatherSummary({ latitude, longitude, datetime }) {
  const [weather, setWeather] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (latitude == null || longitude == null || !datetime) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();

    async function fetchWeather() {
      try {
        setLoading(true);
        setError(null);
        const data = await api.getWeather(latitude, longitude, datetime, controller.signal);
        setWeather(data.result);
      } catch (err) {
        if (err.name !== 'AbortError') {
          setError(err.message);
        }
      } finally {
        setLoading(false);
      }
    }

    fetchWeather();

    return () => controller.abort();
  }, [latitude, longitude, datetime]);

  if (loading) {
    return (
      <div className="weather-summary loading" aria-busy="true">
        <Loader2 className="spinner" size={14} />
        <span className="weather-desc">Forecast...</span>
      </div>
    );
  }

  if (error || !weather) {
    // Hide gracefully if unavailable
    return null;
  }

  const IconComponent = WEATHER_ICONS[weather.icon] || Cloud;

  return (
    <div 
      className="weather-summary" 
      aria-label={`${weather.condition}, ${weather.temperature} degrees Fahrenheit`}
      title={`Feels like ${weather.feelsLike}°F`}
    >
      <IconComponent size={14} className="weather-icon" />
      <span className="weather-temp">{weather.temperature}°F</span>
      <span className="weather-desc">{weather.condition}</span>
    </div>
  );
}
