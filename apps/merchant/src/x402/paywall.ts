import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { RailId } from "@boxhaggle/core";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import { tag } from "../log.js";
import type { ReplayStore } from "../store.js";
import type { Facilitator } from "./facilitator.js";
import { buildRequirements, type Quote, type RailRequirement } from "./requirements.js";
import {
  EvmExactPayload,
  SvmExactPayload,
  decodePaymentHeader,
  encodeJsonHeader,
  type PaymentPayload,
  type VerifyResult,
} from "./types.js";

// Server-side x402 verification for one exact request.
// Order: decode -> match rail and version -> compare every requirement field we
// issued -> local field checks -> single-use claim -> facilitator verify ->
// facilitator settle. Any failure answers 402 with fresh requirements and no
// game state changes.

export interface PaidReceipt {
  network: string;
  txRef: string;
  payer: string | null;
  version: 1 | 2;
  responseHeader: { name: string; value: string };
}

export type PaywallResult = { ok: true; receipt: PaidReceipt } | { ok: false; response: Response };

export interface PaywallDeps {
  config: Config;
  facilitator: Facilitator;
  replay: ReplayStore;
  log: Logger;
}

export async function paymentRequired(
  c: Context,
  deps: PaywallDeps,
  quote: Quote,
  error: string,
): Promise<Response> {
  const requirements = buildRequirements(deps.config, quote, await deps.facilitator.feePayers());
  if (requirements.length === 0) {
    return c.json({ error: "no_payment_rail_available", message: "No configured rail can accept payment right now." }, 503);
  }
  const v2 = {
    x402Version: 2,
    error,
    resource: { url: quote.resource, description: quote.description, mimeType: "application/json" },
    accepts: requirements.map((r) => r.v2),
  };
  c.header("PAYMENT-REQUIRED", encodeJsonHeader(v2));
  c.header("Cache-Control", "no-store, private");
  return c.json({ x402Version: 1, error, accepts: requirements.map((r) => r.v1) }, 402);
}

