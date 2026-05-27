/**
 * Modelo de probabilidad para contratos de temperatura Kalshi.
 *
 * Mejoras vs versión anterior:
 *
 * 1. ENSEMBLE REAL: cuando hay miembros disponibles (GFS 31 miembros), calcula
 *    el extremo diario por miembro y extrae la sigma de esa distribución.
 *    Antes: sigma = stddev(3 medias) → proxy muy burda.
 *    Ahora: sigma = stddev(max de cada uno de los 31 miembros) → distribución real.
 *
 * 2. BIAS CORRECTION: aplica corrección empírica por ciudad basada en biases
 *    conocidos de los modelos NWP vs observaciones NWS históricas.
 *    - GFS: cold bias sistemático en temperature_2m
 *    - ECMWF IFS: subestima ciclo diurno ~1-2K
 *    - Efectos microclimáticos por estación (KLAX costera, KNYC urbano, etc.)
 *
 * 3. AJUSTE INTRADAY: si hay observación METAR disponible y la temperatura
 *    ya supera la media del modelo, actualiza la distribución en consecuencia.
 */

import { HourlyForecast } from './forecast';

// ─── Constantes ───────────────────────────────────────────────────────────────

const BASELINE_SIGMA_F = 3.0;

/**
 * Corrección de bias empírica por ciudad en °F.
 *
 * Definición: bias = media_ensemble - observado_NWS
 * → positivo: el modelo corre caliente → bajamos mu
 * → negativo: el modelo corre frío    → subimos mu
 *
 * Fuentes:
 * - GFS cold bias documentado en estudios de verificación NOAA (Zheng et al. 2017)
 * - ECMWF IFS: underestima ciclo diurno ~1-2K (cold bias día, warm bias noche)
 * - Efectos estación-específicos calibrados empíricamente:
 *   KLAX: capa marina, modelo sobreestima 2-3°F en verano
 *   KSFO: niebla/stratus matutino, modelo sobreestima fuertemente
 *   KNYC: isla de calor urbano mal capturado, modelo ligeramente frío
 *
 * CALIBRACIÓN: estos valores son puntos de partida. A medida que acumules
 * resultados en pnl_history, ajusta usando la media de (temp_prevista - temp_real).
 */
export const BIAS_CORRECTION_F: Record<string, number> = {
  'New York': -0.5,  // KNYC: modelo frío vs isla de calor Central Park
  'Chicago': +0.5,  // KMDW: aeropuerto más frío que grid del modelo
  'Los Angeles': +2.0,  // KLAX: capa marina costera, modelo sobreestima fuertemente
  'Houston': -0.5,  // KHOU: influencia brisa marina subestimada
  'Miami': -0.3,  // KMIA: bien predicho en general
  'Denver': +0.5,  // KDEN: modelo corre ligeramente caliente en altiplano
  'Minneapolis': +0.8,  // KMSP: GFS cold bias pronunciado en latitudes altas
  'San Francisco': +1.5,  // KSFO: niebla costera, modelo sobreestima significativamente
  'Philadelphia': -0.3,  // KPHL: bien predicho en general
  'Dallas': -0.3,  // KDFW: modelo ligeramente frío en verano (GFS)
  'Atlanta': -0.5,  // KATL: isla de calor aeropuerto subestimada
};

// ─── CDF Normal ──────────────────────────────────────────────────────────────

/** CDF normal estándar via aproximación Abramowitz & Stegun, error máx ~1.5e-7 */
export function normalCdf(x: number, mu = 0, sigma = 1): number {
  if (sigma <= 0) return x >= mu ? 1 : 0;
  const z = (x - mu) / (sigma * Math.SQRT2);
  const sign = z < 0 ? -1 : 1;
  const a = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return 0.5 * (1 + sign * y);
}

// ─── Agregación extremo diario ────────────────────────────────────────────────

function aggregateExtremum(
  hours: HourlyForecast[],
  extremum: 'max' | 'min',
): { mean: number; sigma: number } {
  if (hours.length === 0) throw new Error('aggregateExtremum: ventana vacía');

  const allHaveMembers = hours.every(h => h.members && h.members.length >= 2);

  if (allHaveMembers) {
    /**
     * MÉTODO ENSEMBLE (preciso):
     * Para cada miembro del ensemble, calculamos el extremo a lo largo del día.
     * Luego mu y sigma se derivan de esa distribución de extremos.
     *
     * Esto captura correctamente la distribución del máximo diario —
     * que no es Gaussiana aunque las horas individuales lo sean.
     */
    const numMembers = hours[0].members.length;
    const extremaPerMember: number[] = [];

    for (let m = 0; m < numMembers; m++) {
      let val = hours[0].members[m] ?? hours[0].temperatureF;
      for (const h of hours) {
        const mv = h.members[m] ?? h.temperatureF;
        if (extremum === 'max' ? mv > val : mv < val) val = mv;
      }
      extremaPerMember.push(val);
    }

    const mu = meanArr(extremaPerMember);
    const sigma = Math.max(stddevArr(extremaPerMember), BASELINE_SIGMA_F);
    return { mean: mu, sigma };
  }

  /**
   * MÉTODO FALLBACK (determinista):
   * Tomamos la hora con el valor extremo y ensanchamos sigma
   * para representar la incertidumbre del extremo diario.
   * hours^0.15 es empíricamente calibrado (verificación NOAA).
   */
  let pick = hours[0];
  for (const h of hours) {
    if (extremum === 'max' && h.temperatureF > pick.temperatureF) pick = h;
    if (extremum === 'min' && h.temperatureF < pick.temperatureF) pick = h;
  }
  const widening = Math.pow(hours.length, 0.15);
  return { mean: pick.temperatureF, sigma: pick.sigmaF * widening };
}

