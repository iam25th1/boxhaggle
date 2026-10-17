import * as z from "zod";

// Wire shapes for x402 v1 and v2 payment payloads, bounded and validated before
// anything else touches them. Field names follow @x402/core 2.28.0 types.

export const MAX_PAYMENT_HEADER_BYTES = 16 * 1024;

const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uintString = z.string().regex(/^[0-9]{1,78}$/);

export const EvmExactPayload = z.object({
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "plain EOA 65-byte signature expected"),
  authorization: z.object({
    from: evmAddress,
    to: evmAddress,
    value: uintString,
    validAfter: uintString,
    validBefore: uintString,
    nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
});
export type EvmExactPayload = z.infer<typeof EvmExactPayload>;

export const SvmExactPayload = z.object({
  transaction: z.string().min(16).max(4096).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type SvmExactPayload = z.infer<typeof SvmExactPayload>;

export const PaymentPayloadV1 = z.object({
  x402Version: z.literal(1),
  scheme: z.string().max(32),
  network: z.string().max(64),
  payload: z.record(z.string(), z.unknown()),
});
export type PaymentPayloadV1 = z.infer<typeof PaymentPayloadV1>;

export const AcceptedV2 = z.object({
  scheme: z.string().max(32),
  network: z.string().max(64),
  amount: uintString,
  asset: z.string().max(64),
  payTo: z.string().max(64),
  maxTimeoutSeconds: z.number().int().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export const PaymentPayloadV2 = z.object({
  x402Version: z.literal(2),
  resource: z.object({ url: z.string().max(2048) }).passthrough().optional(),
  accepted: AcceptedV2,
  payload: z.record(z.string(), z.unknown()),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentPayloadV2 = z.infer<typeof PaymentPayloadV2>;

export const PaymentPayload = z.discriminatedUnion("x402Version", [PaymentPayloadV1, PaymentPayloadV2]);
export type PaymentPayload = z.infer<typeof PaymentPayload>;

export interface RequirementsV1 {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  outputSchema: Record<string, unknown>;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: Record<string, unknown>;
}

export interface RequirementsV2 {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  /** The facilitator's own explanation, e.g. a Solana simulation error. */
  invalidMessage?: string;
  payer?: string;
}

export interface SettleResult {
  success: boolean;
  errorReason?: string;
  transaction: string;
  network: string;
  payer?: string;
}

/** Decode a base64 JSON payment header. Returns null for anything malformed. */
export function decodePaymentHeader(header: string): PaymentPayload | null {
  if (header.length > MAX_PAYMENT_HEADER_BYTES) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(header)) return null;
  try {
    const json = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as unknown;
    const parsed = PaymentPayload.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function encodeJsonHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}
