/**
 * Half-Kelly position sizing for binary (YES/NO) Kalshi contracts.
 *
 * Standard Kelly for a binary bet with probability p of winning and net odds b:
 *   f* = (b*p - q) / b        where q = 1 - p
 *
 * For a Kalshi contract priced at `c` cents per share (0<c<100):
 *   You pay c, you win (100 - c) if it resolves your way, you lose c otherwise.
 *   So b = (100 - c) / c, p = modelProb (for your side).
 *
 * We use *half-Kelly* (multiplier `kellyFraction`, default 0.5) which is
 * standard practice — it reduces drawdown risk and is more robust to
 * mis-estimated edge.
 *
 * Final size is capped at `maxTradeFraction` of bankroll regardless of Kelly.
 */

export interface KellyInput {
  /** Model probability of the chosen side winning (0..1). */
  pWin: number;
  /** Limit price you'll pay per contract in cents (1..99). */
  pricePerContractCents: number;
  /** Available bankroll in USD. */
  bankrollUsd: number;
  /** Kelly multiplier, e.g. 0.5 for half-Kelly. */
  kellyFraction: number;
  /** Hard cap as a fraction of bankroll, e.g. 0.05 for 5%. */
  maxTradeFraction: number;
  /** Optional: round down to integer contracts (default true). */
  roundDown?: boolean;
}

export interface KellyOutput {
  /** Optimal Kelly fraction (unclamped). */
  fStar: number;
  /** Fraction of bankroll allocated after multiplier & cap. */
  fAllocated: number;
  /** USD amount risked. */
  riskUsd: number;
  /** Number of contracts to buy (integer). */
  contracts: number;
  /** Diagnostics. */
  notes: string[];
}

export function halfKellySize(input: KellyInput): KellyOutput {
  const notes: string[] = [];
  const c = input.pricePerContractCents;
  if (c <= 0 || c >= 100) throw new Error(`Invalid price ${c}; must be 1..99`);
  if (input.bankrollUsd <= 0) {
    return { fStar: 0, fAllocated: 0, riskUsd: 0, contracts: 0, notes: ['empty_bankroll'] };
  }
  const p = clamp(input.pWin, 0.001, 0.999);
  const q = 1 - p;
  const b = (100 - c) / c;          // net odds: payout per $1 risked
  const fStar = (b * p - q) / b;    // classic Kelly

  if (fStar <= 0) {
    notes.push('negative_edge');
    return { fStar, fAllocated: 0, riskUsd: 0, contracts: 0, notes };
  }

  let f = fStar * input.kellyFraction;
  if (f > input.maxTradeFraction) {
    notes.push(`capped_at_${input.maxTradeFraction}`);
    f = input.maxTradeFraction;
  }

  const riskUsd = f * input.bankrollUsd;
  // Each contract costs c cents = c/100 dollars.
  const rawContracts = riskUsd / (c / 100);
  const contracts = input.roundDown === false ? rawContracts : Math.floor(rawContracts);

  if (contracts < 1) notes.push('size_below_one_contract');

  return {
    fStar,
    fAllocated: f,
    riskUsd: contracts * (c / 100),
    contracts,
    notes,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
