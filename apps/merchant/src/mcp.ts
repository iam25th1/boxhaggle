import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Hono } from "hono";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  FRAME_DISPLAY_NOTE,
  ITEMS,
  agentText,
  fenceFrame,
  formatUsd,
  renderSnapshot,
  snapshotFromEvents,
  usdToAtomic,
  type StreamEvent,
} from "@boxhaggle/core";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import { tag } from "./log.js";
import { LIMITS, RateLimiter } from "./ratelimit.js";
import type { Session, SessionStore } from "./store.js";

// The in-chat counter: an MCP endpoint (streamable HTTP, stateless) on the
// merchant itself, at /mcp. Every tool is a thin adapter over the merchant's
// own HTTP routes, called in process with the caller's socket and client IP
// headers, so payment verification, payer binding, replay protection and rate
// limits are exactly the code that guards /offer and /checkout. Sessions use
// the plugin channel: payment gated, bound to their first payer, never in the
// lobby. The merchant key is added server side to the one call that needs it
// (opening a session) and never reaches or is asked of a client.
//
// PayBox use_service (gateway mode) pays through POST /mcp-pay/offer/:sessionId
// and /mcp-pay/checkout/:sessionId. use_service sends no body on its unpaid
// probe, so the round and the offer ride in the URL query. Both routes take
// MCP sessions only (the ones with a budget here) and forward in process to
// /offer and /checkout, so the paywall is the same code there too.

export const COUNTER_URI = "ui://boxhaggle/counter";
// From @modelcontextprotocol/ext-apps 2.0.3 (constants RESOURCE_MIME_TYPE and
// RESOURCE_URI_META_KEY). Inlined so the payment server carries no extra
// dependency for two strings.
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const RESOURCE_URI_META_KEY = "ui/resourceUri";
const TOOL_META = { ui: { resourceUri: COUNTER_URI }, [RESOURCE_URI_META_KEY]: COUNTER_URI };

const DEFAULT_COUNTER_HTML = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist-counter/counter.html");
const MAX_BUDGETS = 6_000;

export interface McpDeps {
  config: Config;
  log: Logger;
  sessions: SessionStore;
  limiter: RateLimiter;
  clientIp: (c: Context) => string;
  /** Path of the bundled counter UI. Defaults to the web workspace build output. */
  counterHtmlPath?: string;
}

const itemIds = ITEMS.map((item) => item.id) as [string, ...string[]];
const sessionId = z.string().regex(/^[a-f0-9]{32}$/, "a 32 character session id from haggle_start");
const usd = (what: string) => z.string().regex(/^(0|[1-9][0-9]{0,4})(\.[0-9]{1,2})?$/, `${what} is a dollar amount such as 1.25`);
// x_payment from PayBox pay_x402: a base64 payment header.
const payment = z.string().min(16).max(6_000).regex(/^[A-Za-z0-9+/=_-]+$/, "payment is the base64 x_payment string from pay_x402");

const StartInput = z.object({ itemId: z.enum(itemIds).default("brass-compass"), budgetUsd: usd("budgetUsd").default("3.00") }).strict();
const OfferInput = z.object({ sessionId, offerUsd: usd("offerUsd"), payment: payment.optional() }).strict();
const CheckoutInput = z.object({ sessionId, payment: payment.optional() }).strict();
const RevealInput = z.object({ sessionId }).strict();
const StatusInput = z.object({ sessionId }).strict();

const GATEWAY =
  "Pay through PayBox gateway mode: call this tool without `payment`; the result carries `useService` with a url and nothing is charged. " +
  "Call PayBox `use_service` with your wallet `credential_id`, that exact `url`, `method` POST and no body or headers; PayBox probes the 402, " +
  "signs and re-fetches within seconds. Poll `get_request` with its request_id until success (the paid body holds the Broker's reply and the state), " +
  "then call `haggle_status` to refresh the counter. ";
const TWO_STEP =
  "Fallback only, if PayBox use_service is unavailable, in two steps. 1) Call without `payment`: the result carries `payment` with the x402 requirements and nothing is charged. " +
  "2) Call PayBox `pay_x402` with your wallet `credential_id`, `accepts` exactly as given, `resource_url` set to `payment.resourceUrl`, " +
  "`x402_version` 2 and `resource` exactly as given, wait for it to finish, then call this tool again with the same arguments plus " +
  "`payment` set to its `output.value.x_payment`, as your very next action: a signed Solana payment expires about 30 seconds after PayBox signs it. The merchant verifies amount, asset, network, payTo, resource and a single-use nonce before anything changes.";
