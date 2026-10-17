import * as z from "zod/v4";
import {
  FRAME_DISPLAY_NOTE,
  ITEMS,
  agentText,
  fenceFrame,
  formatUsd,
  renderShelf,
  renderSnapshot,
  snapshotFromEvents,
  usdToAtomic,
  verifyReveal,
  type FrameSnapshot,
  type StreamEvent,
} from "@boxhaggle/core";
import { proposeX402 } from "./paybox.js";

// BOXHAGGLE tool logic, separate from MCP wiring so it can be unit tested with
// an injected fetch. Hosted constraints (developer.paybox.sh/requirements.md):
// fresh sandbox per call, 10 s budget, HTTPS only to configured hosts, the
// merchant key arrives as a PayBox brokered header (never read from env), and
// x402 proposals carry no custom headers or secrets.

export const CHAINS = ["solana:mainnet", "eip155:8453"] as const;
export type Chain = (typeof CHAINS)[number];
const FETCH_TIMEOUT_MS = 4_000;

export interface ToolEnv {
  merchantUrl: string | undefined;
  fetch: typeof fetch;
}

export class ToolError extends Error {}

export function merchantBase(env: ToolEnv): string {
  if (!env.merchantUrl) throw new ToolError("BOXHAGGLE_MERCHANT_URL is not configured for this plugin.");
  const url = new URL(env.merchantUrl);
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.search || url.hash) {
    throw new ToolError("BOXHAGGLE_MERCHANT_URL must be a plain https origin.");
  }
  return url.origin;
}

async function getJson(env: ToolEnv, path: string, init?: RequestInit): Promise<unknown> {
  const res = await env.fetch(`${merchantBase(env)}${path}`, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ToolError(`The Broker answered ${res.status} with a non-JSON body.`);
  }
  if (!res.ok) {
    const error = (body as { error?: unknown; message?: unknown }) ?? {};
    throw new ToolError(`The Broker answered ${res.status}: ${String(error.message ?? error.error ?? "error").slice(0, 160)}`);
  }
  return body;
}

const SessionView = z.object({
  sessionId: z.string(),
  item: z.object({ id: z.string(), name: z.string() }).loose(),
  listPrice: z.number().int(),
  ask: z.number().int(),
  patience: z.number().int(),
  mood: z.string(),
  round: z.number().int(),
  status: z.enum(["open", "sold", "walked"]),
  finalPrice: z.number().int().nullable(),
  offerFee: z.number().int(),
  commitment: z.string(),
  checkoutPaid: z.boolean(),
  line: z.string().optional(),
}).loose();
type SessionView = z.infer<typeof SessionView>;

const sessionIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const itemIds = ITEMS.map((item) => item.id) as [string, ...string[]];

// ---- schemas ----

export const ItemsOutput = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string(), blurb: z.string(), listPriceUsd: z.string(), listPriceAtomic: z.string() }).strict()),
  howToPlay: z.string(),
  frame: z.string(),
  display: z.string(),
}).strict();

export const OpenInput = z.object({ itemId: z.enum(itemIds) }).strict();
export const SessionOutput = z.object({
  sessionId: z.string(),
  itemName: z.string(),
  status: z.enum(["open", "sold", "walked"]),
  listPriceUsd: z.string(),
  askUsd: z.string(),
  patience: z.number().int(),
  mood: z.string(),
  round: z.number().int(),
  finalPriceUsd: z.string().nullable(),
  offerFeeAtomic: z.string(),
  commitment: z.string(),
  checkoutPaid: z.boolean(),
  brokerSays: z.string(),
  nextStep: z.string(),
  frame: z.string(),
  display: z.string(),
}).strict();

export const SessionInput = z.object({ sessionId: sessionIdSchema }).strict();
export const OfferInput = z.object({
  sessionId: sessionIdSchema,
  offerUsd: z.string().regex(/^(0|[1-9][0-9]{0,4})(\.[0-9]{1,2})?$/, "offerUsd is a dollar amount such as 1.25"),
  chain: z.enum(CHAINS).default("solana:mainnet"),
}).strict();
export const CheckoutInput = z.object({ sessionId: sessionIdSchema, chain: z.enum(CHAINS).default("solana:mainnet") }).strict();

export const RevealOutput = z.object({
  sessionId: z.string(),
  floorUsd: z.string(),
  floorAtomic: z.string(),
  salt: z.string(),
  commitment: z.string(),
  verifiedByBroker: z.boolean(),
  verifiedHere: z.boolean(),
  frame: z.string(),
  display: z.string(),
}).strict();

// ---- handlers ----

