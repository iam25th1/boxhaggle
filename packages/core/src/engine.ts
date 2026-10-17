import { ATOMIC_PER_CENT, ceilToCent } from "./money.js";
import type { Item } from "./items.js";

// The Broker: a deterministic merchant with a hidden floor, a patience meter and a mood.
//
// Notation (all amounts atomic USDC):
//   A  current ask        o  the offer        F  hidden floor        p  patience (0..100)
//   g  = (A - o) / A, clamped to [0, 1], the relative gap of the offer below the ask
//
// Rules for one round:
//   1. o >= A                      -> sold at A.
//   2. patience cost   dp = 2 + ceil(80 * g^2) + (g > 0.5 ? 10 : 0)
//   3. concession      A' = max(F, ceil_cent(A - k(g) * m(p) * (A - o)))
//        k(g) = 0.5 if g <= 0.10, 0.3 if g <= 0.25, 0.12 if g <= 0.5, else 0
//        m(p) = 1 if p >= 50, 0.75 if p >= 25, else 0.5
//      When k > 0 and A > F the ask drops by at least one cent.
//   4. p' = max(0, p - dp). p' = 0, or the round limit, means the Broker walks.

export type Mood = "calm" | "amused" | "irritated" | "insulted" | "sold";
export type SessionStatus = "open" | "sold" | "walked";

export const RULES = {
  startPatience: 100,
  maxRounds: 24,
  fatigue: 2,
  gapWeight: 80,
  insultGap: 0.5,
  insultPenalty: 10,
  nearGap: 0.1,
  lowballGap: 0.25,
  amusedGap: 0.08,
} as const;

export interface BrokerState {
  listPrice: number;
  floor: number;
  ask: number;
  patience: number;
  mood: Mood;
  /** Offers evaluated so far. */
  round: number;
  status: SessionStatus;
  finalPrice: number | null;
  lastOffer: number | null;
}

export interface RoundOutcome {
  round: number;
  offer: number;
  gap: number;
  patienceCost: number;
  concession: number;
  previousAsk: number;
  state: BrokerState;
}

export function drawFloor(item: Item, random01: number): number {
  if (!(random01 >= 0 && random01 < 1)) throw new Error("random01 must be in [0, 1)");
  const fraction = item.floorMin + random01 * (item.floorMax - item.floorMin);
  return Math.min(item.listPrice, ceilToCent(item.listPrice * fraction));
}

export function openBroker(listPrice: number, floor: number): BrokerState {
  if (!Number.isSafeInteger(listPrice) || listPrice <= 0) throw new Error("bad list price");
  if (!Number.isSafeInteger(floor) || floor <= 0 || floor > listPrice) throw new Error("bad floor");
  return {
    listPrice,
    floor,
    ask: listPrice,
    patience: RULES.startPatience,
    mood: "calm",
    round: 0,
    status: "open",
    finalPrice: null,
    lastOffer: null,
  };
}

export function relativeGap(ask: number, offer: number): number {
  if (ask <= 0) return 0;
  return Math.min(1, Math.max(0, (ask - offer) / ask));
}

export function patienceCost(gap: number): number {
  return RULES.fatigue + Math.ceil(RULES.gapWeight * gap * gap) + (gap > RULES.insultGap ? RULES.insultPenalty : 0);
}

export function concessionRate(gap: number): number {
  if (gap <= RULES.nearGap) return 0.5;
  if (gap <= RULES.lowballGap) return 0.3;
  if (gap <= RULES.insultGap) return 0.12;
  return 0;
}

export function patienceMultiplier(patience: number): number {
  if (patience >= 50) return 1;
  if (patience >= 25) return 0.75;
  return 0.5;
}

export function moodFor(gap: number, patience: number): Mood {
  if (gap > RULES.insultGap || patience < 25) return "insulted";
  if (gap > RULES.lowballGap || patience < 50) return "irritated";
  if (gap <= RULES.amusedGap) return "amused";
  return "calm";
}

/** Evaluate one offer. Pure: returns a new state and never mutates the input. */
export function evaluateOffer(state: BrokerState, offer: number): RoundOutcome {
  if (state.status !== "open") throw new Error(`session is ${state.status}`);
  if (!Number.isSafeInteger(offer) || offer < ATOMIC_PER_CENT) throw new Error("offer must be at least one cent");

  const round = state.round + 1;
  const previousAsk = state.ask;

  if (offer >= state.ask) {
    return {
      round,
      offer,
      gap: 0,
      patienceCost: 0,
      concession: 0,
      previousAsk,
      state: { ...state, round, mood: "sold", status: "sold", finalPrice: state.ask, lastOffer: offer },
    };
  }

  const gap = relativeGap(state.ask, offer);
  const cost = patienceCost(gap);
  const patience = Math.max(0, state.patience - cost);
  const rate = concessionRate(gap) * patienceMultiplier(state.patience);

  let ask = state.ask;
  if (rate > 0 && state.ask > state.floor) {
    const raw = ceilToCent(state.ask - rate * (state.ask - offer));
    ask = Math.max(state.floor, Math.min(raw, state.ask - ATOMIC_PER_CENT));
  }

  const walked = patience === 0 || round >= RULES.maxRounds;
  const next: BrokerState = {
    ...state,
    round,
    ask,
    patience,
    mood: walked ? "insulted" : moodFor(gap, patience),
    status: walked ? "walked" : "open",
    lastOffer: offer,
  };
  return { round, offer, gap, patienceCost: cost, concession: previousAsk - ask, previousAsk, state: next };
}

/** Public view of the Broker. Never includes the floor. */
export interface PublicBroker {
  listPrice: number;
  ask: number;
  patience: number;
  mood: Mood;
  round: number;
  status: SessionStatus;
  finalPrice: number | null;
}

export function publicView(state: BrokerState): PublicBroker {
  return {
    listPrice: state.listPrice,
    ask: state.ask,
    patience: state.patience,
    mood: state.mood,
    round: state.round,
    status: state.status,
    finalPrice: state.finalPrice,
  };
}
