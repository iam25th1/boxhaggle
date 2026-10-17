import * as z from "zod";
import { MoodSchema, StatusSchema } from "./schemas.js";

// Spectator event stream. The merchant assigns `seq` and serves events over SSE.
// Merchant events describe the game. Agent events describe PayBox steps and are
// relayed through the merchant after strict validation. No event carries a raw
// key, card number, signature, payment header or secret value.

const short = z.string().max(96);
const text = z.string().max(280);
const atomic = z.number().int().min(0).max(1_000_000_000_000);
const at = z.number().int().min(0);

/** Links a human must open. Only https PayBox and MoonPay hosts are allowed through. */
export const HumanLink = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return (
        url.protocol === "https:" &&
        (host === "paybox.sh" || host.endsWith(".paybox.sh") || host === "moonpay.com" || host.endsWith(".moonpay.com"))
      );
    } catch {
      return false;
    }
  }, "link must be https on a paybox.sh or moonpay.com host");

export const EnvelopeStatusSchema = z.enum([
  "success",
  "pending_approval",
  "pending_funding",
  "pending_signature",
  "pending_settlement",
  "pending_confirmation",
  "denied",
  "error",
]);
export type EnvelopeStatus = z.infer<typeof EnvelopeStatusSchema>;

export const PayboxToolSchema = z.enum([
  "list_credentials",
  "request_account_change",
  "request_secret",
  "pay_x402",
  "use_service",
  "get_portfolio",
  "get_buy_link",
  "verify_solana_balance",
  "discover_tokens",
  "request_swap",
  "request_payment",
  "claim_payment_credentials",
  "get_request",
  "list_requests",
]);
export type PayboxTool = z.infer<typeof PayboxToolSchema>;

export const OutputTypeSchema = z.enum(["payment_token", "signature", "tx_hash", "secret_token", "raw_secret"]);
export const DrawerSchema = z.enum(["wallet", "card", "secret"]);

// ---- merchant events ----

export const SessionOpenedEvent = z.strictObject({
  t: z.literal("session.opened"),
  at,
  sessionId: z.string(),
  itemId: short,
  itemName: short,
  art: short,
  listPrice: atomic,
  ask: atomic,
  patience: z.number().int(),
  commitment: z.string().regex(/^[a-f0-9]{64}$/),
  offerFee: atomic,
  networks: z.array(short).max(4),
  channel: z.enum(["sdk", "plugin"]),
  line: text,
});

export const OfferPaidEvent = z.strictObject({
  t: z.literal("offer.paid"),
  at,
  round: z.number().int(),
  offer: atomic,
  fee: atomic,
  txRef: short,
  network: short,
});

export const BrokerReplyEvent = z.strictObject({
  t: z.literal("broker.reply"),
  at,
  round: z.number().int(),
  offer: atomic,
  previousAsk: atomic,
  ask: atomic,
  patience: z.number().int().min(0).max(100),
  mood: MoodSchema,
  status: StatusSchema,
  line: text,
});

export const CheckoutPaidEvent = z.strictObject({
  t: z.literal("checkout.paid"),
  at,
  price: atomic,
  txRef: short,
  network: short,
  receiptId: short,
});

export const RevealEvent = z.strictObject({
  t: z.literal("reveal"),
  at,
  floor: atomic,
  salt: z.string().regex(/^[a-f0-9]{64}$/),
  commitment: z.string().regex(/^[a-f0-9]{64}$/),
  verified: z.boolean(),
});

export const PaymentRejectedEvent = z.strictObject({
  t: z.literal("payment.rejected"),
  at,
  route: z.enum(["offer", "checkout"]),
  reason: short,
});

// ---- agent events (relayed) ----

export const RunStartedEvent = z.strictObject({
  t: z.literal("run.started"),
  at,
  mode: z.enum(["live", "replay"]),
  capUsd: z.number().min(0).max(100),
  strategy: short,
});

export const PayboxCallEvent = z.strictObject({
  t: z.literal("paybox.call"),
  at,
  tool: PayboxToolSchema,
  note: text.optional(),
});