const SHOW =
  " Every result opens with a text frame of the counter: show it to the user exactly as given. Hosts with MCP Apps also render the live counter." +
  " The text ends with an AGENT DATA JSON block holding the session id, the state, any x402 requirements and the next step: use those exact values for the next call.";

type Phase = "opened" | "payment_required" | "paid" | "rejected" | "closed" | "revealed";

interface Internal {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

class HaggleError extends Error {}

interface Budget {
  cap: number;
  spent: number;
  /** The last event seq a tool result showed, so haggle_status animates what came after. */
  shown?: number;
}

// Short, non-sensitive reasons for a refused payment, so an agent knows what to change.
const REFUSALS: Record<string, string> = {
  payment_expired: "the signed Solana payment expired before it reached The Broker; it stays valid about 30 seconds after PayBox signs it.",
  payment_replayed: "that x_payment was already used once.",
  malformed_payment: "payment is not an x_payment string from pay_x402.",
  unsupported_network_or_scheme: "the payment is for a network or scheme not offered here.",
  accepted_requirements_mismatch: "the payment does not match payment.accepts.",
  resource_mismatch: "the payment names a different resource than payment.resource.",
  payer_not_session_owner: "this session is bound to the wallet that paid first.",
};

function refusalReason(code: string): string {
  if (code.startsWith("payment_invalid:")) return `the facilitator refused it (${code.slice(16)}).`;
  if (code.startsWith("settlement_failed:")) return `settlement failed (${code.slice(18)}).`;
  return REFUSALS[code] ?? "it did not pass verification.";
}

function decodeHeader(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function loadCounter(path: string, log: Logger): () => string | null {
  let cached: string | null | undefined;
  return () => {
    if (cached !== undefined) return cached;
    try {
      cached = readFileSync(path, "utf8");
    } catch {
      log.warn("counter ui missing, text frames only", { path });
      cached = null;
    }
    return cached;
  };
}

export function mountMcp(app: Hono, deps: McpDeps): void {
  const { config, log, sessions, limiter } = deps;
  const counter = loadCounter(deps.counterHtmlPath ?? DEFAULT_COUNTER_HTML, log);
  // Per-session spend caps chosen at haggle_start. In memory, like the sessions.
  const budgets = new Map<string, Budget>();

  const prune = () => {
    if (budgets.size < MAX_BUDGETS) return;
    for (const id of budgets.keys()) if (!sessions.get(id)) budgets.delete(id);
  };

  // The PayBox use_service url for one paid step of an MCP session.
  const payUrlFor = (route: "offer" | "checkout", id: string, round: number, offer?: number) =>
    `${config.publicBaseUrl}/mcp-pay/${route}/${id}?round=${round}${offer === undefined ? "" : `&offerUsd=${formatUsd(offer).slice(1)}`}`;

  // What to do next from the session alone, for haggle_status and use_service replies.
  const nextFor = (session: Session): string =>
    session.revealed
      ? "The session is over. Start another with haggle_start."
      : session.broker.status === "open"
        ? "Make another offer with haggle_offer."
        : session.broker.status === "sold" && !session.checkoutPaid
          ? "The Broker said sold. Call haggle_checkout to pay the agreed price."
          : "Call haggle_reveal to open the sealed floor and check the commitment.";

  // The public state of an MCP session: the same fields AGENT DATA carries.
  const stateOf = (session: Session, budget: Budget, phase: Phase) => {
    const s = session.broker;
    return {
      sessionId: session.id,
      phase,
      itemId: session.item.id,
      itemName: session.item.name,
      listPriceUsd: formatUsd(s.listPrice),
      askUsd: formatUsd(s.ask),
      patience: s.patience,
      mood: s.mood,
      status: s.status,
      round: s.round,
      finalPriceUsd: s.finalPrice === null ? null : formatUsd(s.finalPrice),
      offerFeeAtomic: String(config.offerFee),
      commitment: session.commitment,
      checkoutPaid: session.checkoutPaid,
      budget: { capUsd: formatUsd(budget.cap), spentUsd: formatUsd(budget.spent), remainingUsd: formatUsd(Math.max(0, budget.cap - budget.spent)) },
    };
  };

  function buildServer(outer: Context): McpServer {
    // One internal request through the merchant's own routes, as the caller.
    const call = async (method: "GET" | "POST", path: string, opts: { body?: unknown; key?: boolean; payment?: string } = {}): Promise<Internal> => {
      const headers = new Headers();
      if (opts.body !== undefined) headers.set("content-type", "application/json");
      for (const name of ["cf-connecting-ip", "x-forwarded-for"]) {
        const value = outer.req.header(name);
        if (value) headers.set(name, value);
      }
      if (opts.key) headers.set("x-merchant-key", config.merchantApiKey);
      if (opts.payment) headers.set("x-payment", opts.payment);
      const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }, outer.env);
      let body: Record<string, unknown> = {};
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }
      return { status: res.status, body, headers: res.headers };
    };