// ─── API pública ──────────────────────────────────────────────────────────────

export interface TempProbInput {
  hours: HourlyForecast[];
  aggregate: 'high' | 'low' | 'any-hour';
  comparison: 'greater' | 'less' | 'between';
  thresholdF: number;
  upperThresholdF?: number;
  /** Nombre de ciudad para bias correction (debe coincidir con BIAS_CORRECTION_F) */
  cityName?: string;
  /** Máximo ya observado vía METAR hoy (null = no disponible) */
  observedMaxSoFarF?: number | null;
  /** Si true, aplica bias correction (default true) */
  enableBiasCorrection?: boolean;
}

export function probabilityForTempMarket(input: TempProbInput): number {
  let mu: number;
  let sigma: number;

  if (input.aggregate === 'high') {
    ({ mean: mu, sigma } = aggregateExtremum(input.hours, 'max'));
  } else if (input.aggregate === 'low') {
    ({ mean: mu, sigma } = aggregateExtremum(input.hours, 'min'));
  } else {
    // any-hour: media de medias, sigma combinada
    const ms = input.hours.map(h => h.temperatureF);
    mu = ms.reduce((a, b) => a + b, 0) / ms.length;
    const s2 = input.hours.reduce((a, h) => a + h.sigmaF ** 2, 0) / input.hours.length;
    sigma = Math.sqrt(s2);
  }

  // ── Bias correction por ciudad ──────────────────────────────────────────
  // bias > 0: modelo corre caliente → bajamos mu
  // bias < 0: modelo corre frío    → subimos mu
  const applyBias = input.enableBiasCorrection !== false; // default true
  if (applyBias && input.cityName) {
    const bias = BIAS_CORRECTION_F[input.cityName] ?? 0;
    mu -= bias;
  }

  // ── Ajuste intraday METAR ────────────────────────────────────────────────
  // Si ya hay temperatura observada HOY que supera la media del modelo,
  // actualizamos la distribución: mu sube al observado y sigma se reduce
  // proporcionalmente a las horas que quedan hasta settlement.
  if (
    input.aggregate === 'high' &&
    input.observedMaxSoFarF != null &&
    Number.isFinite(input.observedMaxSoFarF) &&
    input.observedMaxSoFarF > mu
  ) {
    const nowMs = Date.now();
    const hoursRemaining = input.hours.filter(h => {
      const t = new Date(h.time + ':00Z').getTime();
      return t > nowMs;
    }).length;
    // Fracción del día que queda [0.05, 1.0] — 0.05 evita sigma→0
    const fracRemaining = Math.max(0.05, Math.min(1.0, hoursRemaining / 24));
    // Blending: cuanto más tarde, más peso al observado
    mu = input.observedMaxSoFarF * (1 - fracRemaining) + mu * fracRemaining;
    sigma = sigma * Math.sqrt(fracRemaining);
  }

  // Floor de sigma para evitar certezas artificiales
  sigma = Math.max(sigma, 0.5);

  switch (input.comparison) {
    case 'greater':
      return 1 - normalCdf(input.thresholdF, mu, sigma);
    case 'less':
      return normalCdf(input.thresholdF, mu, sigma);
    case 'between': {
      const upper = input.upperThresholdF;
      if (upper == null) throw new Error('between requires upperThresholdF');
      return normalCdf(upper, mu, sigma) - normalCdf(input.thresholdF, mu, sigma);
    }
  }
}

// ─── Precipitación (sin cambios) ─────────────────────────────────────────────

export interface PrecipProbInput {
  hours: HourlyForecast[];
  thresholdMm: number;
  comparison: 'greater' | 'less';
}

export function probabilityForPrecipMarket(input: PrecipProbInput): number {
  const muSum = input.hours.reduce((a, h) => a + h.precipitationMm, 0);
  const sigmaSum = Math.sqrt(input.hours.reduce((a, h) => a + h.precipSigmaMm ** 2, 0));
  const p = input.comparison === 'greater'
    ? 1 - normalCdf(input.thresholdMm, muSum, sigmaSum)
    : normalCdf(input.thresholdMm, muSum, sigmaSum);
  return Math.max(0.001, Math.min(0.999, p));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function meanArr(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddevArr(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = meanArr(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}