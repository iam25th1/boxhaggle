import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/systems.css";
import "./fonts.css";
import "./counter.css";
import { App } from "@modelcontextprotocol/ext-apps";
import { animate } from "animejs";
import { formatUsd, formatUsdPrecise, type StreamEvent } from "@boxhaggle/core";
import { Director } from "../app/director";
import { motion } from "../app/motion";
import { Broker } from "../broker/broker";
import { byId, shortRef } from "../dom";
import { CoinTray } from "../systems/coins";
import { Docket } from "../systems/docket";
import { chainName } from "../systems/exchange";
import { Fuse } from "../systems/fuse";
import { PriceBoard } from "../systems/priceBoard";
import { Printer } from "../systems/printer";
import { Reveal } from "../systems/reveal";
import { Speech } from "../systems/speech";

// The Broker's counter inside a chat, as an MCP App. It makes no network
// connection: each tool result carries the session's public events, and the
// counter replays the new ones through the same systems as the web app.
// Events up to the call's starting point are applied instantly, so a fresh
// iframe opens on the current state and animates only what this call changed.

interface CounterResult {
  sessionId: string;
  phase: "opened" | "payment_required" | "paid" | "rejected" | "closed" | "revealed";
  events: StreamEvent[];
  fromSeq: number;
  budget?: { capUsd: string; spentUsd: string; remainingUsd: string };
  payment?: { amountUsd: string };
  frame?: string;
}

const stage = byId("stage");
const broker = new Broker(byId("broker-mount"));
const board = new PriceBoard(byId("board-mount"));
const speech = new Speech(byId("speech-mount"), byId("broker-live"));
const fuse = new Fuse(byId("fuse-mount"));
const printer = new Printer(byId("printer-mount"));
const tray = new CoinTray(byId("tray-mount"));
const docket = new Docket(byId("docket-mount"));
const reveal = new Reveal(byId("reveal-mount"));
const itemTag = byId("cx-item");
const roundTag = byId("cx-round");
const sealTag = byId("cx-seal");
const budgetTag = byId("cx-budget");
const revealWrap = byId("cx-reveal");
const fallback = byId<HTMLPreElement>("cx-fallback");

let commitment: string | null = null;
let ask = 0;
let lastSeq = -1;
let checkoutDue = false;

function setMood(mood: "calm" | "amused" | "irritated" | "insulted" | "sold", instant = false): void {
  stage.dataset.mood = mood;
  broker.setMood(mood, instant);
}

function apply(ev: StreamEvent): void {
  switch (ev.t) {
    case "session.opened":
      commitment = ev.commitment;
      ask = ev.ask;
      itemTag.textContent = ev.itemName;
      roundTag.textContent = "Round 00";
      board.open(ev.itemName, ev.listPrice, ev.ask);
      fuse.set(ev.patience, true);
      fuse.light();
      setMood("calm");
      speech.say(ev.line, "calm");
      broker.nod();
      sealTag.textContent = `Floor sealed: ${shortRef(ev.commitment, 10, 6)}`;
      reveal.seal(ev.commitment);
      break;
    case "offer.paid":
      roundTag.textContent = `Round ${String(ev.round).padStart(2, "0")}`;
      printer.print(ev);
      tray.drop(ev.fee);
      broker.glance(-3, 4, 700);
      docket.envelope({ tool: "pay_x402", status: "success", outputType: "signature", message: `Fee ${formatUsdPrecise(ev.fee)} on ${chainName(ev.network)}` });
      break;
    case "broker.reply": {
      const previous = ask;
      ask = ev.ask;
      fuse.set(ev.patience);
      if (ev.status === "sold") {
        board.sold(ev.ask);
        fuse.extinguish();
        setMood("sold");
        speech.say(ev.line, "sold");
        roundTag.textContent = "Sold";
      } else if (ev.status === "walked") {
        board.setAsk(ev.ask, previous);
        fuse.extinguish();
        setMood("insulted");
        speech.say(ev.line, "walk");
        roundTag.textContent = "Walked";
      } else {
        board.setAsk(ev.ask, previous);
        setMood(ev.mood);
        speech.say(ev.line, ev.mood);
      }
      broker.nod();
      break;
    }
    case "checkout.paid":
      docket.envelope({ tool: "pay_x402", status: "pending_settlement", message: `Paying ${formatUsd(ev.price)} on ${chainName(ev.network)}` });
      window.setTimeout(() => {
        docket.envelope({ tool: "pay_x402", status: "success", outputType: "tx_hash", message: `Settled ${formatUsd(ev.price)}` });
        docket.checkout(ev.price, chainName(ev.network), ev.receiptId);
      }, motion.reduced ? 0 : 1400);
      break;
    case "payment.rejected":
      docket.envelope({ tool: "pay_x402", status: "denied", message: `The Broker rejected the ${ev.route} payment: ${ev.reason}` });
      break;
    case "reveal":
      openReveal();
      reveal.open(commitment, ev);
      break;
    default:
      break;
  }
}