export function listItems() {
  const structured = {
    items: ITEMS.map((item) => ({
      id: item.id,
      name: item.name,
      blurb: item.blurb,
      listPriceUsd: formatUsd(item.listPrice),
      listPriceAtomic: String(item.listPrice),
    })),
    howToPlay:
      "Open a session, then propose offers. Each offer is a paid x402 call (about 0.01 USDC) that PayBox pays after your approval. The Broker lowers the ask for near offers and loses patience on lowballs. When The Broker says sold, propose the checkout for the exact agreed price, then reveal the hidden floor.",
    frame: fenceFrame(renderShelf(ITEMS)),
    display: FRAME_DISPLAY_NOTE,
  };
  return withFrame(structured.frame, structured.items.map((i) => `${i.id}: ${i.name}, ${i.listPriceUsd}`).join("\n"), structured, {
    items: structured.items.map((i) => ({ itemId: i.id, name: i.name, listPriceUsd: i.listPriceUsd })),
    nextStep: "Call boxhaggle_open_session with one itemId.",
  });
}

function present(view: SessionView) {
  const next =
    view.status === "open"
      ? "Call boxhaggle_propose_offer with an offer in dollars."
      : view.status === "sold" && !view.checkoutPaid
        ? "Call boxhaggle_propose_checkout to pay the agreed price."
        : "Call boxhaggle_reveal to see the hidden floor and verify it.";
  return {
    sessionId: view.sessionId,
    itemName: view.item.name,
    status: view.status,
    listPriceUsd: formatUsd(view.listPrice),
    askUsd: formatUsd(view.ask),
    patience: view.patience,
    mood: view.mood,
    round: view.round,
    finalPriceUsd: view.finalPrice === null ? null : formatUsd(view.finalPrice),
    offerFeeAtomic: String(view.offerFee),
    commitment: view.commitment,
    checkoutPaid: view.checkoutPaid,
    brokerSays: (view.line ?? "").slice(0, 280),
    nextStep: next,
  };
}

function sessionResult(view: SessionView, frame: string) {
  const structured = { ...present(view), frame, display: FRAME_DISPLAY_NOTE };
  return withFrame(frame, `${structured.itemName}: ${structured.status}, ask ${structured.askUsd}, patience ${structured.patience}, mood ${structured.mood}. ${structured.nextStep}`, structured, present(view));
}

/** Frame first, then the note telling the agent to show it as is, then the plain summary. */
function withFrame<T>(frame: string, summary: string, structuredContent: T, data: Record<string, unknown>, revealed = false) {
  // The AGENT DATA block closes the text, for agents that never see structuredContent.
  return { content: [{ type: "text" as const, text: agentText(frame, summary, data, { revealed }) }], structuredContent };
}

const EventsView = z.object({ events: z.array(z.object({ t: z.string() }).loose()).max(1000) }).loose();

/** The session's public events, or null when they cannot be read in time. */
async function history(env: ToolEnv, sessionId: string): Promise<StreamEvent[] | null> {
  try {
    const parsed = EventsView.safeParse(await getJson(env, `/session/${sessionId}/events`));
    return parsed.success ? (parsed.data.events as unknown as StreamEvent[]) : null;
  } catch {
    return null;
  }
}

/** A frame from the view alone, used when the event history is unavailable. */
function snapshotFromView(view: SessionView): FrameSnapshot {
  return {
    state: {
      itemName: view.item.name,
      listPrice: view.listPrice,
      ask: view.ask,
      previousAsk: null,
      lastOffer: null,
      patience: view.patience,
      mood: view.mood as FrameSnapshot["state"]["mood"],
      status: view.status,
      line: view.line ?? "",
      round: view.round,
      rounds: [],
      finalPrice: view.finalPrice,
    },
    receipt: { receiptId: null, publishedCommitment: view.commitment, reveal: null },
  };
}

async function frameFor(env: ToolEnv, view: SessionView, pending: { offer: number; fee: number } | null = null): Promise<string> {
  const events = await history(env, view.sessionId);
  const snapshot = (events && snapshotFromEvents(events, pending)) ?? snapshotFromView(view);
  return fenceFrame(renderSnapshot(snapshot));
}

async function readSession(env: ToolEnv, sessionId: string): Promise<SessionView> {
  const parsed = SessionView.safeParse(await getJson(env, `/session/${sessionId}`));
  if (!parsed.success) throw new ToolError("The Broker returned an unexpected session shape.");
  return parsed.data;
}

export async function openSession(env: ToolEnv, input: z.infer<typeof OpenInput>) {
  // PayBox adds the brokered X-Merchant-Key header for the merchant host.
  const body = await getJson(env, "/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ itemId: input.itemId, channel: "plugin" }),
  });
  const parsed = SessionView.safeParse(body);
  if (!parsed.success) throw new ToolError("The Broker returned an unexpected session shape.");
  return sessionResult(parsed.data, await frameFor(env, parsed.data));
}

