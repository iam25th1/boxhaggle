import type { Mood, SessionStatus } from "./engine.js";
import { verifyReveal } from "./commit.js";
import type { StreamEvent } from "./events.js";
import { formatUsd } from "./money.js";
import { totalFees } from "./score.js";

// Monospace text frames of a session, for chat surfaces that cannot run UI.
// Pure functions. Every line of a frame has the same display width, counting
// East Asian wide and fullwidth characters as two columns and combining marks
// as zero. A live frame is built from public state only: it has no field for
// the floor or the salt, so it cannot leak them before the reveal.

export const FRAME_WIDTH = 46;
const INNER = FRAME_WIDTH - 4;

export const FACES: Readonly<Record<Mood | "walked", string>> = {
  calm: "(－‿－)",
  amused: "(¬‿¬)",
  irritated: "(¬_¬)",
  insulted: "(ಠ_ಠ)",
  sold: "(＾▽＾)",
  walked: "(ノಠ益ಠ)ノ",
};

export interface FrameRound {
  round: number;
  offer: number;
  fee: number;
  paid: boolean;
}

export interface FrameState {
  itemName: string;
  listPrice: number;
  ask: number;
  /** Ask before the latest reply, or null before any offer. */
  previousAsk: number | null;
  /** The agent's latest offer, or null before any offer. */
  lastOffer: number | null;
  patience: number;
  mood: Mood;
  status: SessionStatus;
  line: string;
  round: number;
  rounds: readonly FrameRound[];
  finalPrice: number | null;
}

export interface FrameReceipt {
  receiptId: string | null;
  /** Commitment published when the session opened. */
  publishedCommitment: string;
  reveal: { floor: number; salt: string; commitment: string } | null;
}

// [first, last] code point ranges, sorted. Wide and fullwidth (East Asian Width W and F).
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];
// Combining and other zero-width code points.
const ZERO: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f],
  [0x0900, 0x0902], [0x093c, 0x093c], [0x0941, 0x0948], [0x0cbc, 0x0cbc], [0x0cbf, 0x0cbf],
  [0x0cc6, 0x0cc6], [0x0ccc, 0x0ccd], [0x0ce2, 0x0ce3], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x2064], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff],
];

function inRanges(code: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [first, last] = ranges[mid]!;
    if (code < first) hi = mid - 1;
    else if (code > last) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Columns a string occupies in a monospace grid. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code < 0xa0) || inRanges(code, ZERO)) continue;
    width += inRanges(code, WIDE) ? 2 : 1;
  }
  return width;
}

/** One line of text that cannot break out of a frame or its code fence. */
function clean(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cuts a token wider than `width` into pieces that fit, so hashes and ids break instead of overflowing. */
function pieces(text: string, width: number): string[] {
  const full: string[] = [];
  let out = "";
  for (const ch of text) {
    if (out && displayWidth(out + ch) > width) {
      full.push(out);
      out = "";
    }
    out += ch;
  }
  return [...full, out];
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of clean(text).split(" ")) {
    if (!word) continue;
    const next = current ? `${current} ${word}` : word;
    if (displayWidth(next) <= width) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    const parts = pieces(word, width);
    current = parts.pop()!;
    lines.push(...parts);
  }
  if (current) lines.push(current);
  return lines;
}

const padEnd = (text: string, width: number) => text + " ".repeat(Math.max(0, width - displayWidth(text)));
/** Text as it is when it fits, otherwise word wrapped. Frame text is never cut. */
function fit(text: string, width: number): string[] {
  if (displayWidth(text) <= width) return [text];
  const lines = wrap(text, width);
  return lines.length ? lines : [""];
}

function row(text: string): string {
  return fit(text, INNER).map((line) => `│ ${padEnd(line, INNER)} │`).join("\n");
}

function center(text: string): string {
  const free = INNER - displayWidth(text);
  const left = Math.floor(free / 2);
  return `│ ${" ".repeat(left)}${text}${" ".repeat(free - left)} │`;
}

function spread(left: string, right: string): string {
  const gap = Math.max(1, INNER - displayWidth(left) - displayWidth(right));
  return row(`${left}${" ".repeat(gap)}${right}`);
}

const TOP = `┌${"─".repeat(FRAME_WIDTH - 2)}┐`;
const RULE = `├${"─".repeat(FRAME_WIDTH - 2)}┤`;
const BOTTOM = `└${"─".repeat(FRAME_WIDTH - 2)}┘`;

