import type { EnvelopeStatus, PayboxTool } from "@boxhaggle/core";

// The adapter boundary between the haggling run and PayBox. The live
// implementation wraps @paybox-sh/sdk 2.2.0 plus a minimal MCP client for the
// two MCP-only tools; the mock implementation replays recorded envelopes.

export interface Envelope {
  request_id: string;
  status: EnvelopeStatus;
  output: { output_type?: string; value?: unknown } | null;
  approval_url?: string | null;
  error?: string | null;
  retryable?: boolean;
}

/** Called on every envelope status the port observes, including polls. */
export type EnvelopeObserver = (tool: PayboxTool, envelope: Envelope) => void;

export interface WalletCredential {
  id: string;
  name: string;
  family: "solana" | "evm";
  address: string | null;
}

export interface SimpleCredential {
  id: string;
  name: string;
  brand?: string;
}

export interface CredentialsView {
  wallets: WalletCredential[];
  cards: SimpleCredential[];
  secrets: SimpleCredential[];
  ungrantedCount: number;
}

export interface SwapRequest {
  credentialId: string;
  srcChain: string;
  dstChain?: string;
  srcToken: string;
  dstToken: string;
  amount: string;
  valueCents?: number;
}

export interface PayboxPort {
  readonly label: "live" | "replay";
  listCredentials(): Promise<CredentialsView>;
  requestAccountChange(note: string): Promise<{ manageUrl: string }>;
  requestSecret(args: { credentialId: string; raw: boolean; purpose: string }): Promise<Envelope>;
  /** Header mode. Waits through approval and signs in-process; returns the terminal envelope. */
  payX402(args: { credentialId: string; accepts: unknown[]; resourceUrl: string }): Promise<Envelope>;
  getRequest(requestId: string): Promise<Envelope>;
  getPortfolio(args: { address: string; token: string; networkId: number }): Promise<unknown>;
  getBuyLink(args: { credentialId: string; destinationChain: string; currencyCode: string; amountUsd: number }): Promise<{ url: string; network: string; currency: string }>;
  verifySolanaBalance(args: { address: string; tokenMint: string; transactionSignature: string }): Promise<{ amount: string }>;
  discoverTokens(args: { mode: "search" | "token_detail"; chain: string; query?: string; tokenAddress?: string }): Promise<unknown>;
  requestSwap(args: SwapRequest): Promise<Envelope>;
  requestPayment(args: { credentialId: string; merchant: string; merchantUrl: string; amountCents: number }): Promise<Envelope>;
  claimPaymentCredentials(requestId: string): Promise<Record<string, unknown>>;
  listRequests(limit: number): Promise<Array<{ requestId: string; kind: string; status: string }>>;
}

export const PENDING: ReadonlySet<EnvelopeStatus> = new Set([
  "pending_approval",
  "pending_funding",
  "pending_signature",
  "pending_settlement",
  "pending_confirmation",
]);