    const failed = (res: Internal): never => {
      const reason = decodeHeader(res.headers.get("payment-required"))?.error ?? res.body.error ?? `http_${res.status}`;
      const message = typeof res.body.message === "string" ? ` ${res.body.message}` : "";
      throw new HaggleError(`The Broker refused (${res.status} ${String(reason).slice(0, 96)}).${message.slice(0, 160)}`);
    };

    const sessionOrThrow = (id: string) => {
      const session = sessions.get(id);
      const budget = budgets.get(id);
      if (!session || !budget) throw new HaggleError("Unknown session. Start one with haggle_start.");
      return { session, budget };
    };

    // A refused payment, for agents that read only the text: the reason, the
    // state, the fresh requirements and the retry. Still an error result, so the
    // counter shows the refusal. Never echoes the payment it refused.
    const refused = (res: Internal, id: string, route: "offer" | "checkout", round: number, cost: number, pending?: { offer: number; fee: number }): never => {
      const v2 = decodeHeader(res.headers.get("payment-required"));
      const code = String(v2?.error ?? res.body.error ?? `http_${res.status}`).slice(0, 96);
      const resource = (v2?.resource ?? null) as { url?: string } | null;
      const { session, budget } = sessionOrThrow(id);
      const s = session.broker;
      const offerUsd = pending ? formatUsd(pending.offer).slice(1) : null;
      const payUrl = payUrlFor(route, id, round, pending?.offer);
      const nextStep =
        code === "payer_not_session_owner"
          ? "Pay from the wallet that paid first in this session, or start a new session with haggle_start."
          : `Best: call PayBox use_service with url ${payUrl}, method POST and no body, poll get_request until success, then call haggle_status. ` +
            `Otherwise call PayBox pay_x402 again with payment.accepts and payment.resource exactly as given here, then call haggle_${route} with sessionId "${id}"${offerUsd ? `, offerUsd "${offerUsd}"` : ""} ` +
            "and payment = the new output.value.x_payment as your very next action, with no message and no other tool call in between.";
      const why = refusalReason(code);
      const data = {
        sessionId: id,
        phase: "rejected",
        status: s.status,
        round: s.round,
        askUsd: formatUsd(s.ask),
        patience: s.patience,
        mood: s.mood,
        budget: { capUsd: formatUsd(budget.cap), spentUsd: formatUsd(budget.spent), remainingUsd: formatUsd(Math.max(0, budget.cap - budget.spent)) },
        charged: false,
        reason: code,
        why,
        ...(offerUsd ? { offerUsd, paysForRound: round } : {}),
        useService: { url: payUrl, method: "POST" },
        ...(v2 && Array.isArray(v2.accepts) && resource?.url ? { payment: { x402Version: 2, resourceUrl: resource.url, resource, accepts: v2.accepts, amountUsd: formatUsd(cost) } } : {}),
        nextStep,
      };
      throw new HaggleError(agentText("", `The Broker refused the payment (${code}): ${why} Nothing was charged. ${nextStep}`, data));
    };

