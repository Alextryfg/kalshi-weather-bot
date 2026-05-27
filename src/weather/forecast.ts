/**
 * Weather forecast ingestion.
 *
 * Primary source: GFS 31-member ensemble via Open-Meteo ensemble API.
 * → Devuelve la distribución real de probabilidad (sigma basada en 31 miembros),
 *   no una proxy de 3 modelos deterministas.
 *
 * Fallback: 3 modelos deterministas (ECMWF, GFS, ICON) si el ensemble falla.
 *
 * Extra: observación METAR en tiempo real (aviationweather.gov) para ajuste intraday.
 *
 * Todos los datos se piden en UTC para filtrado correcto con ventana LST del NWS.
 */

import axios from 'axios';
import { log } from '../logger';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface CityCoords {
  name: string;
  latitude: number;
  longitude: number;
  timezone: string;
  /** Código ICAO de la estación NWS que Kalshi usa para settlement */
  nwsStation: string;
  /**
   * Horas detrás de UTC en hora estándar (sin DST).
   * e.g. ET=5, CT=6, MT=7, PT=8.
   * Usado para calcular la ventana LST del NWS correctamente.
   */
  standardUtcOffset: number;
}

export const CITY_COORDS: Record<string, CityCoords> = {
  'New York': { name: 'New York', latitude: 40.7789, longitude: -73.9692, timezone: 'America/New_York', nwsStation: 'KNYC', standardUtcOffset: 5 },
  'Chicago': { name: 'Chicago', latitude: 41.7868, longitude: -87.7522, timezone: 'America/Chicago', nwsStation: 'KMDW', standardUtcOffset: 6 },
  'Los Angeles': { name: 'Los Angeles', latitude: 33.9425, longitude: -118.4081, timezone: 'America/Los_Angeles', nwsStation: 'KLAX', standardUtcOffset: 8 },
  'Houston': { name: 'Houston', latitude: 29.6454, longitude: -95.2789, timezone: 'America/Chicago', nwsStation: 'KHOU', standardUtcOffset: 6 },
  'Miami': { name: 'Miami', latitude: 25.7959, longitude: -80.2870, timezone: 'America/New_York', nwsStation: 'KMIA', standardUtcOffset: 5 },
  'Denver': { name: 'Denver', latitude: 39.8561, longitude: -104.6737, timezone: 'America/Denver', nwsStation: 'KDEN', standardUtcOffset: 7 },
  'Minneapolis': { name: 'Minneapolis', latitude: 44.8848, longitude: -93.2223, timezone: 'America/Chicago', nwsStation: 'KMSP', standardUtcOffset: 6 },
  'San Francisco': { name: 'San Francisco', latitude: 37.6213, longitude: -122.3790, timezone: 'America/Los_Angeles', nwsStation: 'KSFO', standardUtcOffset: 8 },
  'Philadelphia': { name: 'Philadelphia', latitude: 39.8729, longitude: -75.2408, timezone: 'America/New_York', nwsStation: 'KPHL', standardUtcOffset: 5 },
  'Dallas': { name: 'Dallas', latitude: 32.8998, longitude: -97.0403, timezone: 'America/Chicago', nwsStation: 'KDFW', standardUtcOffset: 6 },
  'Atlanta': { name: 'Atlanta', latitude: 33.6407, longitude: -84.4277, timezone: 'America/New_York', nwsStation: 'KATL', standardUtcOffset: 5 },
};

export interface HourlyForecast {
  /** ISO UTC sin zona: "YYYY-MM-DDTHH:00" */
  time: string;
  /** Media del ensemble en °F */
  temperatureF: number;
  /** Desviación estándar del ensemble en °F (mínimo BASELINE_SIGMA_F) */
  sigmaF: number;
  /** Valores brutos de cada miembro del ensemble en °F (vacío en fallback determinista) */
  members: number[];
  precipitationMm: number;
  precipSigmaMm: number;
}

