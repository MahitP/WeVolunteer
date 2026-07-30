import express from 'express';
import rateLimit from 'express-rate-limit';
import { DEMO_MODE } from '../config.js';

const router = express.Router();

// --- In-memory cache ---
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const MAX_CACHE = 1000;
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { data, ts: Date.now() });
}

// --- Rate limiter ---
const weatherLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 500 : 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many weather requests. Please wait a moment.',
      code: 'rate_limited'
    });
  }
});

// WMO weather code mapping to human readable strings and lucide icon names
const WMO_MAP = {
  0: { label: 'Clear sky', icon: 'Sun' },
  1: { label: 'Mainly clear', icon: 'Sun' },
  2: { label: 'Partly cloudy', icon: 'CloudSun' },
  3: { label: 'Overcast', icon: 'Cloud' },
  45: { label: 'Fog', icon: 'CloudFog' },
  48: { label: 'Depositing rime fog', icon: 'CloudFog' },
  51: { label: 'Light drizzle', icon: 'CloudDrizzle' },
  53: { label: 'Moderate drizzle', icon: 'CloudDrizzle' },
  55: { label: 'Dense drizzle', icon: 'CloudDrizzle' },
  56: { label: 'Light freezing drizzle', icon: 'CloudDrizzle' },
  57: { label: 'Dense freezing drizzle', icon: 'CloudDrizzle' },
  61: { label: 'Slight rain', icon: 'CloudRain' },
  63: { label: 'Moderate rain', icon: 'CloudRain' },
  65: { label: 'Heavy rain', icon: 'CloudRain' },
  66: { label: 'Light freezing rain', icon: 'CloudRain' },
  67: { label: 'Heavy freezing rain', icon: 'CloudRain' },
  71: { label: 'Slight snow', icon: 'CloudSnow' },
  73: { label: 'Moderate snow', icon: 'CloudSnow' },
  75: { label: 'Heavy snow', icon: 'CloudSnow' },
  77: { label: 'Snow grains', icon: 'CloudSnow' },
  80: { label: 'Slight rain showers', icon: 'CloudRain' },
  81: { label: 'Moderate rain showers', icon: 'CloudRain' },
  82: { label: 'Violent rain showers', icon: 'CloudLightning' },
  85: { label: 'Slight snow showers', icon: 'CloudSnow' },
  86: { label: 'Heavy snow showers', icon: 'CloudSnow' },
  95: { label: 'Thunderstorm', icon: 'CloudLightning' },
  96: { label: 'Thunderstorm with slight hail', icon: 'CloudLightning' },
  99: { label: 'Thunderstorm with heavy hail', icon: 'CloudLightning' }
};

router.get('/api/weather', weatherLimiter, async (req, res) => {
  const { lat, lon, datetime } = req.query;
  
  if (!lat || !lon || !datetime) {
    return res.status(400).json({ error: 'lat, lon, and datetime are required' });
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);

  if (isNaN(latitude) || isNaN(longitude)) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  const targetDate = new Date(datetime);
  if (isNaN(targetDate.getTime())) {
    return res.status(400).json({ error: 'Invalid datetime' });
  }

  targetDate.setMinutes(0, 0, 0);
  const targetIso = targetDate.toISOString().slice(0, 13); // e.g. "2024-06-15T10"
  
  const cacheKey = `${latitude.toFixed(4)}_${longitude.toFixed(4)}_${targetIso}`;
  const cached = getCached(cacheKey);
  
  if (cached) {
    return res.json({ result: cached, cached: true });
  }

  try {
    const now = new Date();
    const daysDiff = (targetDate.getTime() - now.getTime()) / (1000 * 3600 * 24);
    
    if (daysDiff < -1) {
      return res.status(400).json({ error: 'Cannot fetch weather for past events', code: 'past_event' });
    }
    if (daysDiff > 14) {
      return res.status(400).json({ error: 'Forecast unavailable this far in advance', code: 'future_event' });
    }

    const params = new URLSearchParams({
      latitude: latitude.toFixed(4),
      longitude: longitude.toFixed(4),
      hourly: 'temperature_2m,apparent_temperature,weather_code',
      temperature_unit: 'fahrenheit',
      timezone: 'UTC',
      forecast_days: '16'
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      headers: { 'User-Agent': 'WeVolunteer/1.0 (volunteer-app; contact@wevolunteer.app)' },
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Open-Meteo returned ${response.status}`);
    }

    const data = await response.json();
    
    const times = data.hourly.time;
    const targetMatchString = `${targetIso}:00`;
    
    const index = times.findIndex(t => t === targetMatchString);
    
    if (index === -1) {
      return res.status(404).json({ error: 'No forecast available for this specific time', code: 'not_found' });
    }

    const temp = data.hourly.temperature_2m[index];
    const feelsLike = data.hourly.apparent_temperature[index];
    const code = data.hourly.weather_code[index];
    
    const wmo = WMO_MAP[code] || { label: 'Unknown conditions', icon: 'Cloud' };

    const result = {
      temperature: Math.round(temp),
      feelsLike: Math.round(feelsLike),
      condition: wmo.label,
      icon: wmo.icon
    };

    setCache(cacheKey, result);
    res.json({ result });
    
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Weather request timed out', code: 'timeout' });
    }
    console.error('Weather proxy error:', err.message);
    res.status(502).json({ error: 'Unable to reach weather service', code: 'upstream_error' });
  }
});

export default router;
