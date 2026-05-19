/**
 * Map a (forecast mean, sigma) to a probability for a Kalshi weather contract.
 *
 * Kalshi weather contracts come in a few shapes; we handle the common ones:
 *   - "Will the HIGH temp in <city> on <date> be > T°F?"  → P(max(temps) > T)
 *   - "Will the LOW temp in <city> on <date> be < T°F?"   → P(min(temps) < T)
 *   - "Will the HIGH be between A and B°F?"               → P(A <= max < B)
 *
 * We approximate the daily max/min by taking the max/min of the hourly means
 * and combine sigmas in quadrature. This is an approximation — the true max
 * is a *biased estimator* (max of normals has positive expectation), but for
 * Kalshi's typically 1-5°F bin sizes the bias is small relative to forecast
 * uncertainty. A more rigorous approach (extreme-value distribution fitting)
 * is left as future work.
 */

import { HourlyForecast } from './forecast';

/** Standard normal CDF via Abramowitz & Stegun erf approximation. */
export function normalCdf(x: number, mu = 0, sigma = 1): number {
  if (sigma <= 0) return x >= mu ? 1 : 0;
  const z = (x - mu) / (sigma * Math.SQRT2);
  // erf approximation, max error ~1.5e-7
  const sign = z < 0 ? -1 : 1;
  const a = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return 0.5 * (1 + sign * y);
}

/** Aggregate hourly forecasts over a window to a (mean_max, sigma_max) or (mean_min, sigma_min). */
function aggregateExtremum(
  hours: HourlyForecast[],
  extremum: 'max' | 'min',
): { mean: number; sigma: number } {
  if (hours.length === 0) throw new Error('aggregateExtremum: empty window');
  let pick = hours[0];
  for (const h of hours) {
    if (extremum === 'max' && h.temperatureF > pick.temperatureF) pick = h;
    if (extremum === 'min' && h.temperatureF < pick.temperatureF) pick = h;
  }
  // Inflate sigma slightly to account for the bias-of-max-of-normals effect.
  // Empirical rule of thumb: ~10% widening per 12 hours in the window.
  const widening = 1 + 0.1 * (hours.length / 12);
  return { mean: pick.temperatureF, sigma: pick.sigmaF * widening };
}

export interface TempProbInput {
  hours: HourlyForecast[];
  /** "high" | "low" | "any-hour" (any-hour treats the window as a uniform draw). */
  aggregate: 'high' | 'low' | 'any-hour';
  /** "greater" | "less" | "between" */
  comparison: 'greater' | 'less' | 'between';
  thresholdF: number;
  /** For "between": upper bound (exclusive) in °F. */
  upperThresholdF?: number;
}

/** Returns P(market resolves YES) given the forecast over the relevant hour window. */
export function probabilityForTempMarket(input: TempProbInput): number {
  let mu: number, sigma: number;
  if (input.aggregate === 'high') {
    ({ mean: mu, sigma } = aggregateExtremum(input.hours, 'max'));
  } else if (input.aggregate === 'low') {
    ({ mean: mu, sigma } = aggregateExtremum(input.hours, 'min'));
  } else {
    // any-hour: average mean, sigma combined in quadrature / sqrt(n)
    const ms = input.hours.map((h) => h.temperatureF);
    mu = ms.reduce((a, b) => a + b, 0) / ms.length;
    const s2 = input.hours.reduce((a, h) => a + h.sigmaF ** 2, 0) / input.hours.length;
    sigma = Math.sqrt(s2);
  }

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

export interface PrecipProbInput {
  hours: HourlyForecast[];
  /** Cumulative mm threshold over the window. */
  thresholdMm: number;
  comparison: 'greater' | 'less';
}

/** Cumulative precipitation modeled as sum of independent Normals (rough). */
export function probabilityForPrecipMarket(input: PrecipProbInput): number {
  const muSum = input.hours.reduce((a, h) => a + h.precipitationMm, 0);
  const sigmaSum = Math.sqrt(input.hours.reduce((a, h) => a + h.precipSigmaMm ** 2, 0));
  // Truncate-at-zero: precip can't be negative. We approximate by treating
  // the normal as is but clamp the resulting probability sensibly.
  const p = input.comparison === 'greater'
    ? 1 - normalCdf(input.thresholdMm, muSum, sigmaSum)
    : normalCdf(input.thresholdMm, muSum, sigmaSum);
  return Math.max(0.001, Math.min(0.999, p));
}
