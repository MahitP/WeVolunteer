import React, { useState, useEffect } from 'react';
import * as LucideIcons from 'lucide-react';
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
        <LucideIcons.Loader2 className="spinner" size={14} />
        <span className="weather-desc">Forecast...</span>
      </div>
    );
  }

  if (error || !weather) {
    // Hide gracefully if unavailable
    return null;
  }

  const IconComponent = LucideIcons[weather.icon] || LucideIcons.Cloud;

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
