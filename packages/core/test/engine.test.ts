import { describe, expect, it } from "vitest";
import {
  ATOMIC_PER_CENT,
  ITEMS,
  RULES,
  concessionRate,
  drawFloor,
  evaluateOffer,
  moodFor,
  openBroker,
  patienceCost,
  publicView,
  type BrokerState,
} from "../src/index.js";

const L = 1_800_000;
const F = 1_100_000;

describe("Broker engine", () => {
  it("opens at list price with full patience", () => {
    const s = openBroker(L, F);
    expect(s).toMatchObject({ ask: L, patience: 100, mood: "calm", round: 0, status: "open" });
  });

  it("accepts any offer at or above the ask, at the ask", () => {
    const s = openBroker(L, F);
    const out = evaluateOffer(s, L + 50_000);
    expect(out.state.status).toBe("sold");
    expect(out.state.mood).toBe("sold");
    expect(out.state.finalPrice).toBe(L);
    expect(out.patienceCost).toBe(0);
  });

  it("near offers lower the ask and cost little patience", () => {
    const s = openBroker(L, F);
    const offer = 1_650_000; // gap about 8.3%
    const out = evaluateOffer(s, offer);
    expect(out.state.ask).toBeLessThan(L);
    expect(out.state.ask).toBeGreaterThan(offer);
    expect(out.patienceCost).toBeLessThanOrEqual(3);
    expect(out.state.ask % ATOMIC_PER_CENT).toBe(0);
  });

  it("lowballs burn patience and barely move the ask", () => {
    const s = openBroker(L, F);
    const out = evaluateOffer(s, 300_000); // gap about 83%
    expect(out.patienceCost).toBeGreaterThan(40);
    expect(out.state.ask).toBe(L);
    expect(out.state.mood).toBe("insulted");
  });

  it("never drops the ask below the hidden floor", () => {
    let s: BrokerState = openBroker(L, F);
    for (let i = 0; i < 20 && s.status === "open"; i += 1) {
      const out = evaluateOffer(s, Math.max(ATOMIC_PER_CENT, Math.floor(s.ask * 0.92)));
      s = out.state;
      expect(s.ask).toBeGreaterThanOrEqual(F);
    }
  });

  it("walks when patience reaches zero and refuses further offers", () => {
    let s: BrokerState = openBroker(L, F);
    while (s.status === "open") s = evaluateOffer(s, 100_000).state;
    expect(s.status).toBe("walked");
    expect(s.patience).toBe(0);
    expect(() => evaluateOffer(s, L)).toThrow(/walked/);
  });

  it("walks at the round limit even with patience left", () => {
    let s: BrokerState = { ...openBroker(L, F), round: RULES.maxRounds - 1 };
    s = evaluateOffer(s, s.ask - ATOMIC_PER_CENT).state;
    expect(s.status).toBe("walked");
  });

  it("is deterministic and pure", () => {
    const s = openBroker(L, F);
    const a = evaluateOffer(s, 1_400_000);
    const b = evaluateOffer(s, 1_400_000);
    expect(a).toEqual(b);
    expect(s.ask).toBe(L);
  });

  it("rejects sub-cent and non-integer offers", () => {
    const s = openBroker(L, F);
    expect(() => evaluateOffer(s, 9_999)).toThrow();
    expect(() => evaluateOffer(s, 1.5)).toThrow();
  });

  it("matches the documented patience and concession formulas", () => {
    expect(patienceCost(0)).toBe(2);
    expect(patienceCost(0.1)).toBe(2 + 1);
    expect(patienceCost(0.25)).toBe(2 + 5);
    expect(patienceCost(0.6)).toBe(2 + Math.ceil(80 * 0.36) + 10);
    expect(concessionRate(0.05)).toBe(0.5);
    expect(concessionRate(0.2)).toBe(0.3);
    expect(concessionRate(0.4)).toBe(0.12);
    expect(concessionRate(0.7)).toBe(0);
  });

  it("maps gap and patience to moods", () => {
    expect(moodFor(0.05, 90)).toBe("amused");
    expect(moodFor(0.15, 90)).toBe("calm");
    expect(moodFor(0.3, 90)).toBe("irritated");
    expect(moodFor(0.15, 40)).toBe("irritated");
    expect(moodFor(0.6, 90)).toBe("insulted");
    expect(moodFor(0.05, 10)).toBe("insulted");
  });

  it("draws cent-aligned floors inside the item band", () => {
    for (const item of ITEMS) {
      for (const r of [0, 0.25, 0.5, 0.999]) {
        const floor = drawFloor(item, r);
        expect(floor % ATOMIC_PER_CENT).toBe(0);
        expect(floor).toBeGreaterThanOrEqual(Math.floor(item.listPrice * item.floorMin));
        expect(floor).toBeLessThanOrEqual(Math.ceil(item.listPrice * item.floorMax) + ATOMIC_PER_CENT);
      }
    }
    expect(() => drawFloor(ITEMS[0]!, 1)).toThrow();
  });

  it("public view never leaks the floor", () => {
    const view = publicView(openBroker(L, F));
    expect(JSON.stringify(view)).not.toContain(String(F));
    expect(view).not.toHaveProperty("floor");
  });
});

import { planMove } from "../src/strategy.js";

describe("strategy against the engine", () => {
  it("closes a deal below list on every item and floor band without the Broker walking", () => {
    for (const item of ITEMS) {
      for (const r of [0, 0.5, 0.99]) {
        const floor = drawFloor(item, r);
        let s = openBroker(item.listPrice, floor);
        let lastOffer: number | null = null;
        let previousAsk: number | null = null;
        const fees: number[] = [];
        for (let i = 0; i < 40 && s.status === "open"; i += 1) {
          const move = planMove({ listPrice: s.listPrice, ask: s.ask, patience: s.patience, mood: s.mood, round: s.round, lastOffer, previousAsk, fee: 10_000 });
          fees.push(10_000);
          const out = evaluateOffer(s, move.amount);
          previousAsk = out.previousAsk;
          lastOffer = move.amount;
          s = out.state;
        }
        expect(s.status).toBe("sold");
        const total = (s.finalPrice ?? 0) + fees.reduce((a, b) => a + b, 0);
        expect(total).toBeLessThan(item.listPrice);
        expect(total).toBeLessThan(3_000_000);
      }
    }
  });
});