    const result = (id: string, phase: Phase, fromSeq: number, extra: { pending?: { offer: number; fee: number }; payment?: unknown; data?: Record<string, unknown>; revealed?: boolean; summary: string; nextStep: string }) => {
      const { session, budget } = sessionOrThrow(id);
      budget.shown = session.seq;
      const events: StreamEvent[] = session.events;
      const snapshot = snapshotFromEvents(events, extra.pending ?? null);
      const frame = snapshot ? fenceFrame(renderSnapshot(snapshot)) : "";
      const s = session.broker;
      const structured = {
        sessionId: session.id,
        phase,
        state: {
          itemId: session.item.id,
          itemName: session.item.name,
          listPriceUsd: formatUsd(s.listPrice),
          askUsd: formatUsd(s.ask),
          patience: s.patience,
          mood: s.mood,
          status: s.status,
          round: s.round,
          finalPriceUsd: s.finalPrice === null ? null : formatUsd(s.finalPrice),
          offerFeeAtomic: String(config.offerFee),
          commitment: session.commitment,
          checkoutPaid: session.checkoutPaid,
        },
        budget: { capUsd: formatUsd(budget.cap), spentUsd: formatUsd(budget.spent), remainingUsd: formatUsd(Math.max(0, budget.cap - budget.spent)) },
        ...(extra.payment ? { payment: extra.payment } : {}),
        events,
        fromSeq,
        frame,
        display: FRAME_DISPLAY_NOTE,
        nextStep: extra.nextStep,
      };
      // The same values for agents that read only the text: public state, any
      // x402 requirements and the next step. No events, and never a payment header.
      const agentData = {
        sessionId: session.id,
        phase,
        ...structured.state,
        budget: structured.budget,
        ...(extra.payment ? { payment: extra.payment } : {}),
        ...extra.data,
        nextStep: extra.nextStep,
      };
      return {
        content: [{ type: "text" as const, text: agentText(frame, `${extra.summary} ${extra.nextStep}`, agentData, { revealed: extra.revealed }) }],
        structuredContent: structured,
      };
    };