export async function status(env: ToolEnv, input: z.infer<typeof SessionInput>) {
  const view = await readSession(env, input.sessionId);
  return sessionResult(view, await frameFor(env, view));
}

export async function proposeOffer(env: ToolEnv, input: z.infer<typeof OfferInput>) {
  const view = await readSession(env, input.sessionId);
  if (view.status !== "open") throw new ToolError(`This session is ${view.status}; no more offers.`);
  const amount = usdToAtomic(input.offerUsd);
  if (amount < 10_000) throw new ToolError("Offers start at 0.01 USD.");
  if (amount > view.listPrice * 4) throw new ToolError("That offer is far above the list price.");
  const frame = await frameFor(env, view, { offer: amount, fee: view.offerFee });
  return framedProposal(frame, view, { offerUsd: input.offerUsd, amountUsd: formatUsd(view.offerFee) }, {
    chain: input.chain,
    url: `${merchantBase(env)}/offer`,
    method: "POST",
    body: { sessionId: input.sessionId, amount: String(amount) },
    maxAmount: String(view.offerFee),
  });
}

// From PayBox's guide (x402 payment proposals): PayBox fetches the live 402,
// checks asset and amount, asks for approval, pays and retries the request.
const PROPOSAL_NEXT = {
  offer:
    "PayBox checks this x402 proposal against the live 402, asks for approval, pays and retries the offer. Follow the PayBox request id until it is terminal; do not pay it again with pay_x402 or rerun this tool to finish it. Then call boxhaggle_status with sessionId for The Broker's reply.",
  checkout:
    "PayBox checks this x402 proposal against the live 402, asks for approval, pays and retries the checkout. Follow the PayBox request id until it is terminal; do not pay it again with pay_x402 or rerun this tool to finish it. Then call boxhaggle_reveal with sessionId.",
};

/** The proposal output stays exactly the starter's; the frame rides in the text only. */
function framedProposal(frame: string, view: SessionView, extra: Record<string, unknown>, input: Parameters<typeof proposeX402>[0]) {
  const out = proposeX402(input);
  const data = {
    ...present(view),
    ...extra,
    proposal: out.structuredContent["io.paybox/transactionProposal"],
    nextStep: PROPOSAL_NEXT[input.url.endsWith("/checkout") ? "checkout" : "offer"],
  };
  return { ...out, content: [{ type: "text" as const, text: agentText(frame, out.content[0]!.text, data) }] };
}

export async function proposeCheckout(env: ToolEnv, input: z.infer<typeof CheckoutInput>) {
  const view = await readSession(env, input.sessionId);
  if (view.status !== "sold" || view.finalPrice === null) throw new ToolError("No deal yet. Keep haggling until The Broker says sold.");
  if (view.checkoutPaid) throw new ToolError("This deal is already paid.");
  const frame = await frameFor(env, view);
  return framedProposal(frame, view, { amountUsd: formatUsd(view.finalPrice) }, {
    chain: input.chain,
    url: `${merchantBase(env)}/checkout`,
    method: "POST",
    body: { sessionId: input.sessionId },
    maxAmount: String(view.finalPrice),
  });
}

export async function reveal(env: ToolEnv, input: z.infer<typeof SessionInput>) {
  const body = (await getJson(env, `/reveal/${input.sessionId}`)) as { floor?: unknown; salt?: unknown; commitment?: unknown; verified?: unknown };
  if (typeof body.floor !== "number" || typeof body.salt !== "string" || typeof body.commitment !== "string") {
    throw new ToolError("The Broker returned an unexpected reveal shape.");
  }
  const here = verifyReveal(body.commitment, body.floor, body.salt).verified;
  const structured = {
    sessionId: input.sessionId,
    floorUsd: formatUsd(body.floor),
    floorAtomic: String(body.floor),
    salt: body.salt,
    commitment: body.commitment,
    verifiedByBroker: body.verified === true,
    verifiedHere: here,
  };
  // The reveal call published the reveal event, so the history now closes with it.
  const events = await history(env, input.sessionId);
  const snapshot = events && snapshotFromEvents(events);
  const frame = snapshot ? fenceFrame(renderSnapshot(snapshot)) : fenceFrame(`Hidden floor ${structured.floorUsd}, commitment ${here ? "VERIFIED" : "MISMATCH"}.`);
  return withFrame(frame, `Hidden floor was ${structured.floorUsd}. Commitment ${here ? "verified" : "did NOT verify"} independently.`, { ...structured, frame, display: FRAME_DISPLAY_NOTE }, { ...structured, nextStep: "The session is over. Open another with boxhaggle_open_session." }, true);
}

export function toolError(error: unknown) {
  const message = error instanceof ToolError ? error.message : error instanceof Error && error.name === "TimeoutError" ? "The Broker did not answer in time." : "Unexpected error.";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
