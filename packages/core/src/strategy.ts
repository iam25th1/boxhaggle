import { ATOMIC_PER_CENT, floorToCent } from "./money.js";
import { concessionRate, patienceCost, patienceMultiplier, relativeGap, type Mood } from "./engine.js";

// The agent's haggling strategy. Pure, so the live agent and the UI replay make
// the same moves from the same observations. It never sees the floor.
//
// It opens at 60% of list, then closes a mood-dependent share r of the spread
// between its last offer and the ask:  o' = o + r * (A - o).
// Before each round it estimates the next concession E = k(g) * m(p) * (A - o')
// and pays the ask instead when E is below the next round's fee, when the last
// concession was smaller than two fees, or when the round could empty the fuse.

export interface Observation {
  listPrice: number;
  ask: number;
  patience: number;
  mood: Mood;
  round: number;
  lastOffer: number | null;
  previousAsk: number | null;
  fee: number;
}

export type Move =
  | { kind: "offer"; amount: number; gap: number; expectedSaving: number; reason: string }
  | { kind: "accept"; amount: number; reason: string };

export const STRATEGY = {
  name: "spread-closer",
  opening: 0.6,
  share: { amused: 0.2, calm: 0.25, irritated: 0.4, insulted: 0.6, sold: 1 } as Record<Mood, number>,
  lowPatience: 35,
  lowPatienceShare: 0.5,
} as const;

export function spreadShare(patience: number, mood: Mood): number {
  const share = STRATEGY.share[mood];
  return patience < STRATEGY.lowPatience ? Math.max(share, STRATEGY.lowPatienceShare) : share;
}

function accept(ask: number, reason: string): Move {
  return { kind: "accept", amount: ask, reason };
}

export function planMove(o: Observation): Move {
  if (o.round === 0 || o.lastOffer === null) {
    const amount = Math.max(ATOMIC_PER_CENT, floorToCent(o.listPrice * STRATEGY.opening));
    const gap = relativeGap(o.ask, amount);
    return {
      kind: "offer",
      amount,
      gap,
      expectedSaving: Math.floor(concessionRate(gap) * (o.ask - amount)),
      reason: `Opening at ${Math.round(STRATEGY.opening * 100)}% of list to find the Broker's range.`,
    };
  }

  if (o.previousAsk !== null && o.round > 1 && o.previousAsk - o.ask < 2 * o.fee) {
    return accept(o.ask, "Concessions have stalled. Paying the ask.");
  }

  const share = spreadShare(o.patience, o.mood);
  let amount = floorToCent(o.lastOffer + share * (o.ask - o.lastOffer));
  if (amount <= o.lastOffer) amount = o.lastOffer + ATOMIC_PER_CENT;
  if (amount >= o.ask) return accept(o.ask, "The next offer would meet the ask anyway.");

  const gap = relativeGap(o.ask, amount);
  if (patienceCost(gap) >= o.patience) return accept(o.ask, "Another round could burn out the fuse. Paying the ask.");

  const expectedSaving = Math.floor(concessionRate(gap) * patienceMultiplier(o.patience) * (o.ask - amount));
  if (expectedSaving < o.fee) return accept(o.ask, "Expected saving is below the next round's fee. Paying the ask.");

  const cents = Math.round(expectedSaving / ATOMIC_PER_CENT);
  return {
    kind: "offer",
    amount,
    gap,
    expectedSaving,
    reason: `Broker is ${o.mood} at patience ${o.patience}. Closing ${Math.round(share * 100)}% of the spread, expecting about ${cents} cents back.`,
  };
}
