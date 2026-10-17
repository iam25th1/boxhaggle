import {
  ITEMS,
  RAILS,
  STRATEGY,
  brokerLine,
  commit,
  drawFloor,
  evaluateOffer,
  findItem,
  formatUsd,
  openBroker,
  planMove,
  scorecard,
  type BrokerState,
  type HaggleEvent,
  type Item,
  type StreamEvent,
} from "@boxhaggle/core";
import { base58String, hexString, mulberry32, seedFrom } from "./prng";

// Deterministic replay of a full BOXHAGGLE run. The haggling itself is the real
// game: a seeded floor, the real Broker engine, the real agent strategy, real
// Broker dialogue and a real SHA-256 commitment with a real reveal. Only the
// PayBox side (signatures, request ids, tx refs) is scripted around it.

export interface ReplayStep {
  /** Wait this long after the previous event before showing this one. */
  delayMs: number;
  event: StreamEvent;
}

export interface ReplayScript {
  itemId: string;
  events: ReplayStep[];
}

export interface GenerateOptions {
  /** Seed for the floor, salt and fake refs. Defaults to a hash of the item id. */
  seed?: number;
  /**
   * Bridge the swap to Base so the PayBox envelope passes through
   * pending_settlement. On by default so the departures board shows.
   */
  crossChain?: boolean;
}

type Draft<E> = E extends HaggleEvent ? Omit<E, "at"> : never;
type EventDraft = Draft<HaggleEvent>;

const FEE = 10_000;
const EPOCH = Date.UTC(2026, 9, 17, 21, 40, 0);
const APPROVAL_URL = "https://app.paybox.sh/approvals/demo";
const BUY_URL = "https://buy.moonpay.com/?currencyCode=usdc_sol";

