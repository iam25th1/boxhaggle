import { describe, expect, it } from "vitest";
import {
  FACES,
  FRAME_WIDTH,
  ITEMS,
  LINES,
  OPENING_LINES,
  RULES,
  WALK_LINES,
  commit,
  displayWidth,
  evaluateOffer,
  fenceFrame,
  fillLine,
  formatUsd,
  openBroker,
  renderFrame,
  renderReceipt,
  renderShelf,
  renderSnapshot,
  snapshotFromEvents,
  type FrameState,
  type Mood,
  type StreamEvent,
} from "../src/index.js";

const SALT = "b".repeat(64);
const FLOOR = 1_310_000;
const EMOJI = /\p{Extended_Pictographic}/u;
const EM_DASH = String.fromCharCode(0x2014);

function base(overrides: Partial<FrameState> = {}): FrameState {
  return {
    itemName: "Brass Pocket Compass",
    listPrice: 1_800_000,
    ask: 1_620_000,
    previousAsk: 1_800_000,
    lastOffer: 1_200_000,
    patience: 52,
    mood: "irritated",
    status: "open",
    line: "You call that an offer? I have seen better bids at a jumble sale, friend.",
    round: 3,
    rounds: [
      { round: 1, offer: 1_000_000, fee: 10_000, paid: true },
      { round: 2, offer: 1_100_000, fee: 10_000, paid: true },
      { round: 3, offer: 1_200_000, fee: 10_000, paid: true },
    ],
    finalPrice: null,
    ...overrides,
  };
}

function assertFrame(frame: string) {
  const lines = frame.split("\n");
  for (const line of lines) expect(displayWidth(line), line).toBe(FRAME_WIDTH);
  expect(frame).not.toMatch(EMOJI);
  expect(frame).not.toContain(EM_DASH);
  expect(frame).not.toContain("`");
  return lines;
}

const inner = (line: string) => line.slice(1, -1).trim();

describe("frames: display width", () => {
  it("counts wide, fullwidth and combining characters", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("(＾▽＾)")).toBe(7);
    expect(displayWidth("(ノಠ益ಠ)ノ")).toBe(10);
    expect(displayWidth("(－‿－)")).toBe(7);
    expect(displayWidth("é")).toBe(1);
    expect(displayWidth("│─┌█░↓")).toBe(6);
  });
});

describe("frames: live counter", () => {
  const moods: Mood[] = ["calm", "amused", "irritated", "insulted", "sold"];

  it.each(moods)("keeps every line the same width with the %s face on its own line", (mood) => {
    const frame = renderFrame(base({ mood, status: mood === "sold" ? "sold" : "open", finalPrice: mood === "sold" ? 1_460_000 : null }));
    const lines = assertFrame(frame);
    expect(lines.map(inner)).toContain(FACES[mood]);
    expect(frame).toContain("ASK    $1.62  ↓ from $1.80");
    expect(frame).toContain("YOU    $1.20");
    expect(frame).toContain("FUSE   [██████████░░░░░░░░░░]  52%");
  });

  it("shows the walked-away face and status", () => {
    const frame = renderFrame(base({ status: "walked", mood: "insulted", patience: 0 }));
    const lines = assertFrame(frame);
    expect(lines.map(inner)).toContain(FACES.walked);
    expect(frame).toContain("MOOD   walked away");
    expect(frame).toContain("WALKED");
  });

  it("wraps long dialogue, neutralises backticks and control characters", () => {
    const line = `${"haggle ".repeat(40)}\`\`\`rm -rf\`\`\` \u0007 ${"x".repeat(80)}`;
    const frame = renderFrame(base({ line, itemName: "A very long item name that will not fit on one line of the frame at all" }));
    assertFrame(frame);
    expect(frame).not.toContain("\u0007");
  });

  it("lists an unpaid round as awaiting payment and caps the ledger", () => {
    const rounds = Array.from({ length: 11 }, (_, i) => ({ round: i + 1, offer: 1_000_000 + i * 10_000, fee: 10_000, paid: i < 10 }));
    const frame = renderFrame(base({ rounds, round: 10 }));
    assertFrame(frame);
    expect(frame).toContain("awaiting payment");
    expect(frame).toContain("3 earlier rounds");
  });

  it("starts with no offers and the list ask", () => {
    const frame = renderFrame(base({ previousAsk: null, lastOffer: null, rounds: [], round: 0, mood: "calm", patience: 100 }));
    assertFrame(frame);
    expect(frame).toContain("list ask");
    expect(frame).toContain("no offer yet");
  });
});

