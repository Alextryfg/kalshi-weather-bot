/**
 * Modelo de probabilidad para contratos de temperatura Kalshi.
 *
 * CAMBIOS v2 (01-Jun-2026):
 *
 * 1. PROBABILITY FLOOR [0.02, 0.98]:
 *    El modelo nunca es más confiado que 98:2. Certeza extrema casi siempre
 *    es sobreajuste del modelo, no realidad. Limita también el tamaño Kelly.
 *
 * 2. SIGMA MÍNIMA PARA "BETWEEN" = 4.5°F:
 *    Los contratos between tienen ventana de 2°F. Con sigma=3°F y mu a 5+°F
 *    del rango, P(between) cae a <0.01% aunque el mercado ponga 15-20%.
 *    4.5°F produce colas más realistas en línea con los precios de mercado.
 *
 * MEJORAS vs versión anterior:
 *
 * 1. ENSEMBLE REAL: cuando hay miembros disponibles (GFS 31 miembros), calcula
 *    el extremo diario por miembro y extrae la sigma de esa distribución.
 *    Antes: sigma = stddev(3 medias) → proxy muy burda.
 *    Ahora: sigma = stddev(max de cada uno de los 31 miembros) → distribución real.
 *
 * 2. BIAS CORRECTION: aplica corrección empírica por ciudad basada en biases
 *    conocidos de los modelos NWP vs observaciones NWS históricas.
 *
 * 3. AJUSTE INTRADAY: si hay observación METAR disponible y la temperatura
 *    ya supera la media del modelo, actualiza la distribución en consecuencia.
 */

import { HourlyForecast } from './forecast';

// ─── Constantes ───────────────────────────────────────────────────────────────

const BASELINE_SIGMA_F = 3.0;

// Sigma mínima para contratos "between" (ventana 2°F).
// Razonamiento: P(2°F window) con sigma=3°F a 5°F de mu es ~0.2%.
// El mercado raramente pone <2% incluso para rangos alejados.
// 4.5°F produce P~3-6% para mu 4-5°F fuera del rango → más conservador.
const BETWEEN_SIGMA_MIN_F = 4.5;

// Floor/ceil de probabilidad. El modelo nunca puede ser más confiado que 98:2.
// Previene posiciones de tamaño extremo y pérdidas catatastróficas si el
// modelo se equivoca (lo cual ocurre más seguido de lo que la matemática sugiere).
const PROB_FLOOR = 0.02;
const PROB_CEIL = 0.98;

/**
 * Corrección de bias empírica por ciudad en °F.
 *
 * Definición: bias = media_ensemble - observado_NWS
 * → positivo: el modelo corre caliente → bajamos mu
 * → negativo: el modelo corre frío    → subimos mu
 */
export const BIAS_CORRECTION_F: Record<string, number> = {
  'New York': -0.5,
  'Chicago': +0.5,
  'Los Angeles': +2.0,
  'Houston': -0.5,
  'Miami': -0.3,
  'Denver': +0.5,
  'Minneapolis': +0.8,
  'San Francisco': +1.5,
  'Philadelphia': -0.3,
  'Dallas': -0.3,
  'Atlanta': -0.5,
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
  cityName?: string;
  observedMaxSoFarF?: number | null;
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
    const ms = input.hours.map(h => h.temperatureF);
    mu = ms.reduce((a, b) => a + b, 0) / ms.length;
    const s2 = input.hours.reduce((a, h) => a + h.sigmaF ** 2, 0) / input.hours.length;
    sigma = Math.sqrt(s2);
  }

  // ── Bias correction por ciudad ──────────────────────────────────────────
  const applyBias = input.enableBiasCorrection !== false;
  if (applyBias && input.cityName) {
    const bias = BIAS_CORRECTION_F[input.cityName] ?? 0;
    mu -= bias;
  }

  // ── Ajuste intraday METAR ────────────────────────────────────────────────
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
    const fracRemaining = Math.max(0.05, Math.min(1.0, hoursRemaining / 24));
    mu = input.observedMaxSoFarF * (1 - fracRemaining) + mu * fracRemaining;
    sigma = sigma * Math.sqrt(fracRemaining);
  }

  // ── Sigma mínima para contratos "between" ─────────────────────────────────
  // La ventana de un contrato between es de ~2°F. Con sigma=3°F, P(2°F window)
  // puede caer a 0.001% cuando mu está a 5°F del rango, mientras el mercado
  // pone 15-20%. Sigma=4.5°F produce colas más realistas.
  // Ejemplo: mu=70°F, between 77.5-79.5, sigma=3→0.54%, sigma=4.5→3.04%
  if (input.comparison === 'between') {
    sigma = Math.max(sigma, BETWEEN_SIGMA_MIN_F);
  }

  // Floor de sigma para evitar certezas artificiales
  sigma = Math.max(sigma, 0.5);

  // ── Calcular probabilidad bruta ───────────────────────────────────────────
  let rawProb: number;
  switch (input.comparison) {
    case 'greater':
      rawProb = 1 - normalCdf(input.thresholdF, mu, sigma);
      break;
    case 'less':
      rawProb = normalCdf(input.thresholdF, mu, sigma);
      break;
    case 'between': {
      const upper = input.upperThresholdF;
      if (upper == null) throw new Error('between requires upperThresholdF');
      rawProb = normalCdf(upper, mu, sigma) - normalCdf(input.thresholdF, mu, sigma);
      break;
    }
    default:
      rawProb = 0.5;
  }

  // ── Probability floor/ceil: el modelo nunca es más confiado que 98:2 ──────
  // Los modelos NWP tienen colas reales no capturadas por la distribución
  // normal. Certeza extrema (<2% o >98%) casi siempre indica sobreajuste
  // del modelo, no realidad. Este floor además limita el tamaño Kelly,
  // previniendo apuestas de tamaño catastrófico en eventos de cola.
  return Math.max(PROB_FLOOR, Math.min(PROB_CEIL, rawProb));
}

// ─── Precipitación ───────────────────────────────────────────────────────────

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