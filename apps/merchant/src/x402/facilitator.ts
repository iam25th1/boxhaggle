import { createHash } from "node:crypto";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { verifyTypedData, type Address, type Hex } from "viem";
import { RAILS, railByNetwork, type RailId } from "@boxhaggle/core";
import { EvmExactPayload, type PaymentPayload, type RequirementsV1, type RequirementsV2, type SettleResult, type VerifyResult } from "./types.js";

// Facilitator adapter. "http" talks to a real x402 facilitator (default PayAI)
// through @x402/core's HTTPFacilitatorClient. "local" verifies EVM EIP-3009
// signatures in-process and returns a fake settlement; it never touches a chain
// and the config refuses it in production.

export interface Facilitator {
  readonly mode: "http" | "local";
  verify(payload: PaymentPayload, requirements: RequirementsV1 | RequirementsV2): Promise<VerifyResult>;
  settle(payload: PaymentPayload, requirements: RequirementsV1 | RequirementsV2): Promise<SettleResult>;
  /** Fee payer addresses per rail for Solana exact payments. */
  feePayers(): Promise<Partial<Record<RailId, string>>>;
}

export class HttpFacilitator implements Facilitator {
  readonly mode = "http" as const;
  private client: HTTPFacilitatorClient;
  private cache: { at: number; value: Partial<Record<RailId, string>> } | null = null;

  constructor(url: string, token?: string) {
    this.client = new HTTPFacilitatorClient({
      url,
      timeoutMs: 15_000,
      ...(token
        ? {
            createAuthHeaders: async () => {
              const headers = { Authorization: `Bearer ${token}` };
              return { verify: headers, settle: headers, supported: headers };
            },
          }
        : {}),
    });
  }

  async verify(payload: PaymentPayload, requirements: RequirementsV1 | RequirementsV2): Promise<VerifyResult> {
    try {
      // The client posts { x402Version, paymentPayload, paymentRequirements } verbatim.
      const result = await this.client.verify(payload as never, requirements as never);
      return { isValid: result.isValid, invalidReason: result.invalidReason, invalidMessage: result.invalidMessage, payer: result.payer };
    } catch (error) {
      return { isValid: false, invalidReason: `facilitator_verify_error:${errorName(error)}` };
    }
  }

  async settle(payload: PaymentPayload, requirements: RequirementsV1 | RequirementsV2): Promise<SettleResult> {
    try {
      const result = await this.client.settle(payload as never, requirements as never);
      return {
        success: result.success,
        errorReason: result.errorReason,
        transaction: result.transaction,
        network: String(result.network),
        payer: result.payer,
      };
    } catch (error) {
      return { success: false, errorReason: `facilitator_settle_error:${errorName(error)}`, transaction: "", network: "" };
    }
  }

  async feePayers(): Promise<Partial<Record<RailId, string>>> {
    if (this.cache && Date.now() - this.cache.at < 10 * 60_000) return this.cache.value;
    const value: Partial<Record<RailId, string>> = {};
    try {
      const supported = await this.client.getSupported();
      for (const kind of supported.kinds) {
        const rail = railByNetwork(String(kind.network));
        const feePayer = (kind.extra as Record<string, unknown> | undefined)?.feePayer;
        if (rail?.family === "solana" && kind.scheme === "exact" && typeof feePayer === "string") value[rail.id] = feePayer;
      }
      this.cache = { at: Date.now(), value };
    } catch {
      // Leave Solana disabled until the facilitator answers.
    }
    return value;
  }
}

const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

function requiredAmount(requirements: RequirementsV1 | RequirementsV2): string {
  return "amount" in requirements ? requirements.amount : requirements.maxAmountRequired;
}

export class LocalEvmFacilitator implements Facilitator {
  readonly mode = "local" as const;

  async verify(payload: PaymentPayload, requirements: RequirementsV1 | RequirementsV2): Promise<VerifyResult> {
    const rail = railByNetwork(requirements.network);
    if (!rail || rail.family !== "evm") return { isValid: false, invalidReason: "local_facilitator_supports_base_only" };
    const parsed = EvmExactPayload.safeParse(payload.payload);
    if (!parsed.success) return { isValid: false, invalidReason: "invalid_exact_evm_payload" };
    const { authorization, signature } = parsed.data;
    if (authorization.to.toLowerCase() !== requirements.payTo.toLowerCase()) return { isValid: false, invalidReason: "invalid_payto" };
    if (authorization.value !== requiredAmount(requirements)) return { isValid: false, invalidReason: "invalid_amount" };
    const now = Math.floor(Date.now() / 1000);
    if (BigInt(authorization.validBefore) <= BigInt(now)) return { isValid: false, invalidReason: "authorization_expired" };
    if (BigInt(authorization.validAfter) > BigInt(now + 5)) return { isValid: false, invalidReason: "authorization_not_yet_valid" };
    const extra = requirements.extra as { name?: string; version?: string };
    try {
      const ok = await verifyTypedData({
        address: authorization.from as Address,
        domain: {
          name: extra.name ?? "USD Coin",
          version: extra.version ?? "2",
          chainId: 8453,
          verifyingContract: requirements.asset as Address,
        },
        types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
        primaryType: "TransferWithAuthorization",
        message: {
          from: authorization.from as Address,
          to: authorization.to as Address,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce as Hex,
        },
        signature: signature as Hex,
      });
      return ok ? { isValid: true, payer: authorization.from } : { isValid: false, invalidReason: "invalid_signature" };
    } catch {
      return { isValid: false, invalidReason: "invalid_signature" };
    }
  }

  async settle(payload: PaymentPayload, requirements: RequirementsV1 | RequirementsV2): Promise<SettleResult> {
    const verified = await this.verify(payload, requirements);
    if (!verified.isValid) return { success: false, errorReason: verified.invalidReason, transaction: "", network: requirements.network };
    const nonce = String((payload.payload as { authorization?: { nonce?: string } }).authorization?.nonce ?? "");
    const digest = createHash("sha256").update(nonce).digest("hex").slice(0, 24);
    return { success: true, transaction: `local_${digest}`, network: requirements.network, payer: verified.payer };
  }

  async feePayers(): Promise<Partial<Record<RailId, string>>> {
    return {};
  }
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return "unknown";
}

export { RAILS };
