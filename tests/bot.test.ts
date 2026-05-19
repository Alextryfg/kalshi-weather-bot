import { halfKellySize } from '../src/sizing/kelly';
import { computeEdge } from '../src/engine/edge';
import { normalCdf, probabilityForTempMarket } from '../src/weather/models';
import { parseWeatherTicker } from '../src/bot';
import { checkRiskGates } from '../src/risk/gatekeeper';
import { summarizeBook } from '../src/engine/pricing';

describe('half-Kelly sizing', () => {
  it('returns zero contracts when there is no edge', () => {
    // pWin = price ⇒ no edge ⇒ Kelly should be ≤ 0
    const out = halfKellySize({
      pWin: 0.50,
      pricePerContractCents: 50,
      bankrollUsd: 1000,
      kellyFraction: 0.5,
      maxTradeFraction: 0.05,
    });
    expect(out.contracts).toBe(0);
  });

  it('respects the max-trade-fraction cap', () => {
    const out = halfKellySize({
      pWin: 0.90,
      pricePerContractCents: 50, // huge edge
      bankrollUsd: 1000,
      kellyFraction: 0.5,
      maxTradeFraction: 0.05,
    });
    // Capped at 5% of $1000 = $50. At 50¢/contract → 100 contracts.
    expect(out.fAllocated).toBeCloseTo(0.05, 6);
    expect(out.contracts).toBe(100);
    expect(out.notes.some((n) => n.startsWith('capped_at_'))).toBe(true);
  });

  it('scales linearly with bankroll when uncapped', () => {
    // Pick a small edge so Kelly stays well below the cap.
    const a = halfKellySize({ pWin: 0.52, pricePerContractCents: 50, bankrollUsd: 1000,
                              kellyFraction: 0.5, maxTradeFraction: 0.5 });
    const b = halfKellySize({ pWin: 0.52, pricePerContractCents: 50, bankrollUsd: 2000,
                              kellyFraction: 0.5, maxTradeFraction: 0.5 });
    expect(b.contracts).toBeGreaterThan(a.contracts * 1.5);
  });
});

describe('edge computation', () => {
  it('flags YES side when model > market', () => {
    const book = { yesBid: 40, yesAsk: 42, yesMidProb: 0.41, yesBidSize: 100, noBidSize: 100,
                   topDepthMin: 100, totalTop5Depth: 200, spreadCents: 2 };
    const d = computeEdge(0.55, book, 0.5);
    expect(d.side).toBe('yes');
    expect(d.meetsThreshold).toBe(true);
    expect(d.edgePp).toBeGreaterThan(0);
    // Maker = 1¢ inside ask
    expect(d.makerLimitCents).toBe(41);
  });

  it('flags NO side when model < market', () => {
    const book = { yesBid: 60, yesAsk: 62, yesMidProb: 0.61, yesBidSize: 100, noBidSize: 100,
                   topDepthMin: 100, totalTop5Depth: 200, spreadCents: 2 };
    const d = computeEdge(0.50, book, 0.5);
    expect(d.side).toBe('no');
    expect(d.meetsThreshold).toBe(true);
  });

  it('rejects sub-threshold edges', () => {
    const book = { yesBid: 50, yesAsk: 51, yesMidProb: 0.505, yesBidSize: 100, noBidSize: 100,
                   topDepthMin: 100, totalTop5Depth: 200, spreadCents: 1 };
    const d = computeEdge(0.507, book, 0.5);
    expect(d.meetsThreshold).toBe(false);
  });
});

describe('normal CDF', () => {
  it('is 0.5 at the mean', () => {
    expect(normalCdf(0, 0, 1)).toBeCloseTo(0.5, 3);
  });
  it('is ~0.8413 at +1 sigma', () => {
    expect(normalCdf(1, 0, 1)).toBeCloseTo(0.8413, 3);
  });
});

describe('temp market probability', () => {
  it('higher mean -> higher P(temp > T)', () => {
    const hours = (mu: number) => [
      { time: '2025-05-19T13:00', temperatureF: mu - 1, sigmaF: 2, precipitationMm: 0, precipSigmaMm: 0 },
      { time: '2025-05-19T14:00', temperatureF: mu,     sigmaF: 2, precipitationMm: 0, precipSigmaMm: 0 },
      { time: '2025-05-19T15:00', temperatureF: mu + 1, sigmaF: 2, precipitationMm: 0, precipSigmaMm: 0 },
    ];
    const pHot = probabilityForTempMarket({ hours: hours(80), aggregate: 'high', comparison: 'greater', thresholdF: 75 });
    const pCool = probabilityForTempMarket({ hours: hours(70), aggregate: 'high', comparison: 'greater', thresholdF: 75 });
    expect(pHot).toBeGreaterThan(pCool);
  });
});

