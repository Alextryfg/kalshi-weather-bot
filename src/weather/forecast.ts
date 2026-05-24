/**
 * Weather forecast ingestion via Open-Meteo (free, no auth).
 *
 * We query TWO models per location and combine them into a (mean, sigma)
 * forecast for each target hour:
 *   - `graphcast`     — DeepMind's GraphCast, 0.25° native
 *   - `gfs_seamless`  — NOAA GFS, used as fallback + variance source
 *
 * The combined sigma is `max(spread_between_models, baseline_uncertainty)`.
 * This is a deliberately conservative proxy for an ensemble: when two
 * independent models disagree, our forecast is less confident.
 *
 * Open-Meteo docs: https://open-meteo.com/en/docs
 */

import axios from 'axios';
import { log } from '../logger';

export interface CityCoords {
  name: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

/** Hard-coded coordinates so we don't need a geocoding hop every run. */
export const CITY_COORDS: Record<string, CityCoords> = {
  'New York': { name: 'New York', latitude: 40.7128, longitude: -74.0060, timezone: 'America/New_York' },
  'Chicago': { name: 'Chicago', latitude: 41.8781, longitude: -87.6298, timezone: 'America/Chicago' },
  'Los Angeles': { name: 'Los Angeles', latitude: 34.0522, longitude: -118.2437, timezone: 'America/Los_Angeles' },
  'London': { name: 'London', latitude: 51.5074, longitude: -0.1278, timezone: 'Europe/London' },
  // ── Añadir estas ──────────────────────────────────────────────
  'Houston': { name: 'Houston', latitude: 29.7604, longitude: -95.3698, timezone: 'America/Chicago' },
  'Miami': { name: 'Miami', latitude: 25.7617, longitude: -80.1918, timezone: 'America/New_York' },
  'Denver': { name: 'Denver', latitude: 39.7392, longitude: -104.9903, timezone: 'America/Denver' },
  'Minneapolis': { name: 'Minneapolis', latitude: 44.9778, longitude: -93.2650, timezone: 'America/Chicago' },
  'San Francisco': { name: 'San Francisco', latitude: 37.7749, longitude: -122.4194, timezone: 'America/Los_Angeles' },
  'Philadelphia': { name: 'Philadelphia', latitude: 39.9526, longitude: -75.1652, timezone: 'America/New_York' },
  'Dallas': { name: 'Dallas', latitude: 32.7767, longitude: -96.7970, timezone: 'America/Chicago' },
  'Atlanta': { name: 'Atlanta', latitude: 33.7490, longitude: -84.3880, timezone: 'America/New_York' },
};

export interface HourlyForecast {
  /** ISO8601 hour in the city's local timezone. */
  time: string;
  /** Mean temperature forecast in °F (Kalshi weather contracts use Fahrenheit). */
  temperatureF: number;
  /** Standard deviation across models, in °F. Floor of 1.5°F. */
  sigmaF: number;
  /** Mean precipitation in mm. */
  precipitationMm: number;
  /** Sigma for precipitation in mm. */
  precipSigmaMm: number;
}

export interface CityForecast {
  city: CityCoords;
  /** Map of `YYYY-MM-DDTHH:00` (local) -> hourly forecast. */
  hourly: Map<string, HourlyForecast>;
  fetchedAt: string;
}

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
// graphcast was retired from Open-Meteo in 2025; ecmwf_ifs025 is the
// current high-res ECMWF model and gfs_seamless is the NOAA fallback.
// Three independent NWP models for better spread estimation.
// ECMWF IFS (high-res), GFS (NOAA), ICON (DWD) — all free on Open-Meteo.
const MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'] as const;
// 3.0°F baseline is realistic for 24-48h temperature forecasts (NOAA verification).
const BASELINE_SIGMA_F = 3.0;
const BASELINE_PRECIP_SIGMA_MM = 0.5;

interface OpenMeteoResponse {
  hourly?: {
    time: string[];
    temperature_2m?: number[];
    precipitation?: number[];
  };
}

async function fetchModel(coords: CityCoords, model: string): Promise<OpenMeteoResponse> {
  const res = await axios.get<OpenMeteoResponse>(OPEN_METEO_BASE, {
    params: {
      latitude: coords.latitude,
      longitude: coords.longitude,
      hourly: 'temperature_2m,precipitation',
      temperature_unit: 'fahrenheit',
      precipitation_unit: 'mm',
      forecast_days: 3,
      timezone: coords.timezone,
      models: model,
    },
    timeout: 20_000,
  });
  return res.data;
}

export async function fetchCityForecast(cityName: string): Promise<CityForecast> {
  const coords = CITY_COORDS[cityName];
  if (!coords) throw new Error(`Unknown city: ${cityName}. Add it to CITY_COORDS.`);

  const results: OpenMeteoResponse[] = [];
  for (const m of MODELS) {
    try {
      results.push(await fetchModel(coords, m));
    } catch (e) {
      log.warn('weather.model.failed', { city: cityName, model: m, err: (e as Error).message });
    }
  }
  if (results.length === 0) throw new Error(`All weather models failed for ${cityName}`);

  // Align by time index. Models from Open-Meteo for the same lat/lon/range
  // return identical `hourly.time` arrays, so we can index-merge.
  const times = results[0].hourly?.time ?? [];
  const hourly = new Map<string, HourlyForecast>();

  for (let i = 0; i < times.length; i++) {
    const tempSamples: number[] = [];
    const precipSamples: number[] = [];
    for (const r of results) {
      const t = r.hourly?.temperature_2m?.[i];
      const p = r.hourly?.precipitation?.[i];
      if (typeof t === 'number' && Number.isFinite(t)) tempSamples.push(t);
      if (typeof p === 'number' && Number.isFinite(p)) precipSamples.push(p);
    }
    if (tempSamples.length === 0) continue;

    const meanT = mean(tempSamples);
    const sigmaT = Math.max(stddev(tempSamples), BASELINE_SIGMA_F);
    const meanP = precipSamples.length ? mean(precipSamples) : 0;
    const sigmaP = Math.max(precipSamples.length ? stddev(precipSamples) : 0, BASELINE_PRECIP_SIGMA_MM);

    hourly.set(times[i], {
      time: times[i],
      temperatureF: meanT,
      sigmaF: sigmaT,
      precipitationMm: meanP,
      precipSigmaMm: sigmaP,
    });
  }

  return { city: coords, hourly, fetchedAt: new Date().toISOString() };
}

export async function fetchForecasts(cities: string[]): Promise<Map<string, CityForecast>> {
  const out = new Map<string, CityForecast>();
  // Open-Meteo's free tier is rate-limited; serial fetch is plenty for ≤4 cities/30min.
  for (const c of cities) {
    try {
      const f = await fetchCityForecast(c);
      out.set(c, f);
      log.info('weather.fetched', { city: c, hours: f.hourly.size });
    } catch (e) {
      log.error('weather.fetch.failed', { city: c, err: (e as Error).message });
    }
  }
  return out;
}

// --- stats helpers ---

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}