function openReveal(): void {
  if (!revealWrap.hidden) return;
  revealWrap.hidden = false;
  if (!motion.reduced) animate(revealWrap, { opacity: [0, 1], duration: 500, ease: "linear" });
}

const director = new Director(apply);
director.startLive();

/** Applies events without timelines: the systems take their reduced-motion path. */
function fastForward(events: StreamEvent[]): void {
  const reduced = motion.reduced;
  motion.reduced = true;
  try {
    for (const ev of events) apply(ev);
  } finally {
    motion.reduced = reduced;
  }
}

function isCounterResult(value: unknown): value is CounterResult {
  const v = value as CounterResult | null;
  return Boolean(v && typeof v.sessionId === "string" && Array.isArray(v.events) && typeof v.fromSeq === "number");
}

function stampFor(result: CounterResult): void {
  if (result.phase === "payment_required") {
    docket.call("pay_x402", `x402 requirement ${result.payment?.amountUsd ?? ""}: approve the payment in PayBox`);
    docket.envelope({ tool: "pay_x402", status: "pending_approval", message: "Waiting for the passkey in PayBox" });
    checkoutDue = stage.dataset.mood === "sold";
  }
  if (result.budget) budgetTag.textContent = `Budget ${result.budget.spentUsd} of ${result.budget.capUsd}`;
  stage.dataset.phase = result.phase;
}

function ingest(content: unknown, structured: unknown, isError: boolean | undefined): void {
  if (isError || !isCounterResult(structured)) {
    const text = Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? "").join("\n") : "";
    if (isError) {
      docket.envelope({ tool: "pay_x402", status: checkoutDue ? "denied" : "error", message: text.slice(0, 200) });
    } else if (text) {
      fallback.textContent = text;
      fallback.hidden = false;
    }
    return;
  }
  const events = structured.events.filter((ev) => typeof ev.seq === "number");
  if (lastSeq < 0) {
    fastForward(events.filter((ev) => ev.seq <= structured.fromSeq));
    lastSeq = structured.fromSeq;
  }
  for (const ev of events) {
    if (ev.seq > lastSeq) director.push(ev);
  }
  lastSeq = Math.max(lastSeq, ...events.map((ev) => ev.seq));
  stampFor(structured);
}

const app = new App({ name: "BOXHAGGLE counter", version: "0.1.0" });
app.addEventListener("toolinput", (params) => {
  const args = params.arguments ?? {};
  if (typeof args.payment === "string") {
    docket.envelope({ tool: "pay_x402", status: "pending_signature", message: "Signed in PayBox. Handing the proof to The Broker." });
  }
});
app.addEventListener("toolresult", (params) => ingest(params.content, params.structuredContent, params.isError));
void app.connect().catch((error: unknown) => {
  fallback.textContent = `The counter could not reach its host: ${error instanceof Error ? error.message : "unknown error"}.`;
  fallback.hidden = false;
});