export const PayboxEnvelopeEvent = z.strictObject({
  t: z.literal("paybox.envelope"),
  at,
  tool: PayboxToolSchema,
  requestId: short.optional(),
  status: EnvelopeStatusSchema,
  outputType: OutputTypeSchema.optional(),
  approvalUrl: HumanLink.optional(),
  message: text.optional(),
});

export const CredentialsListedEvent = z.strictObject({
  t: z.literal("credentials.listed"),
  at,
  wallet: z.strictObject({ present: z.boolean(), chain: short.optional(), address: short.optional() }),
  card: z.strictObject({ present: z.boolean(), brand: short.optional() }),
  secret: z.strictObject({ present: z.boolean(), name: short.optional() }),
});

export const AccountChangeEvent = z.strictObject({
  t: z.literal("account.change"),
  at,
  note: text,
  manageUrl: HumanLink,
});

export const VaultOpenedEvent = z.strictObject({
  t: z.literal("vault.opened"),
  at,
  drawer: DrawerSchema,
  outputType: OutputTypeSchema,
  note: text.optional(),
});

export const AgentThoughtEvent = z.strictObject({
  t: z.literal("agent.thought"),
  at,
  text,
});

export const FundsCheckedEvent = z.strictObject({
  t: z.literal("funds.checked"),
  at,
  need: atomic,
  have: atomic.nullable(),
  asset: short,
  network: short,
  ok: z.boolean(),
});

export const BuyLinkEvent = z.strictObject({
  t: z.literal("funds.buylink"),
  at,
  url: HumanLink,
  network: short,
  currency: short,
});

export const SwapQuoteEvent = z.strictObject({
  t: z.literal("swap.quote"),
  at,
  fromSymbol: short,
  fromChain: short,
  toSymbol: short,
  toChain: short,
  amountIn: short,
});

export const SwapStatusEvent = z.strictObject({
  t: z.literal("swap.status"),
  at,
  status: EnvelopeStatusSchema,
  requestId: short.optional(),
});

export const ReceiptEvent = z.strictObject({
  t: z.literal("receipt"),
  at,
  rows: z
    .array(z.strictObject({ requestId: short, kind: short, status: short }))
    .max(64),
});

export const ScoreEvent = z.strictObject({
  t: z.literal("score"),
  at,
  listPrice: atomic,
  finalPrice: atomic.nullable(),
  fees: atomic,
  rounds: z.number().int(),
  score: atomic.nullable(),
  savings: z.number().int().nullable(),
});

export const RunEndedEvent = z.strictObject({
  t: z.literal("run.ended"),
  at,
  outcome: z.enum(["deal", "walked", "aborted"]),
  reason: text.optional(),
});

export const MerchantEvent = z.discriminatedUnion("t", [
  SessionOpenedEvent,
  OfferPaidEvent,
  BrokerReplyEvent,
  CheckoutPaidEvent,
  RevealEvent,
  PaymentRejectedEvent,
]);
export type MerchantEvent = z.infer<typeof MerchantEvent>;

export const AgentEvent = z.discriminatedUnion("t", [
  RunStartedEvent,
  PayboxCallEvent,
  PayboxEnvelopeEvent,
  CredentialsListedEvent,
  AccountChangeEvent,
  VaultOpenedEvent,
  AgentThoughtEvent,
  FundsCheckedEvent,
  BuyLinkEvent,
  SwapQuoteEvent,
  SwapStatusEvent,
  ReceiptEvent,
  ScoreEvent,
  RunEndedEvent,
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

export const HaggleEvent = z.union([MerchantEvent, AgentEvent]);
export type HaggleEvent = MerchantEvent | AgentEvent;

/** What the SSE stream carries: an event plus the merchant-assigned sequence number. */
export type StreamEvent = HaggleEvent & { seq: number };

export const RelayBody = z.strictObject({
  events: z.array(AgentEvent).min(1).max(50),
});
export type RelayBody = z.infer<typeof RelayBody>;

export const AGENT_EVENT_TYPES: ReadonlySet<string> = new Set(AgentEvent.options.map((option) => option.shape.t.value));
