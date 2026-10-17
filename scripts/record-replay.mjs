// Records a finished session's spectator stream into a UI replay script.
// Usage: node scripts/record-replay.mjs <merchantUrl> <sessionId> <out.json>
// The merchant replays a session's full history on connect, so this reads until
// run.ended (or a timeout) and converts event timestamps into replay delays.
import { writeFileSync } from "node:fs";

const [merchantUrl, sessionId, out] = process.argv.slice(2);
if (!merchantUrl || !/^[a-f0-9]{32}$/.test(sessionId ?? "") || !out) {
  console.error("usage: node scripts/record-replay.mjs <merchantUrl> <sessionId> <out.json>");
  process.exit(2);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15_000);
const res = await fetch(`${merchantUrl.replace(/\/+$/, "")}/events/${sessionId}`, { signal: controller.signal });
if (!res.ok || !res.body) {
  console.error(`stream failed: ${res.status}`);
  process.exit(1);
}

const events = [];
let buffer = "";
const decoder = new TextDecoder();
try {
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (data) events.push(JSON.parse(data));
    }
    if (events.some((event) => event.t === "run.ended")) break;
  }
} catch (error) {
  if (error.name !== "AbortError") throw error;
} finally {
  clearTimeout(timer);
  controller.abort();
}

events.sort((a, b) => a.at - b.at || a.seq - b.seq);
const opened = events.find((event) => event.t === "session.opened");
const script = {
  itemId: opened?.itemId ?? "unknown",
  recordedAt: new Date().toISOString(),
  source: "apps/agent --mock against a local merchant (FACILITATOR_MODE=local). REPLAY: no real funds moved.",
  events: events.map((event, index) => ({
    delayMs: index === 0 ? 400 : Math.min(2600, Math.max(120, event.at - events[index - 1].at)),
    event,
  })),
};
writeFileSync(out, `${JSON.stringify(script, null, 2)}\n`);
console.log(`recorded ${events.length} events for ${script.itemId} to ${out}`);
