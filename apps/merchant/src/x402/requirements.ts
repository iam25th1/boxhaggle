import { RAILS, formatUsdPrecise, type Rail, type RailId } from "@boxhaggle/core";
import type { Config } from "../config.js";
import type { RequirementsV1, RequirementsV2 } from "./types.js";

// Builds the payment requirement for one exact request: one route, one session,
// one round, one amount. The same quote is rebuilt when the paid retry arrives
// and the payment is checked against it, never against what the client sent.

export interface Quote {
  kind: "offer" | "checkout";
  sessionId: string;
  round: number;
  amount: number;
  /** Unique per session and round, e.g. https://host/offer?session=..&round=3 */
  resource: string;
  description: string;
}

export interface RailRequirement {
  rail: Rail;
  v1: RequirementsV1;
  v2: RequirementsV2;
}

export const OFFER_OUTPUT_SCHEMA = {
  input: {
    type: "http",
    method: "POST",
    bodyType: "json",
    bodyFields: {
      sessionId: { type: "string", description: "32 hex characters from POST /session", required: true },
      amount: { type: "string", description: "Offer in atomic USDC (6 decimals), integer string", required: true },
    },
  },
  output: {
    round: "number",
    ask: "number (atomic USDC)",
    patience: "number 0..100",
    mood: "calm | amused | irritated | insulted | sold",
    status: "open | sold | walked",
    line: "string",
  },
} as const;

export const CHECKOUT_OUTPUT_SCHEMA = {
  input: {
    type: "http",
    method: "POST",
    bodyType: "json",
    bodyFields: { sessionId: { type: "string", required: true } },
  },
  output: { finalPrice: "number (atomic USDC)", receiptId: "string" },
} as const;

export function resourceUrl(config: Config, kind: "offer" | "checkout", sessionId: string, round: number): string {
  const url = new URL(`${config.publicBaseUrl}/${kind}`);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("round", String(round));
  return url.toString();
}

export function buildRequirements(
  config: Config,
  quote: Quote,
  feePayers: Partial<Record<RailId, string>>,
): RailRequirement[] {
  const out: RailRequirement[] = [];
  for (const id of config.rails) {
    const rail = RAILS[id];
    const payTo = config.payTo[id];
    if (!payTo) continue;
    let extra: Record<string, unknown>;
    if (rail.family === "solana") {
      const feePayer = feePayers[id];
      if (!feePayer) continue; // Solana exact needs the facilitator's fee payer.
      extra = { feePayer };
    } else {
      extra = { name: "USD Coin", version: "2" };
    }
    const amount = String(quote.amount);
    const description = `${quote.description} (${formatUsdPrecise(quote.amount)} USDC on ${rail.label})`;
    out.push({
      rail,
      v1: {
        scheme: "exact",
        network: rail.v1Network,
        maxAmountRequired: amount,
        resource: quote.resource,
        description,
        mimeType: "application/json",
        outputSchema: quote.kind === "offer" ? { ...OFFER_OUTPUT_SCHEMA } : { ...CHECKOUT_OUTPUT_SCHEMA },
        payTo,
        maxTimeoutSeconds: config.paymentTimeoutSeconds,
        asset: rail.usdc,
        extra,
      },
      v2: {
        scheme: "exact",
        network: rail.v2Network,
        amount,
        asset: rail.usdc,
        payTo,
        maxTimeoutSeconds: config.paymentTimeoutSeconds,
        extra,
      },
    });
  }
  return out;
}