export function generateReplay(itemId: string, options: GenerateOptions = {}): ReplayScript {
  const item: Item = findItem(itemId) ?? (ITEMS[0] as Item);
  const rnd = mulberry32(options.seed ?? seedFrom(`boxhaggle|${item.id}`));
  const crossChain = options.crossChain ?? true;

  const events: ReplayStep[] = [];
  let clock = EPOCH;
  let seq = 0;
  const push = (delayMs: number, draft: EventDraft): void => {
    clock += delayMs;
    seq += 1;
    events.push({ delayMs, event: { ...draft, at: clock, seq } as StreamEvent });
  };
  const requestId = (): string => `req_${hexString(rnd, 12)}`;
  const txRef = (): string => base58String(rnd, 88);

  // The merchant's secret side, drawn once.
  const floor = drawFloor(item, rnd());
  const salt = hexString(rnd, 64);
  const commitment = commit(floor, salt);
  const sessionId = hexString(rnd, 32);
  const walletAddress = `${base58String(rnd, 4)}...${base58String(rnd, 4)}`;
  const solana = RAILS.solana.v1Network;
  const base = RAILS.base.v1Network;
  const receiptRows: Array<{ requestId: string; kind: string; status: string }> = [];

  // ---- PayBox setup ----
  push(500, { t: "run.started", mode: "replay", capUsd: 3, strategy: STRATEGY.name });
  push(900, { t: "paybox.call", tool: "list_credentials", note: "Which credentials may this agent use?" });
  push(1000, {
    t: "credentials.listed",
    wallet: { present: true, chain: "solana", address: walletAddress },
    card: { present: false },
    secret: { present: true, name: "BROKER_DESK_KEY" },
  });

  const secretReq = requestId();
  push(1300, { t: "paybox.call", tool: "request_secret", note: "Desk key for the Broker's counter." });
  push(1000, {
    t: "paybox.envelope",
    tool: "request_secret",
    requestId: secretReq,
    status: "success",
    outputType: "secret_token",
    message: "Scoped token issued. The agent never sees the key.",
  });
  receiptRows.push({ requestId: secretReq, kind: "secret token", status: "issued" });

  const rawReq = requestId();
  push(1700, {
    t: "paybox.call",
    tool: "request_secret",
    note: "Fallback: a header the token cannot fill.",
  });
  push(1000, {
    t: "paybox.envelope",
    tool: "request_secret",
    requestId: rawReq,
    status: "success",
    outputType: "raw_secret",
    message: "Raw secret held in process memory only. Never logged, never shown.",
  });
  receiptRows.push({ requestId: rawReq, kind: "raw secret", status: "issued" });

  // ---- the haggle ----
  let state: BrokerState = openBroker(item.listPrice, floor);
  push(1900, {
    t: "session.opened",
    sessionId,
    itemId: item.id,
    itemName: item.name,
    art: item.art,
    listPrice: item.listPrice,
    ask: state.ask,
    patience: state.patience,
    commitment,
    offerFee: FEE,
    networks: [solana, base],
    channel: "sdk",
    line: brokerLine(sessionId, 0, "opening", { ask: formatUsd(state.ask), offer: "", item: item.name }),
  });

  const fees: number[] = [];
  let previousAsk: number | null = null;
  let walked = false;

  for (;;) {
    const move = planMove({
      listPrice: state.listPrice,
      ask: state.ask,
      patience: state.patience,
      mood: state.mood,
      round: state.round,
      lastOffer: state.lastOffer,
      previousAsk,
      fee: FEE,
    });
    const roundNo = state.round + 1;
    push(state.round === 0 ? 2300 : 2100, { t: "agent.thought", text: move.reason });

    const payReq = requestId();
    push(900, {
      t: "paybox.call",
      tool: "pay_x402",
      note: `Round ${roundNo}: offer ${formatUsd(move.amount)}, fee ${formatUsd(FEE)}.`,
    });
    push(500, { t: "paybox.envelope", tool: "pay_x402", requestId: payReq, status: "pending_signature" });
    push(900, {
      t: "paybox.envelope",
      tool: "pay_x402",
      requestId: payReq,
      status: "success",
      outputType: "signature",
      message: "Signed inside PayBox. Only the signature leaves.",
    });
    push(500, { t: "offer.paid", round: roundNo, offer: move.amount, fee: FEE, txRef: txRef(), network: solana });
    fees.push(FEE);
    receiptRows.push({ requestId: payReq, kind: `x402 offer r${roundNo}`, status: "settled" });

    const outcome = evaluateOffer(state, move.amount);
    state = outcome.state;
    previousAsk = outcome.previousAsk;
    const pool = state.status === "sold" ? "sold" : state.status === "walked" ? "walk" : state.mood;
    const shownAsk = state.status === "sold" ? (state.finalPrice ?? state.ask) : state.ask;
    push(1100, {
      t: "broker.reply",
      round: outcome.round,
      offer: outcome.offer,
      previousAsk: outcome.previousAsk,
      ask: shownAsk,
      patience: state.patience,
      mood: state.mood,
      status: state.status,
      line: brokerLine(sessionId, outcome.round, pool, {
        ask: formatUsd(shownAsk),
        offer: formatUsd(outcome.offer),
        item: item.name,
      }),
    });

    if (state.status === "walked") {
      walked = true;
      break;
    }
    if (state.status === "sold") break;
  }

  if (walked) {
    push(2400, { t: "reveal", floor, salt, commitment, verified: true });
    const card = scorecard(item.listPrice, null, fees);
    push(5200, { t: "score", ...card });
    push(1800, { t: "run.ended", outcome: "walked", reason: "The Broker ran out of patience." });
    return { itemId: item.id, events };
  }

  const price = state.finalPrice ?? state.ask;

  // ---- funding: short on USDC, so swap SOL ----
  push(2200, { t: "agent.thought", text: `Deal at ${formatUsd(price)}. Checking the wallet can cover checkout.` });
  push(900, { t: "paybox.call", tool: "get_portfolio", note: "USDC balance on Solana." });
  const have = Math.max(0, Math.floor(price * 0.42 / 10_000) * 10_000);
  push(900, { t: "funds.checked", need: price, have, asset: "USDC", network: solana, ok: false });
  push(1200, { t: "paybox.call", tool: "get_buy_link", note: "Card top-up link for a human, in case." });
  push(800, { t: "funds.buylink", url: BUY_URL, network: solana, currency: "usdc_sol" });
  push(1300, {
    t: "agent.thought",
    text: crossChain
      ? "The wallet holds SOL. Swapping some into USDC on Base, where checkout settles."
      : "The wallet holds SOL. Swapping some into USDC is faster than a top-up.",
  });
  push(1000, { t: "paybox.call", tool: "discover_tokens", note: "Resolving SOL and USDC mints." });
  const toChain = crossChain ? RAILS.base.payboxChain : RAILS.solana.payboxChain;
  push(1000, {
    t: "swap.quote",
    fromSymbol: "SOL",
    fromChain: RAILS.solana.payboxChain,
    toSymbol: "USDC",
    toChain,
    amountIn: "0.0124 SOL",
  });
  const swapReq = requestId();
  push(1500, { t: "paybox.call", tool: "request_swap", note: crossChain ? "SOL on Solana to USDC on Base." : "SOL to USDC on Solana." });
  push(700, { t: "paybox.envelope", tool: "request_swap", requestId: swapReq, status: "pending_signature" });
  push(150, { t: "swap.status", status: "pending_signature", requestId: swapReq });
  if (crossChain) {
    push(1500, {
      t: "paybox.envelope",
      tool: "request_swap",
      requestId: swapReq,
      status: "pending_settlement",
      message: "Bridging to Base.",
    });
    push(150, { t: "swap.status", status: "pending_settlement", requestId: swapReq });
  }
  push(crossChain ? 3600 : 1500, {
    t: "paybox.envelope",
    tool: "request_swap",
    requestId: swapReq,
    status: "pending_confirmation",
  });
  push(150, { t: "swap.status", status: "pending_confirmation", requestId: swapReq });
  push(2600, {
    t: "paybox.envelope",
    tool: "request_swap",
    requestId: swapReq,
    status: "success",
    outputType: "tx_hash",
  });
  push(150, { t: "swap.status", status: "success", requestId: swapReq });
  receiptRows.push({ requestId: swapReq, kind: crossChain ? "swap SOL to USDC, Base" : "swap SOL to USDC", status: "completed" });

  const checkoutNetwork = crossChain ? base : solana;
  push(1900, { t: "paybox.call", tool: "get_portfolio", note: "USDC balance after the swap." });
  push(800, {
    t: "funds.checked",
    need: price,
    have: price + 640_000,
    asset: "USDC",
    network: checkoutNetwork,
    ok: true,
  });

  // ---- checkout: over the auto-approve limit, so a passkey is needed ----
  const checkoutReq = requestId();
  push(1600, { t: "paybox.call", tool: "pay_x402", note: `Checkout at ${formatUsd(price)}.` });
  push(800, {
    t: "paybox.envelope",
    tool: "pay_x402",
    requestId: checkoutReq,
    status: "pending_approval",
    approvalUrl: APPROVAL_URL,
    message: "Over the auto-approve limit. Waiting for the owner's passkey.",
  });
  push(4200, {
    t: "paybox.envelope",
    tool: "pay_x402",
    requestId: checkoutReq,
    status: "success",
    outputType: "signature",
    message: "Approved with a passkey. Signed inside PayBox.",
  });
  const receiptId = `rcpt_${hexString(rnd, 10)}`;
  push(900, { t: "checkout.paid", price, txRef: txRef(), network: checkoutNetwork, receiptId });
  receiptRows.push({ requestId: checkoutReq, kind: "x402 checkout", status: "settled" });

  // ---- reveal, statement, score ----
  push(2200, { t: "reveal", floor, salt, commitment, verified: true });
  push(6200, { t: "paybox.call", tool: "list_requests", note: "Statement for this run." });
  push(800, { t: "receipt", rows: receiptRows.slice(0, 64) });
  const card = scorecard(item.listPrice, price, fees);
  push(2600, { t: "score", ...card });
  push(2200, { t: "run.ended", outcome: "deal", reason: `Bought the ${item.name} for ${formatUsd(price)}.` });

  return { itemId: item.id, events };
}
