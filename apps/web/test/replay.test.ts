import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HaggleEvent, ITEMS, verifyReveal } from "@boxhaggle/core";
import { generateReplay } from "../src/replay/generate";

const strip = (event: Record<string, unknown>) => {
  const { seq: _seq, ...rest } = event;
  return rest;
};

describe("replay scripts", () => {
  it("generates a schema-valid full run for every item, ending in a verified reveal", () => {
    for (const item of ITEMS) {
      const script = generateReplay(item.id, { crossChain: true });
      expect(script.itemId).toBe(item.id);
      for (const step of script.events) {
        expect(step.delayMs).toBeGreaterThanOrEqual(0);
        expect(HaggleEvent.safeParse(strip(step.event as unknown as Record<string, unknown>)).success).toBe(true);
      }
      const types = script.events.map((s) => s.event.t);
      for (const t of ["session.opened", "broker.reply", "checkout.paid", "reveal", "score", "run.ended"]) expect(types).toContain(t);
      const opened = script.events.find((s) => s.event.t === "session.opened")!.event as { commitment: string };
      const reveal = script.events.find((s) => s.event.t === "reveal")!.event as { floor: number; salt: string; verified: boolean };
      expect(reveal.verified).toBe(true);
      expect(verifyReveal(opened.commitment, reveal.floor, reveal.salt).verified).toBe(true);
    }
  });

  it("recorded mock-agent runs are schema-valid and verify", () => {
    const dir = resolve(__dirname, "../src/replay/recorded");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const script = JSON.parse(readFileSync(resolve(dir, file), "utf8")) as { itemId: string; events: Array<{ delayMs: number; event: Record<string, unknown> }> };
      for (const step of script.events) expect(HaggleEvent.safeParse(strip(step.event)).success).toBe(true);
      const opened = script.events.find((s) => s.event.t === "session.opened")!.event as { commitment: string; itemId: string };
      const reveal = script.events.find((s) => s.event.t === "reveal")!.event as { floor: number; salt: string };
      expect(opened.itemId).toBe(script.itemId);
      expect(verifyReveal(opened.commitment, reveal.floor, reveal.salt).verified).toBe(true);
      expect(JSON.stringify(script)).not.toMatch(/merchant-key|pbx_live_|pbxk1\./);
    }
  });
});