describe("frames: receipt", () => {
  const sold = base({ status: "sold", mood: "sold", ask: 1_460_000, finalPrice: 1_460_000, line: "Sold. Pleasure doing business." });
  const published = commit(FLOOR, SALT);

  it("shows VERIFIED only when the reveal matches the published commitment", () => {
    const frame = renderReceipt(sold, { receiptId: "BH-1A2B3C4D", publishedCommitment: published, reveal: { floor: FLOOR, salt: SALT, commitment: published } });
    const lines = assertFrame(frame);
    expect(lines.map(inner)).toContain(FACES.sold);
    expect(frame).toContain("DEAL   $1.46");
    expect(frame).toContain("FEES   $0.03 over 3 paid rounds");
    expect(frame).toContain("SCORE  $1.49  deal plus fees");
    expect(frame).toContain("FLOOR  $1.31  revealed");
    expect(frame).toContain("SHA-256(floor|salt) VERIFIED");
  });

  it("shows MISMATCH for a wrong salt or a swapped commitment", () => {
    const wrongSalt = renderReceipt(sold, { receiptId: null, publishedCommitment: published, reveal: { floor: FLOOR, salt: "c".repeat(64), commitment: published } });
    assertFrame(wrongSalt);
    expect(wrongSalt).toContain("MISMATCH");
    const swapped = commit(FLOOR + 1, SALT);
    const moved = renderReceipt(sold, { receiptId: null, publishedCommitment: published, reveal: { floor: FLOOR + 1, salt: SALT, commitment: swapped } });
    expect(moved).toContain("MISMATCH");
  });

  it("handles a walk-away and a pending reveal", () => {
    const frame = renderReceipt(base({ status: "walked", patience: 0 }), { receiptId: null, publishedCommitment: published, reveal: null });
    assertFrame(frame);
    expect(frame).toContain("NO DEAL");
    expect(frame).toContain("sealed until the reveal");
    expect(frame).toContain("pending reveal");
  });
});

describe("frames: from the event stream", () => {
  const item = ITEMS[0]!;
  const published = commit(FLOOR, SALT);

  function play(offers: number[]): StreamEvent[] {
    let broker = openBroker(item.listPrice, FLOOR);
    const events: StreamEvent[] = [
      {
        t: "session.opened", at: 1, sessionId: "s".repeat(32), itemId: item.id, itemName: item.name, art: item.art,
        listPrice: item.listPrice, ask: broker.ask, patience: broker.patience, commitment: published, offerFee: 10_000,
        networks: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"], channel: "plugin", line: "Welcome to the counter.",
      },
    ];
    for (const offer of offers) {
      if (broker.status !== "open") break;
      const out = evaluateOffer(broker, offer);
      broker = out.state;
      events.push({ t: "offer.paid", at: 2, round: out.round, offer, fee: 10_000, txRef: "tx", network: "solana" });
      events.push({ t: "broker.reply", at: 3, round: out.round, offer, previousAsk: out.previousAsk, ask: broker.ask, patience: broker.patience, mood: broker.mood, status: broker.status, line: "Hmm." });
    }
    return events;
  }

  it("never puts the floor or salt in a frame before the reveal", () => {
    const events = play([item.listPrice / 2, item.listPrice * 0.7, item.listPrice * 0.8].map(Math.round));
    const snapshot = snapshotFromEvents(events, { offer: 900_000, fee: 10_000 })!;
    const frame = renderSnapshot(snapshot);
    assertFrame(frame);
    expect(frame).not.toContain(SALT.slice(0, 12));
    expect(frame).not.toMatch(/floor/i);
    expect(snapshot.receipt.reveal).toBeNull();
  });

  it("turns into a verified receipt after checkout and reveal", () => {
    const events = play(Array.from({ length: 30 }, (_, i) => Math.round(item.listPrice * (0.75 + i * 0.01))));
    const reply = events.filter((ev) => ev.t === "broker.reply").at(-1);
    expect(reply && reply.t === "broker.reply" && reply.status).not.toBe("open");
    events.push({ t: "checkout.paid", at: 4, price: 1_500_000, txRef: "tx", network: "solana", receiptId: "BH-00FF00FF" });
    events.push({ t: "reveal", at: 5, floor: FLOOR, salt: SALT, commitment: published, verified: true });
    const frame = renderSnapshot(snapshotFromEvents(events)!);
    assertFrame(frame);
    expect(frame).toMatch(/VERIFIED|NO DEAL/);
  });

  it("draws the shelf at the same width", () => {
    const frame = renderShelf(ITEMS, 10_000);
    assertFrame(frame);
    for (const it of ITEMS) expect(frame).toContain(it.name);
  });

  it("fences a frame for Markdown", () => {
    expect(fenceFrame("x")).toBe("```text\nx\n```");
  });
});