export interface CityForecast {
  city: CityCoords;
  hourly: Map<string, HourlyForecast>;
  fetchedAt: string;
  /** Máximo observado hoy vía METAR (null si no disponible o no aplica) */
  metarObservedMaxF: number | null;
  /** true = datos del ensemble real; false = fallback determinista */
  fromEnsemble: boolean;
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const ENSEMBLE_API_BASE = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const FORECAST_API_BASE = 'https://api.open-meteo.com/v1/forecast';
const AVIATION_METAR_BASE = 'https://aviationweather.gov/api/data/metar';
const DETERMINISTIC_MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'] as const;
const GFS_ENSEMBLE_MEMBERS = 31;
const BASELINE_SIGMA_F = 3.0;
const BASELINE_PRECIP_SIGMA_MM = 0.5;

// ─── Retry helper ─────────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastErr: Error = new Error('unknown');
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e as Error;
      if (attempt < retries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        log.debug('weather.retry', { attempt: attempt + 1, delayMs: delay, err: lastErr.message });
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ─── Ensemble API (fuente principal) ─────────────────────────────────────────

type EnsembleHourly = Record<string, number[] | string[]>;

async function fetchEnsemble(coords: CityCoords): Promise<Map<string, HourlyForecast>> {
  const data = await withRetry(() =>
    axios.get<{ hourly?: EnsembleHourly }>(ENSEMBLE_API_BASE, {
      params: {
        latitude: coords.latitude,
        longitude: coords.longitude,
        hourly: 'temperature_2m,precipitation',
        temperature_unit: 'fahrenheit',
        precipitation_unit: 'mm',
        forecast_days: 3,
        timezone: 'UTC',
        models: 'gfs_seamless',
      },
      timeout: 30_000,
    }).then(r => r.data)
  );

  const hourly = data.hourly;
  if (!hourly) throw new Error('ensemble: sin datos hourly');

  const times = hourly['time'] as string[];
  if (!times?.length) throw new Error('ensemble: array de tiempos vacío');

  // Recopilar claves de miembros: temperature_2m_member00 ... member30
  const tempKeys: string[] = [];
  const precipKeys: string[] = [];
  for (let i = 0; i < GFS_ENSEMBLE_MEMBERS; i++) {
    const pad = String(i).padStart(2, '0');
    if (`temperature_2m_member${pad}` in hourly) tempKeys.push(`temperature_2m_member${pad}`);
    if (`precipitation_member${pad}` in hourly) precipKeys.push(`precipitation_member${pad}`);
  }
  if (tempKeys.length === 0) throw new Error('ensemble: no se encontraron claves de miembros');

  const result = new Map<string, HourlyForecast>();
  for (let i = 0; i < times.length; i++) {
    const tempMembers: number[] = [];
    for (const k of tempKeys) {
      const v = (hourly[k] as number[])[i];
      if (typeof v === 'number' && Number.isFinite(v)) tempMembers.push(v);
    }
    if (tempMembers.length === 0) continue;

    const precipMembers: number[] = [];
    for (const k of precipKeys) {
      const v = (hourly[k] as number[])[i];
      if (typeof v === 'number' && Number.isFinite(v)) precipMembers.push(v);
    }

    result.set(times[i], {
      time: times[i],
      temperatureF: mean(tempMembers),
      sigmaF: Math.max(stddev(tempMembers), BASELINE_SIGMA_F),
      members: tempMembers,
      precipitationMm: precipMembers.length ? mean(precipMembers) : 0,
      precipSigmaMm: Math.max(precipMembers.length > 1 ? stddev(precipMembers) : 0, BASELINE_PRECIP_SIGMA_MM),
    });
  }
  return result;
}

// ─── Fallback determinista ───────────────────────────────────────────────────

interface DeterministicResp {
  hourly?: {
    time: string[];
    temperature_2m?: number[];
    precipitation?: number[];
  };
}

async function fetchDeterministicModel(coords: CityCoords, model: string): Promise<DeterministicResp> {
  return withRetry(() =>
    axios.get<DeterministicResp>(FORECAST_API_BASE, {
      params: {
        latitude: coords.latitude,
        longitude: coords.longitude,
        hourly: 'temperature_2m,precipitation',
        temperature_unit: 'fahrenheit',
        precipitation_unit: 'mm',
        forecast_days: 3,
        timezone: 'UTC',
        models: model,
      },
      timeout: 25_000,
    }).then(r => r.data)
  );
}

async function fetchDeterministicFallback(
  coords: CityCoords,
  cityName: string,
): Promise<Map<string, HourlyForecast>> {
  const results: DeterministicResp[] = [];
  for (const m of DETERMINISTIC_MODELS) {
    try {
      results.push(await fetchDeterministicModel(coords, m));
      log.debug('weather.deterministic.ok', { city: cityName, model: m });
    } catch (e) {
      log.warn('weather.deterministic.failed', { city: cityName, model: m, err: (e as Error).message });
    }
  }
  if (results.length === 0) throw new Error(`Todos los modelos fallaron para ${cityName}`);

  const times = results[0].hourly?.time ?? [];
  const result = new Map<string, HourlyForecast>();
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

    result.set(times[i], {
      time: times[i],
      temperatureF: mean(tempSamples),
      sigmaF: Math.max(stddev(tempSamples), BASELINE_SIGMA_F),
      members: tempSamples,
      precipitationMm: precipSamples.length ? mean(precipSamples) : 0,
      precipSigmaMm: Math.max(precipSamples.length > 1 ? stddev(precipSamples) : 0, BASELINE_PRECIP_SIGMA_MM),
    });
  }
  return result;
}

// ─── METAR (observación intraday) ────────────────────────────────────────────

interface MetarRecord {
  obsTime?: number;   // Unix timestamp
  temp?: number | null; // Celsius
}

async function fetchMetarObservedMax(station: string): Promise<number | null> {
  try {
    const data = await withRetry(
      () => axios.get<MetarRecord[]>(AVIATION_METAR_BASE, {
        params: { ids: station, format: 'json', hours: 12 },
        timeout: 10_000,
      }).then(r => r.data),
      2,
      500,
    );
    if (!Array.isArray(data) || data.length === 0) return null;

    const windowStartMs = Date.now() - 12 * 3_600_000;
    let maxF: number | null = null;
    for (const obs of data) {
      if (obs.temp == null || !Number.isFinite(obs.temp)) continue;
      if (obs.obsTime != null && obs.obsTime * 1000 < windowStartMs) continue;
      const tempF = obs.temp * 9 / 5 + 32;
      if (maxF === null || tempF > maxF) maxF = tempF;
    }
    return maxF;
  } catch (e) {
    log.debug('metar.fetch.failed', { station, err: (e as Error).message });
    return null;
  }
}

// ─── Filtrado LST correcto ────────────────────────────────────────────────────

/**
 * Devuelve las horas del forecast que caen dentro de la ventana de settlement del NWS.
 *
 * El NWS CLI usa Local Standard Time (LST) — ignora el DST.
 * Ventana: 00:00 LST hasta 23:59 LST del día especificado.
 *
 * Como pedimos datos en UTC, convertimos usando el offset estándar de la ciudad.
 * Ejemplo para New York (EST = UTC-5):
 *   Ventana de "2026-05-26" = 05:00 UTC 26-May a 04:59 UTC 27-May
 *
 * Esto corrige el bug de DST: en verano el bot filtraba 00:00-23:00 EDT
 * (que es 04:00-03:00 UTC), perdiendo la hora 00:00-01:00 LST.
 */
export function nwsHoursForDate(forecast: CityForecast, dateLocal: string): HourlyForecast[] {
  const offsetH = forecast.city.standardUtcOffset;
  const [year, month, day] = dateLocal.split('-').map(Number);
  const windowStartMs = Date.UTC(year, month - 1, day, offsetH, 0, 0);
  const windowEndMs = Date.UTC(year, month - 1, day + 1, offsetH, 0, 0);

  return Array.from(forecast.hourly.values()).filter(h => {
    // h.time es UTC sin sufijo Z: "YYYY-MM-DDTHH:00"
    const t = new Date(h.time + ':00Z').getTime();
    return t >= windowStartMs && t < windowEndMs;
  });
}

// ─── Exports principales ─────────────────────────────────────────────────────

export async function fetchCityForecast(
  cityName: string,
  enableMetar = true,
): Promise<CityForecast> {
  const coords = CITY_COORDS[cityName];
  if (!coords) throw new Error(`Ciudad desconocida: ${cityName}. Añádela a CITY_COORDS.`);

  // 1. Intentar ensemble GFS 31 miembros
  let hourly: Map<string, HourlyForecast>;
  let fromEnsemble = false;
  try {
    hourly = await fetchEnsemble(coords);
    fromEnsemble = true;
    log.info('weather.ensemble.ok', { city: cityName, members: GFS_ENSEMBLE_MEMBERS, hours: hourly.size });
  } catch (e) {
    log.warn('weather.ensemble.failed.fallback_deterministic', {
      city: cityName,
      err: (e as Error).message,
    });
    hourly = await fetchDeterministicFallback(coords, cityName);
    log.info('weather.deterministic.ok', { city: cityName, hours: hourly.size });
  }

  // 2. METAR: máximo observado hoy (opcional, falla silenciosamente)
  let metarObservedMaxF: number | null = null;
  if (enableMetar) {
    metarObservedMaxF = await fetchMetarObservedMax(coords.nwsStation);
    if (metarObservedMaxF !== null) {
      log.info('weather.metar.ok', {
        city: cityName,
        station: coords.nwsStation,
        maxF: metarObservedMaxF.toFixed(1),
      });
    }
  }

  return {
    city: coords,
    hourly,
    fetchedAt: new Date().toISOString(),
    metarObservedMaxF,
    fromEnsemble,
  };
}

export async function fetchForecasts(
  cities: string[],
  enableMetar = true,
): Promise<Map<string, CityForecast>> {
  const out = new Map<string, CityForecast>();
  for (const c of cities) {
    try {
      const f = await fetchCityForecast(c, enableMetar);
      out.set(c, f);
      log.info('weather.fetched', {
        city: c,
        hours: f.hourly.size,
        ensemble: f.fromEnsemble,
        metarMax: f.metarObservedMaxF?.toFixed(1) ?? null,
      });
    } catch (e) {
      log.error('weather.fetch.failed', { city: c, err: (e as Error).message });
    }
  }
  return out;
}

// ─── Helpers estadísticos ─────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}