// Long values wrap under the value column, not under the label.
const label = (name: string, value: string) =>
  fit(value, INNER - 7).map((line, i) => row(`${(i ? "" : name).padEnd(7)}${line}`)).join("\n");
const roundNo = (n: number) => String(n).padStart(2, "0");

export function faceFor(mood: Mood, status: SessionStatus): string {
  return status === "walked" ? FACES.walked : FACES[mood];
}

function fuseBar(patience: number): string {
  const p = Math.max(0, Math.min(100, Math.round(patience)));
  const cells = 20;
  const lit = Math.round((p / 100) * cells);
  return `[${"█".repeat(lit)}${"░".repeat(cells - lit)}] ${String(p).padStart(3)}%`;
}

function askLine(ask: number, previous: number | null): string {
  if (previous === null) return `${formatUsd(ask)}  list ask`;
  if (ask < previous) return `${formatUsd(ask)}  ↓ from ${formatUsd(previous)}`;
  if (ask > previous) return `${formatUsd(ask)}  ↑ from ${formatUsd(previous)}`;
  return `${formatUsd(ask)}  = held`;
}

function moodWord(mood: Mood, status: SessionStatus): string {
  if (status === "walked") return "walked away";
  if (status === "sold") return "sold";
  return mood;
}

function speech(line: string): string[] {
  const text = clean(line);
  return text ? wrap(`"${text}"`, INNER) : [];
}

function ledger(rounds: readonly FrameRound[]): string[] {
  if (!rounds.length) return [row("No offers yet. Each offer is a paid x402 call.")];
  const shown = rounds.slice(-8);
  const out = [row("RND  OFFER     FEE      STATUS")];
  const earlier = rounds.length - shown.length;
  if (earlier > 0) out.push(row(`+${earlier} earlier round${earlier === 1 ? "" : "s"}`));
  for (const r of shown) {
    out.push(row(` ${roundNo(r.round)}  ${formatUsd(r.offer).padEnd(8)}  ${formatUsd(r.fee).padEnd(7)}  ${r.paid ? "paid" : "awaiting payment"}`));
  }
  return out;
}

function header(left: string, right: string): string[] {
  return [TOP, spread(left, right), RULE];
}

/** The live counter: face, dialogue, ask, last offer, fuse, mood and the round ledger. */
export function renderFrame(state: FrameState): string {
  const status = state.status === "open" ? `ROUND ${roundNo(state.round)}` : state.status === "sold" ? "SOLD" : "WALKED";
  const lines = [
    ...header("BOXHAGGLE  The Broker's Counter", status),
    center(faceFor(state.mood, state.status)),
    ...speech(state.line).map(row),
    RULE,
    label("ITEM", clean(state.itemName)),
    label("ASK", askLine(state.ask, state.previousAsk)),
    label("YOU", state.lastOffer === null ? "no offer yet" : formatUsd(state.lastOffer)),
    label("FUSE", fuseBar(state.patience)),
    label("MOOD", moodWord(state.mood, state.status)),
    RULE,
    ...ledger(state.rounds),
    BOTTOM,
  ];
  return lines.join("\n");
}

/** The closing receipt: deal, fees, score, the revealed floor and the commitment check. */
export function renderReceipt(state: FrameState, receipt: FrameReceipt): string {
  const paidFees = totalFees(state.rounds.filter((r) => r.paid).map((r) => r.fee));
  const paidRounds = state.rounds.filter((r) => r.paid).length;
  const deal = state.status === "sold" ? state.finalPrice : null;
  const reveal = receipt.reveal;
  const verified =
    reveal !== null &&
    reveal.commitment.toLowerCase() === receipt.publishedCommitment.toLowerCase() &&
    verifyReveal(receipt.publishedCommitment, reveal.floor, reveal.salt).verified;
  const commitment = receipt.publishedCommitment.toLowerCase();
  const lines = [
    ...header("BOXHAGGLE  RECEIPT", receipt.receiptId ? clean(receipt.receiptId) : deal === null ? "NO DEAL" : "UNPAID"),
    center(faceFor(state.mood, state.status)),
    ...speech(state.line).map(row),
    RULE,
    label("ITEM", clean(state.itemName)),
    label("DEAL", deal === null ? "no deal, the Broker walked" : formatUsd(deal)),
    label("FEES", `${formatUsd(paidFees)} over ${paidRounds} paid round${paidRounds === 1 ? "" : "s"}`),
    label("SCORE", deal === null ? "none without a deal" : `${formatUsd(deal + paidFees)}  deal plus fees`),
    label("FLOOR", reveal === null ? "sealed until the reveal" : `${formatUsd(reveal.floor)}  revealed`),
    label("COMMIT", commitment),
    label("CHECK", reveal === null ? "pending reveal" : `SHA-256(floor|salt) ${verified ? "VERIFIED" : "MISMATCH"}`),
    RULE,
    ...ledger(state.rounds),
    BOTTOM,
  ];
  return lines.join("\n");
}

