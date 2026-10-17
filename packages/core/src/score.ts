// Score S = P_final + sum of every haggling fee f_i. Lower is better.
// A walk-away has no final price, so it has no score.

export interface Scorecard {
  listPrice: number;
  finalPrice: number | null;
  fees: number;
  rounds: number;
  /** P_final + fees, or null when the Broker walked. */
  score: number | null;
  /** listPrice - score. Negative means the haggling cost more than it saved. */
  savings: number | null;
}

export function totalFees(fees: readonly number[]): number {
  return fees.reduce((sum, fee) => sum + fee, 0);
}

export function scorecard(listPrice: number, finalPrice: number | null, fees: readonly number[]): Scorecard {
  const feeTotal = totalFees(fees);
  const score = finalPrice === null ? null : finalPrice + feeTotal;
  return {
    listPrice,
    finalPrice,
    fees: feeTotal,
    rounds: fees.length,
    score,
    savings: score === null ? null : listPrice - score,
  };
}