describe('ticker parsing', () => {
  it('parses HIGH NY threshold ticker', () => {
    const r = parseWeatherTicker('HIGHNY-25MAY19-T75');
    expect(r).not.toBeNull();
    expect(r!.city).toBe('New York');
    expect(r!.aggregate).toBe('high');
    expect(r!.comparison).toBe('greater');
    expect(r!.thresholdF).toBe(75);
    expect(r!.date).toBe('2025-05-19');
  });

  it('parses LOW LAX less-than ticker', () => {
    const r = parseWeatherTicker('LOWLAX-25MAY19-L55');
    expect(r!.city).toBe('Los Angeles');
    expect(r!.aggregate).toBe('low');
    expect(r!.comparison).toBe('less');
  });

  it('rejects garbage tickers', () => {
    expect(parseWeatherTicker('GARBAGE')).toBeNull();
    expect(parseWeatherTicker('HIGHXX-25MAY19-T75')).toBeNull();
  });
});

describe('order-book summary', () => {
  it('computes mid from bid + (100-no_bid)', () => {
    const s = summarizeBook({
      orderbook: {
        yes: [[40, 100], [39, 50]],
        no:  [[55, 80], [54, 30]],   // implied yes_ask = 100-55 = 45
      },
    });
    expect(s.yesBid).toBe(40);
    expect(s.yesAsk).toBe(45);
    expect(s.yesMidProb).toBeCloseTo(0.425, 3);
    expect(s.topDepthMin).toBe(80);
  });
});

describe('risk gates', () => {
  const baseCfg = {
    minOrderbookDepth: 50,
    maxVolatilityPp1h: 20,
    maxPositionFraction: 0.10,
    dailyLossCapFraction: 0.10,
    minHoursToSettlement: 6,
  } as any;
  const baseMarket = {
    ticker: 'HIGHNY-25MAY19-T75',
    close_time: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  } as any;
  const goodBook = { yesBid: 40, yesAsk: 42, yesMidProb: 0.41, yesBidSize: 100, noBidSize: 100,
                     topDepthMin: 100, totalTop5Depth: 200, spreadCents: 2 };
  const exposure = { bankrollUsd: 1000, byTicker: new Map<string, number>(), totalAtRiskUsd: 0, realizedPnlTodayUsd: 0 };

  it('passes when everything is healthy', () => {
    const r = checkRiskGates({ cfg: baseCfg, market: baseMarket, book: goodBook,
                               recentMidsCents: [40, 41, 40], exposure, side: 'yes', proposedNotionalUsd: 50 });
    expect(r.pass).toBe(true);
  });

  it('fails on liquidity', () => {
    const r = checkRiskGates({ cfg: baseCfg, market: baseMarket,
                               book: { ...goodBook, noBidSize: 10 },
                               recentMidsCents: [40], exposure, side: 'yes', proposedNotionalUsd: 50 });
    expect(r.pass).toBe(false);
    expect(r.reasons.some(x => x.startsWith('gate1'))).toBe(true);
  });

  it('fails on settlement clock', () => {
    const soon = { ...baseMarket, close_time: new Date(Date.now() + 60_000).toISOString() };
    const r = checkRiskGates({ cfg: baseCfg, market: soon, book: goodBook,
                               recentMidsCents: [40], exposure, side: 'yes', proposedNotionalUsd: 50 });
    expect(r.pass).toBe(false);
    expect(r.reasons.some(x => x.startsWith('gate5'))).toBe(true);
  });

  it('fails on concentration', () => {
    const exp = { ...exposure, byTicker: new Map([['HIGHNY-25MAY19-T75', 95]]) };
    const r = checkRiskGates({ cfg: baseCfg, market: baseMarket, book: goodBook,
                               recentMidsCents: [40], exposure: exp, side: 'yes', proposedNotionalUsd: 50 });
    expect(r.pass).toBe(false);
    expect(r.reasons.some(x => x.startsWith('gate3'))).toBe(true);
  });

  it('fails on daily loss cap', () => {
    const exp = { ...exposure, realizedPnlTodayUsd: -200 }; // -20% on $1000
    const r = checkRiskGates({ cfg: baseCfg, market: baseMarket, book: goodBook,
                               recentMidsCents: [40], exposure: exp, side: 'yes', proposedNotionalUsd: 50 });
    expect(r.pass).toBe(false);
    expect(r.reasons.some(x => x.startsWith('gate4'))).toBe(true);
  });

  it('fails on volatility', () => {
    const r = checkRiskGates({ cfg: baseCfg, market: baseMarket, book: goodBook,
                               recentMidsCents: [30, 60, 35], exposure, side: 'yes', proposedNotionalUsd: 50 });
    expect(r.pass).toBe(false);
    expect(r.reasons.some(x => x.startsWith('gate2'))).toBe(true);
  });
});