/** A frame wrapped for Markdown, so chat clients keep it monospace. */
export function fenceFrame(frame: string): string {
  return `\`\`\`text\n${frame}\n\`\`\``;
}

/** The instruction carried next to every frame. */
export const FRAME_DISPLAY_NOTE =
  "Show the frame to the user exactly as given, inside its code block, before any commentary. Do not redraw, reflow or summarise it.";

export interface FrameSnapshot {
  state: FrameState;
  receipt: FrameReceipt;
}

/**
 * Rebuilds frame state from a session's public event stream. `pending` adds an
 * unpaid row for an offer that is waiting on its x402 payment.
 */
export function snapshotFromEvents(events: readonly StreamEvent[], pending: { offer: number; fee: number } | null = null): FrameSnapshot | null {
  const opened = events.find((ev) => ev.t === "session.opened");
  if (!opened || opened.t !== "session.opened") return null;
  const state: FrameState = {
    itemName: opened.itemName,
    listPrice: opened.listPrice,
    ask: opened.ask,
    previousAsk: null,
    lastOffer: null,
    patience: opened.patience,
    mood: "calm",
    status: "open",
    line: opened.line,
    round: 0,
    rounds: [],
    finalPrice: null,
  };
  const rounds: FrameRound[] = [];
  const receipt: FrameReceipt = { receiptId: null, publishedCommitment: opened.commitment, reveal: null };
  for (const ev of events) {
    if (ev.t === "offer.paid") {
      rounds.push({ round: ev.round, offer: ev.offer, fee: ev.fee, paid: true });
      state.round = ev.round;
      state.lastOffer = ev.offer;
    } else if (ev.t === "broker.reply") {
      state.previousAsk = ev.previousAsk;
      state.ask = ev.ask;
      state.lastOffer = ev.offer;
      state.patience = ev.patience;
      state.mood = ev.mood;
      state.status = ev.status;
      state.line = ev.line;
      state.round = ev.round;
      if (ev.status === "sold") state.finalPrice = ev.ask;
    } else if (ev.t === "checkout.paid") {
      state.finalPrice = ev.price;
      receipt.receiptId = ev.receiptId;
    } else if (ev.t === "reveal") {
      receipt.reveal = { floor: ev.floor, salt: ev.salt, commitment: ev.commitment };
    }
  }
  if (pending && state.status === "open") rounds.push({ round: state.round + 1, offer: pending.offer, fee: pending.fee, paid: false });
  state.rounds = rounds;
  return { state, receipt };
}

/** The live frame while the session is open, the receipt once it has closed. */
export function renderSnapshot(snapshot: FrameSnapshot): string {
  return snapshot.state.status === "open" ? renderFrame(snapshot.state) : renderReceipt(snapshot.state, snapshot.receipt);
}

/** The Broker's shelf, before any session: items and list prices. */
export function renderShelf(items: ReadonlyArray<{ id: string; name: string; listPrice: number }>, offerFee?: number): string {
  const lines = [
    ...header("BOXHAGGLE  The Broker's Shelf", `${items.length} ITEMS`),
    center(FACES.calm),
    ...speech("Take your time. Every offer costs you a little, so make it count.").map(row),
    RULE,
    ...items.map((item) => spread(clean(item.name), formatUsd(item.listPrice))),
    RULE,
    row(offerFee === undefined ? "Each offer is a small paid x402 call in USDC." : `Offers cost ${formatUsd(offerFee)} each, paid over x402 in USDC.`),
    BOTTOM,
  ];
  return lines.join("\n");
}