describe("frames: wrap, never cut", () => {
  const FOOTER = "No offers yet. Each offer is a paid x402 call.";
  const ELLIPSIS = /\.\.\.|\u2026/;
  const longest = ITEMS.reduce((a, b) => (displayWidth(b.name) > displayWidth(a.name) ? b : a));
  const published = commit(FLOOR, SALT);
  const ctx = (item: { name: string; listPrice: number }) => ({ ask: formatUsd(item.listPrice), offer: "$1.00", item: item.name });
  const rounds = (n: number) => Array.from({ length: n }, (_, i) => ({ round: i + 1, offer: 1_000_000 + i * 10_000, fee: 10_000, paid: i < n - 1 }));

  /** Every line the same width, nothing cut, and each text whole once the wrapped lines are joined. */
  function assertUncut(frame: string, ...texts: string[]) {
    const lines = assertFrame(frame);
    for (const line of lines) expect(line, line).not.toMatch(ELLIPSIS);
    const flat = lines.map(inner).join(" ").replace(/\s+/g, " ");
    for (const text of texts) expect(flat).toContain(text);
    return lines;
  }

  it.each(ITEMS.map((item) => [item.id, item] as const))("opens %s with the whole greeting and footer", (_id, item) => {
    for (const template of OPENING_LINES) {
      const line = fillLine(template, ctx(item));
      const frame = renderFrame(base({ itemName: item.name, ask: item.listPrice, previousAsk: null, lastOffer: null, rounds: [], round: 0, mood: "calm", patience: 100, line }));
      assertUncut(frame, `"${line}"`, FOOTER, `ITEM ${item.name}`);
    }
  });

  it.each(Object.keys(LINES) as Mood[])("keeps every %s line whole for the longest item", (mood) => {
    for (const template of LINES[mood]) {
      const line = fillLine(template, ctx(longest));
      const sold = mood === "sold";
      const state = base({ itemName: longest.name, mood, line, status: sold ? "sold" : "open", finalPrice: sold ? 1_460_000 : null });
      assertUncut(renderFrame(state), `"${line}"`, longest.name);
      if (sold) assertUncut(renderReceipt(state, { receiptId: "BH-1A2B3C4D", publishedCommitment: published, reveal: null }), `"${line}"`);
    }
  });

  it("keeps every walk-away line whole, live and on the receipt, with or without rounds", () => {
    for (const template of WALK_LINES) {
      const line = fillLine(template, ctx(longest));
      for (const r of [[], base().rounds]) {
        const state = base({ itemName: longest.name, status: "walked", mood: "insulted", patience: 0, line, rounds: r });
        assertUncut(renderFrame(state), `"${line}"`, "WALKED");
        const receipt = renderReceipt(state, { receiptId: null, publishedCommitment: published, reveal: null });
        assertUncut(receipt, `"${line}"`, "NO DEAL", ...(r.length ? [] : [FOOTER]));
      }
    }
  });

  it.each([
    ["VERIFIED", SALT],
    ["MISMATCH", "c".repeat(64)],
  ])("prints the full commitment on a %s receipt, broken across lines", (word, salt) => {
    const sold = base({ status: "sold", mood: "sold", ask: 1_460_000, finalPrice: 1_460_000, line: "Sold. Pleasure doing business." });
    const frame = renderReceipt(sold, { receiptId: "BH-1A2B3C4D", publishedCommitment: published, reveal: { floor: FLOOR, salt, commitment: published } });
    const lines = assertUncut(frame, `SHA-256(floor|salt) ${word}`, "BH-1A2B3C4D");
    const at = lines.findIndex((line) => inner(line).startsWith("COMMIT"));
    const hash = [lines[at]!, lines[at + 1]!].map((line) => inner(line).replace(/^COMMIT/, "").trim()).join("");
    expect(hash).toBe(published);
    expect(lines[at + 1]!.startsWith(`│ ${" ".repeat(7)}`)).toBe(true);
  });

  it("shows the latest rounds of a max-round ledger and counts the rest", () => {
    const n = RULES.maxRounds;
    const frame = renderFrame(base({ rounds: rounds(n), round: n - 1 }));
    const lines = assertUncut(frame, `+${n - 8} earlier rounds`, "awaiting payment");
    expect(lines.filter((line) => /^│ {2}\d{2} {2}/.test(line))).toHaveLength(8);
    expect(frame).toContain(`  ${n}  `);
    expect(frame).not.toContain("  01  ");
    expect(lines.length).toBeLessThan(30);
    assertUncut(renderFrame(base({ rounds: rounds(9), round: 8 })), "STATUS +1 earlier round 02");
  });

  it("wraps both shelf footers whole", () => {
    assertUncut(renderShelf(ITEMS), "Each offer is a small paid x402 call in USDC.", ...ITEMS.map((item) => item.name));
    assertUncut(renderShelf(ITEMS, 10_000), "Offers cost $0.01 each, paid over x402 in USDC.");
  });

  it("breaks long tokens and long names across lines without losing a character", () => {
    const token = "f".repeat(100);
    const name = "A very long item name that will not fit on one line of the frame at all";
    const line = `${"Haggle hard. ".repeat(20).trim()} ${token}`;
    const lines = assertUncut(renderFrame(base({ itemName: name, line })), name);
    const flat = lines.map(inner).join("");
    expect(flat).toContain(token);
    expect(flat.replace(/\s+/g, "")).toContain(line.replace(/\s+/g, ""));
    const at = lines.findIndex((l) => inner(l).startsWith("ITEM"));
    expect(lines[at + 1]!.startsWith(`│ ${" ".repeat(7)}`)).toBe(true);
  });
});
