import { describe, expect, it } from "vitest";
import {
  AgentEvent,
  CreateSessionBody,
  LINES,
  OPENING_LINES,
  OfferBody,
  WALK_LINES,
  brokerLine,
  commit,
  formatUsd,
  formatUsdPrecise,
  scorecard,
  sha256Hex,
  usdToAtomic,
  verifyReveal,
} from "../src/index.js";

const SALT = "a".repeat(64);

describe("commit-reveal", () => {
  it("round trips", () => {
    const h = commit(1_100_000, SALT);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyReveal(h, 1_100_000, SALT).verified).toBe(true);
  });

  it("matches the documented preimage F|salt", () => {
    expect(commit(1_100_000, SALT)).toBe(sha256Hex(`1100000|${SALT}`));
  });

  it("detects a moved floor or a swapped salt", () => {
    const h = commit(1_100_000, SALT);
    expect(verifyReveal(h, 1_110_000, SALT).verified).toBe(false);
    expect(verifyReveal(h, 1_100_000, "b".repeat(64)).verified).toBe(false);
  });

  it("rejects malformed reveals without throwing", () => {
    const h = commit(1_100_000, SALT);
    expect(verifyReveal(h, 1_100_000, "zz").verified).toBe(false);
    expect(verifyReveal(h, -5, SALT).verified).toBe(false);
  });
});

describe("scoring", () => {
  it("score is final price plus fees", () => {
    const card = scorecard(1_800_000, 1_200_000, [10_000, 10_000, 10_000]);
    expect(card).toEqual({ listPrice: 1_800_000, finalPrice: 1_200_000, fees: 30_000, rounds: 3, score: 1_230_000, savings: 570_000 });
  });

  it("a walk-away has no score", () => {
    const card = scorecard(1_800_000, null, [10_000]);
    expect(card.score).toBeNull();
    expect(card.savings).toBeNull();
    expect(card.fees).toBe(10_000);
  });

  it("savings can go negative when haggling costs more than it saves", () => {
    const card = scorecard(1_000_000, 990_000, Array(5).fill(10_000));
    expect(card.savings).toBe(-40_000);
  });
});

describe("dialogue", () => {
  it("has at least 12 hand-written lines per mood and pool", () => {
    for (const lines of Object.values(LINES)) expect(lines.length).toBeGreaterThanOrEqual(12);
    expect(WALK_LINES.length).toBeGreaterThanOrEqual(12);
    expect(OPENING_LINES.length).toBeGreaterThanOrEqual(12);
  });

  it("selects deterministically and fills placeholders", () => {
    const ctx = { ask: "$1.50", offer: "$1.00", item: "Tin Robot No. 7" };
    const a = brokerLine("seed", 3, "irritated", ctx);
    expect(brokerLine("seed", 3, "irritated", ctx)).toBe(a);
    expect(a).not.toMatch(/\{(ask|offer|item)\}/);
  });

  it("contains no em dashes", () => {
    const all = [...Object.values(LINES).flat(), ...WALK_LINES, ...OPENING_LINES].join("\n");
    expect(all.includes(String.fromCharCode(0x2014))).toBe(false);
  });
});

describe("money", () => {
  it("parses and formats without float drift", () => {
    expect(usdToAtomic("1.25")).toBe(1_250_000);
    expect(usdToAtomic("0.000001")).toBe(1);
    expect(() => usdToAtomic("1.2345678")).toThrow();
    expect(() => usdToAtomic("-1")).toThrow();
    expect(formatUsd(1_250_000)).toBe("$1.25");
    expect(formatUsdPrecise(5_000)).toBe("$0.005");
    expect(formatUsdPrecise(10_000)).toBe("$0.01");
  });
});

describe("schemas", () => {
  it("reject unknown fields", () => {
    expect(OfferBody.safeParse({ sessionId: "a".repeat(32), amount: "100", extra: 1 }).success).toBe(false);
    expect(CreateSessionBody.safeParse({ itemId: "tin-robot", admin: true }).success).toBe(false);
  });

  it("reject decimals and zero in atomic amounts", () => {
    expect(OfferBody.safeParse({ sessionId: "a".repeat(32), amount: "1.5" }).success).toBe(false);
    expect(OfferBody.safeParse({ sessionId: "a".repeat(32), amount: "0" }).success).toBe(false);
  });

  it("only lets PayBox and MoonPay https links through agent events", () => {
    const base = { t: "account.change", at: 1, note: "need a wallet" };
    expect(AgentEvent.safeParse({ ...base, manageUrl: "https://app.paybox.sh/clients/x/manage" }).success).toBe(true);
    expect(AgentEvent.safeParse({ ...base, manageUrl: "https://evil.example/paybox.sh" }).success).toBe(false);
    expect(AgentEvent.safeParse({ ...base, manageUrl: "http://app.paybox.sh/x" }).success).toBe(false);
  });

  it("agent events cannot impersonate merchant events", () => {
    expect(AgentEvent.safeParse({ t: "broker.reply", at: 1 }).success).toBe(false);
  });
});
