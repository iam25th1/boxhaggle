import { parseEventObject } from "../stream/validate";
import { generateReplay, type ReplayScript, type ReplayStep } from "./generate";

// Replay source. A recorded run dropped into ./recorded/*.json wins when its
// itemId matches; otherwise the generator builds one from the real game rules.

export type { ReplayScript, ReplayStep } from "./generate";

const recorded = import.meta.glob<unknown>("./recorded/*.json", { eager: true, import: "default" });

function asScript(value: unknown): ReplayScript | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { itemId?: unknown; events?: unknown };
  if (typeof v.itemId !== "string" || !Array.isArray(v.events)) return null;
  const events: ReplayStep[] = [];
  v.events.forEach((step: unknown, index) => {
    if (!step || typeof step !== "object") return;
    const s = step as { delayMs?: unknown; event?: unknown };
    const delayMs = typeof s.delayMs === "number" && Number.isFinite(s.delayMs) ? Math.min(Math.max(0, s.delayMs), 20_000) : 600;
    const event = parseEventObject(s.event, index + 1);
    if (event) events.push({ delayMs, event });
  });
  return events.length > 0 ? { itemId: v.itemId, events } : null;
}

export interface ReplaySource {
  script: ReplayScript;
  source: "recorded" | "generated";
}

export function replayFor(itemId: string): ReplaySource {
  for (const value of Object.values(recorded)) {
    const script = asScript(value);
    if (script && script.itemId === itemId) return { script, source: "recorded" };
  }
  return { script: generateReplay(itemId, { crossChain: true }), source: "generated" };
}