function sameAddress(family: "evm" | "solana", a: string, b: string): boolean {
  return family === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function matchRequirement(payload: PaymentPayload, requirements: RailRequirement[]): RailRequirement | undefined {
  if (payload.x402Version === 1) {
    return requirements.find((r) => r.v1.network === payload.network && payload.scheme === "exact");
  }
  return requirements.find((r) => r.v2.network === payload.accepted.network && payload.accepted.scheme === "exact");
}

/** Stable single-use identifier for a payment, independent of header encoding. */
export function replayKey(payload: PaymentPayload, rail: RailRequirement): string {
  if (rail.rail.family === "evm") {
    const parsed = EvmExactPayload.safeParse(payload.payload);
    if (parsed.success) return `evm:${parsed.data.authorization.from.toLowerCase()}:${parsed.data.authorization.nonce.toLowerCase()}`;
  } else {
    const parsed = SvmExactPayload.safeParse(payload.payload);
    if (parsed.success) return `svm:${createHash("sha256").update(parsed.data.transaction).digest("hex")}`;
  }
  return `raw:${createHash("sha256").update(JSON.stringify(payload.payload)).digest("hex")}`;
}

/**
 * A Solana exact payment whose recent blockhash expired before the facilitator
 * simulated it (150 slots, about 30 seconds on mainnet). The transaction can
 * never land; the payer has to sign a new one.
 */
export function blockhashExpired(result: VerifyResult): boolean {
  return /BlockhashNotFound|blockhash not found/i.test(`${result.invalidReason ?? ""} ${result.invalidMessage ?? ""}`);
}

/** The facilitator's explanation, bounded, with any long encoded run cut out so nothing replayable is logged. */
export function facilitatorDetail(message: string | undefined): string | undefined {
  if (!message) return undefined;
  return message.replace(/[A-Za-z0-9+/=_-]{48,}/g, "[cut]").replace(/[^\x20-\x7e]/g, "").slice(0, 120) || undefined;
}

/** Optional gate on the verified payer, checked after verify and before settle. */
export type PayerGate = (payer: string | undefined) => boolean;

export async function collectPayment(c: Context, deps: PaywallDeps, quote: Quote, allowPayer?: PayerGate): Promise<PaywallResult> {
  const fail = async (error: string) => ({ ok: false as const, response: await paymentRequired(c, deps, quote, error) });

  const header = c.req.header("payment-signature") ?? c.req.header("x-payment");
  if (!header) return fail("payment_required");

  const payload = decodePaymentHeader(header.trim());
  if (!payload) return fail("malformed_payment");

  const requirements = buildRequirements(deps.config, quote, await deps.facilitator.feePayers());
  const match = matchRequirement(payload, requirements);
  if (!match) return fail("unsupported_network_or_scheme");
  const family = match.rail.family;
  const required = payload.x402Version === 1 ? match.v1 : match.v2;

  if (payload.x402Version === 2) {
    const a = payload.accepted;
    if (
      a.amount !== match.v2.amount ||
      !sameAddress(family, a.asset, match.v2.asset) ||
      !sameAddress(family, a.payTo, match.v2.payTo)
    ) {
      return fail("accepted_requirements_mismatch");
    }
    if (payload.resource?.url !== quote.resource) return fail("resource_mismatch");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (family === "evm") {
    const parsed = EvmExactPayload.safeParse(payload.payload);
    if (!parsed.success) return fail("invalid_exact_evm_payload");
    const auth = parsed.data.authorization;
    if (!sameAddress("evm", auth.to, match.v2.payTo)) return fail("wrong_pay_to");
    if (auth.value !== String(quote.amount)) return fail("wrong_amount");
    if (BigInt(auth.validBefore) <= BigInt(nowSec + 5)) return fail("authorization_expired");
    if (BigInt(auth.validAfter) > BigInt(nowSec + 5)) return fail("authorization_not_yet_valid");
    if (BigInt(auth.validBefore) - BigInt(nowSec) > BigInt(deps.config.paymentTimeoutSeconds + 60)) {
      return fail("authorization_window_too_long");
    }
  } else if (!SvmExactPayload.safeParse(payload.payload).success) {
    return fail("invalid_exact_svm_payload");
  }

  const ttlMs = (deps.config.paymentTimeoutSeconds + 600) * 1000;
  const key = replayKey(payload, match);
  const headerKey = `hdr:${createHash("sha256").update(header).digest("hex")}`;
  if (deps.replay.has(key) || deps.replay.has(headerKey)) {
    deps.log.warn("payment replay rejected", { route: quote.kind, session: tag(quote.sessionId), round: quote.round });
    return fail("payment_replayed");
  }
  deps.replay.claim(key, ttlMs);
  deps.replay.claim(headerKey, ttlMs);

  const verified = await deps.facilitator.verify(payload, required);
  if (!verified.isValid) {
    const detail = facilitatorDetail(verified.invalidMessage);
    deps.log.warn("payment verify failed", { route: quote.kind, session: tag(quote.sessionId), reason: verified.invalidReason, ...(detail ? { detail } : {}) });
    return fail(blockhashExpired(verified) ? "payment_expired" : `payment_invalid:${verified.invalidReason ?? "unknown"}`);
  }

  if (allowPayer && !allowPayer(verified.payer)) {
    deps.log.warn("payment from a different payer refused", { route: quote.kind, session: tag(quote.sessionId) });
    return fail("payer_not_session_owner");
  }

  const settled = await deps.facilitator.settle(payload, required);
  if (!settled.success) {
    deps.log.warn("payment settle failed", { route: quote.kind, session: tag(quote.sessionId), reason: settled.errorReason });
    return fail(`settlement_failed:${settled.errorReason ?? "unknown"}`);
  }

  const response = {
    success: true,
    transaction: settled.transaction,
    network: settled.network || required.network,
    payer: settled.payer ?? verified.payer ?? null,
  };
  deps.log.info("payment settled", {
    route: quote.kind,
    session: tag(quote.sessionId),
    round: quote.round,
    network: response.network,
    tx: tag(settled.transaction),
    facilitator: deps.facilitator.mode,
  });
  return {
    ok: true,
    receipt: {
      network: response.network,
      txRef: settled.transaction,
      payer: response.payer,
      version: payload.x402Version,
      responseHeader: {
        name: payload.x402Version === 1 ? "X-PAYMENT-RESPONSE" : "PAYMENT-RESPONSE",
        value: encodeJsonHeader(response),
      },
    },
  };
}

export type { RailId };