    const guard = <A>(name: string, fn: (args: A) => Promise<ReturnType<typeof result>>) => async (args: A) => {
      try {
        return await fn(args);
      } catch (error) {
        const message = error instanceof HaggleError ? error.message : "Unexpected error at the counter.";
        if (!(error instanceof HaggleError)) log.error("mcp tool failed", { tool: name, name: error instanceof Error ? error.name : "unknown" });
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    };

    // The payment step shared by offers and checkout.
    const paid = async (route: "offer" | "checkout", id: string, body: Record<string, unknown>, cost: number, pay: string | undefined, pending?: { offer: number; fee: number }) => {
      const { session, budget } = sessionOrThrow(id);
      const fromSeq = session.seq;
      const round = route === "offer" ? session.broker.round + 1 : session.broker.round;
      const path = `/${route}?session=${id}&round=${round}`;
      if (!pay) {
        if (budget.spent + cost > budget.cap) {
          throw new HaggleError(`That would pass your ${formatUsd(budget.cap)} budget (${formatUsd(budget.spent)} spent, this costs ${formatUsd(cost)}).`);
        }
        const res = await call("POST", path, { body });
        if (res.status !== 402) failed(res);
        const v2 = decodeHeader(res.headers.get("payment-required"));
        const resource = (v2?.resource ?? null) as { url?: string } | null;
        if (!v2 || !Array.isArray(v2.accepts) || !resource?.url) throw new HaggleError("The Broker sent no payment requirements.");
        const requirements = { x402Version: 2, resourceUrl: resource.url, resource, accepts: v2.accepts, amountUsd: formatUsd(cost) };
        const payUrl = payUrlFor(route, id, round, pending?.offer);
        log.info("mcp payment required", { route, session: tag(id), round });
        return result(id, "payment_required", fromSeq, {
          pending,
          payment: requirements,
          data: {
            ...(pending ? { offerUsd: formatUsd(pending.offer).slice(1), paysForRound: round } : {}),
            useService: { url: payUrl, method: "POST" },
            instruction:
              `Call PayBox use_service with credential_id = your wallet credential, url = useService.url exactly, method "POST" and no body or headers; ` +
              `PayBox probes the 402, signs and re-fetches within seconds. Poll get_request with its request_id until success, ` +
              `then call haggle_status with sessionId "${id}" to refresh the counter.`,
            fallback:
              `Only if use_service is unavailable, pay with PayBox pay_x402: credential_id = your wallet credential, accepts = payment.accepts exactly, resource_url = payment.resourceUrl, x402_version = 2, resource = payment.resource exactly; ` +
              `if it returns pending, poll get_request with its request_id until it finishes. Then call haggle_${route} again with sessionId "${id}"` +
              `${pending ? `, offerUsd "${formatUsd(pending.offer).slice(1)}"` : ""} and payment = its output.value.x_payment, as your very next action with no message in between: the signed payment expires about 30 seconds after PayBox signs it.`,
          },
          summary: `Payment required: ${formatUsd(cost)} USDC for the ${route === "offer" ? `round ${round} offer` : "checkout"}. Nothing has been charged.`,
          nextStep: `Call PayBox use_service with url ${payUrl}, method POST and no body, poll get_request until success, then call haggle_status. Fallback: the pay_x402 steps in AGENT DATA.`,
        });
      }
      const res = await call("POST", path, { body, payment: pay });
      if (res.status === 402) {
        log.info("mcp payment rejected", { route, session: tag(id) });
        refused(res, id, route, round, cost, pending);
      }
      if (res.status !== 200) failed(res);
      budget.spent += cost;
      log.info("mcp paid", { route, session: tag(id), round });
      const after = sessions.get(id)!;
      const status = after.broker.status;
      const nextStep =
        route === "checkout"
          ? "Call haggle_reveal to open the sealed floor and check the commitment."
          : status === "open"
            ? "Make another offer with haggle_offer."
            : status === "sold"
              ? "The Broker said sold. Call haggle_checkout to pay the agreed price."
              : "The Broker walked away. Call haggle_reveal to see the floor.";
      return result(id, status === "open" || route === "offer" ? "paid" : "closed", fromSeq, {
        summary: route === "checkout" ? `Checkout paid: ${formatUsd(cost)}.` : `Offer paid. The Broker now asks ${formatUsd(after.broker.ask)}.`,
        nextStep,
      });
    };

    const server = new McpServer({ name: "boxhaggle-counter", version: "0.1.0" });
    const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

    server.registerTool(
      "haggle_start",
      {
        title: "Step up to The Broker's counter",
        description:
          "Opens a haggling session with The Broker for one item (default brass-compass) and sets your spend cap for this session (fees plus price, default 3.00 USD). " +
          `Returns the session id, the list price and a SHA-256 commitment to the hidden floor, published before any offer. Free. Items: ${ITEMS.map((i) => `${i.id} (${formatUsd(i.listPrice)})`).join(", ")}.` +
          SHOW,
        inputSchema: StartInput,
        annotations: write,
        _meta: TOOL_META,
      },
      guard("haggle_start", async (input: z.infer<typeof StartInput>) => {
        const cap = usdToAtomic(input.budgetUsd);
        if (cap < config.offerFee || cap > 100 * 1_000_000) throw new HaggleError("budgetUsd must be between one offer fee and 100.00.");
        const res = await call("POST", "/session", { body: { itemId: input.itemId, channel: "plugin" }, key: true });
        if (res.status !== 201 || typeof res.body.sessionId !== "string") failed(res);
        const id = res.body.sessionId as string;
        prune();
        budgets.set(id, { cap, spent: 0 });
        log.info("mcp session opened", { session: tag(id), item: input.itemId });
        return result(id, "opened", 0, {
          summary: `Session open for ${String((res.body.item as { name?: string })?.name ?? input.itemId)}.`,
          nextStep: "Make an offer with haggle_offer (offerUsd in dollars). Each offer costs the haggling fee over x402.",
        });
      }),
    );

    server.registerTool(
      "haggle_offer",
      {
        title: "Make a paid counter-offer",
        description: `Makes one counter-offer to The Broker. Each offer costs the haggling fee (about 0.01 USDC) over x402, paid through PayBox. ${GATEWAY}${TWO_STEP}${SHOW}`,
        inputSchema: OfferInput,
        annotations: write,
        _meta: TOOL_META,
      },
      guard("haggle_offer", async (input: z.infer<typeof OfferInput>) => {
        const { session } = sessionOrThrow(input.sessionId);
        if (session.broker.status !== "open") throw new HaggleError(`This session is ${session.broker.status}; no more offers.`);
        const amount = usdToAtomic(input.offerUsd);
        if (amount < 10_000) throw new HaggleError("Offers start at 0.01 USD.");
        return paid("offer", input.sessionId, { sessionId: input.sessionId, amount: String(amount) }, config.offerFee, input.payment, { offer: amount, fee: config.offerFee });
      }),
    );

    server.registerTool(
      "haggle_checkout",
      {
        title: "Pay the agreed price",
        description: `After The Broker says sold, pays the exact agreed price in USDC over x402 through PayBox. ${GATEWAY}${TWO_STEP}${SHOW}`,
        inputSchema: CheckoutInput,
        annotations: write,
        _meta: TOOL_META,
      },
      guard("haggle_checkout", async (input: z.infer<typeof CheckoutInput>) => {
        const { session } = sessionOrThrow(input.sessionId);
        if (session.broker.status !== "sold" || session.broker.finalPrice === null) throw new HaggleError("No deal yet. Keep haggling until The Broker says sold.");
        if (session.checkoutPaid) throw new HaggleError("This deal is already paid.");
        return paid("checkout", input.sessionId, { sessionId: input.sessionId }, session.broker.finalPrice, input.payment);
      }),
    );

    server.registerTool(
      "haggle_reveal",
      {
        title: "Open the sealed floor",
        description:
          "After the session ends, reveals the hidden floor and salt and checks SHA-256(floor|salt) against the commitment published at the start, proving the floor never moved. Free." +
          SHOW,
        inputSchema: RevealInput,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        _meta: TOOL_META,
      },
      guard("haggle_reveal", async (input: z.infer<typeof RevealInput>) => {
        const { session } = sessionOrThrow(input.sessionId);
        const fromSeq = session.seq;
        const res = await call("GET", `/reveal/${input.sessionId}`);
        if (res.status !== 200) failed(res);
        return result(input.sessionId, "revealed", fromSeq, {
          data: { floorUsd: formatUsd(Number(res.body.floor)), salt: res.body.salt, verified: res.body.verified === true },
          revealed: true,
          summary: `The floor was ${formatUsd(Number(res.body.floor))}; the commitment ${res.body.verified === true ? "verified" : "did NOT verify"}.`,
          nextStep: "The session is over. Start another with haggle_start.",
        });
      }),
    );

    server.registerTool(
      "haggle_status",
      {
        title: "Look at the counter",
        description:
          "Returns the current state of a session: ask, patience, mood, round, status, budget and the Broker's latest line, with the counter animating anything since the last result. " +
          "Free and read-only. Call it after a PayBox use_service payment finishes, so the counter shows the paid round." +
          SHOW,
        inputSchema: StatusInput,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: TOOL_META,
      },
      guard("haggle_status", async (input: z.infer<typeof StatusInput>) => {
        const { session, budget } = sessionOrThrow(input.sessionId);
        const s = session.broker;
        const phase: Phase = session.revealed ? "revealed" : session.checkoutPaid || s.status === "walked" ? "closed" : s.round > 0 ? "paid" : "opened";
        const last = [...session.events].reverse().find((e) => e.t === "broker.reply" || e.t === "session.opened");
        const line = last && "line" in last && typeof last.line === "string" ? ` The Broker: "${last.line}"` : "";
        return result(input.sessionId, phase, budget.shown ?? 0, {
          summary: `Round ${s.round}, ${s.status}. The Broker asks ${formatUsd(s.ask)}.${line}`,
          nextStep: nextFor(session),
        });
      }),
    );

    server.registerResource(
      "BOXHAGGLE counter",
      COUNTER_URI,
      { title: "The Broker's counter", description: "Live counter for a BOXHAGGLE session: the Broker, the split-flap ask, the fuse, receipts, coins and the sealed reveal.", mimeType: RESOURCE_MIME_TYPE },
      async () => {
        const html = counter();
        if (!html) throw new HaggleError("The counter UI is not built on this server.");
        // No connectDomains and no resourceDomains: the view makes no network
        // connection at all and updates from tool results only.
        return { contents: [{ uri: COUNTER_URI, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } } }] };
      },
    );

    return server;
  }

  app.all("/mcp", async (c) => {
    const ip = deps.clientIp(c);
    if (!limiter.hit(`mcp:${ip}`, LIMITS.mcpPerIp.limit, LIMITS.mcpPerIp.windowMs)) {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "rate_limited" } }, 429, { "Retry-After": "30" });
    }
    const handler = createMcpHandler(() => buildServer(c), { legacy: "stateless", responseMode: "json", onerror: (error) => log.warn("mcp request rejected", { name: error.name }) });
    return handler.fetch(c.req.raw);
  });

  // PayBox use_service for MCP sessions. The unpaid probe carries no body, so
  // the URL holds everything; any body must be empty. Each call is forwarded to
  // /offer or /checkout in process, with the caller's socket, client IP headers
  // and payment header, so the 402, the verification, the payer binding, the
  // single-use nonce and the rate limits are that route's own. No merchant key.
  const PayQuery = {
    offer: z.object({ round: z.string().regex(/^[1-9][0-9]{0,3}$/, "round is the round this offer pays for"), offerUsd: usd("offerUsd") }).strict(),
    checkout: z.object({ round: z.string().regex(/^(0|[1-9][0-9]{0,3})$/, "round is the round the deal closed in") }).strict(),
  };
  const gateway = (route: "offer" | "checkout") => async (c: Context) => {
    const id = c.req.param("sessionId") ?? "";
    const query = PayQuery[route].safeParse(c.req.query());
    if (!sessionId.safeParse(id).success || !query.success || Object.values(c.req.queries()).some((v) => v.length !== 1)) {
      return c.json({ error: "invalid_request", message: "Use the useService.url from haggle_offer or haggle_checkout exactly." }, 400);
    }
    const raw = (await c.req.text()).trim();
    if (raw !== "" && raw !== "{}" && raw !== "null") return c.json({ error: "unexpected_body", message: "Everything is in the URL; send no body." }, 400);
    const session = sessions.get(id);
    const budget = budgets.get(id);
    if (!session || !budget) return c.json({ error: "unknown_session" }, 404);
    const offerUsd = (query.data as { offerUsd?: string }).offerUsd;
    const offer = route === "offer" && offerUsd !== undefined ? usdToAtomic(offerUsd) : null;
    if (offer !== null && offer < 10_000) return c.json({ error: "offer_too_low", message: "Offers start at 0.01 USD." }, 400);
    const cost = route === "offer" ? config.offerFee : (session.broker.finalPrice ?? 0);
    if (budget.spent + cost > budget.cap) {
      return c.json({ error: "budget_exceeded", message: `That would pass the ${formatUsd(budget.cap)} cap chosen at haggle_start (${formatUsd(budget.spent)} spent).` }, 409);
    }

    const headers = new Headers({ "content-type": "application/json" });
    for (const name of ["cf-connecting-ip", "x-forwarded-for", "payment-signature", "x-payment"]) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    const body = offer === null ? { sessionId: id } : { sessionId: id, amount: String(offer) };
    const res = await app.request(`/${route}?session=${id}&round=${query.data.round}`, { method: "POST", headers, body: JSON.stringify(body) }, c.env);
    log.info("mcp gateway", { route, session: tag(id), round: Number(query.data.round), status: res.status });
    if (res.status !== 200) return res;

    const reply = (await res.json()) as Record<string, unknown>;
    budget.spent += cost;
    const snapshot = snapshotFromEvents(session.events, null);
    const receipt = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
    if (receipt) c.header(res.headers.has("payment-response") ? "PAYMENT-RESPONSE" : "X-PAYMENT-RESPONSE", receipt);
    c.header("Cache-Control", "no-store, private");
    return c.json({
      reply,
      state: { ...stateOf(session, budget, route === "offer" ? "paid" : "closed"), nextStep: `Call haggle_status with sessionId "${id}" to refresh the counter. Then: ${nextFor(session)}` },
      frame: snapshot ? fenceFrame(renderSnapshot(snapshot)) : "",
      display: FRAME_DISPLAY_NOTE,
    });
  };
  app.post("/mcp-pay/offer/:sessionId", gateway("offer"));
  app.post("/mcp-pay/checkout/:sessionId", gateway("checkout"));
}
