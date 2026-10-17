import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { RAILS, type EnvelopeStatus, type PayboxTool } from "@boxhaggle/core";
import type { AgentConfig } from "./config.js";
import type { CredentialsView, Envelope, EnvelopeObserver, PayboxPort, SwapRequest } from "./port.js";
import { asRecord, sleep } from "./util.js";

// REPLAY port. Recorded PayBox envelope sequences, no network calls to PayBox,
// no real funds. x402 payments are real EIP-3009 signatures from a throwaway key
// generated in memory for this run, so a merchant in FACILITATOR_MODE=local can
// verify them; they are never valid on chain (no funds, never broadcast).

export const USDC_ETHEREUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

export class MockPaybox implements PayboxPort {
  readonly label = "replay" as const;
  private account = privateKeyToAccount(generatePrivateKey());
  private requests: Array<{ requestId: string; kind: string; status: EnvelopeStatus }> = [];
  private funded = { base: 400_000n, ethereum: 1_000_000n };
  private buyPolls = 0;
  private boughtUsd = 0;

  constructor(private readonly config: AgentConfig, private readonly observer: EnvelopeObserver) {}

  private async step(tool: PayboxTool, kind: string, statuses: EnvelopeStatus[], output: Envelope["output"], extra: Partial<Envelope> = {}): Promise<Envelope> {
    const requestId = `rq_replay_${randomBytes(5).toString("hex")}`;
    let envelope: Envelope = { request_id: requestId, status: statuses[0] ?? "success", output: null };
    for (const status of statuses) {
      envelope = { request_id: requestId, status, output: status === "success" ? output : null, ...(status === "pending_approval" ? extra : {}) };
      this.observer(tool, envelope);
      await sleep(status === "pending_approval" ? this.config.mockPaceMs * 3 : this.config.mockPaceMs);
    }
    this.requests.unshift({ requestId, kind, status: envelope.status });
    return envelope;
  }

  async listCredentials(): Promise<CredentialsView> {
    await sleep(this.config.mockPaceMs);
    return {
      wallets: [{ id: "cred_replay_wallet", name: "Replay wallet (Base)", family: "evm", address: this.account.address }],
      cards: [],
      secrets: [{ id: "cred_replay_secret", name: "boxhaggle merchant key" }],
      ungrantedCount: 0,
    };
  }

  async requestAccountChange(note: string) {
    return { manageUrl: `https://app.paybox.sh/clients/replay/manage?note=${encodeURIComponent(note.slice(0, 80))}` };
  }

  async requestSecret(args: { credentialId: string; raw: boolean; purpose: string }): Promise<Envelope> {
    if (args.raw) {
      return this.step("request_secret", "secret", ["success"], { output_type: "raw_secret", value: this.config.mockMerchantKey ?? "" });
    }
    return this.step("request_secret", "secret", ["success"], { output_type: "secret_token", value: `stk_replay_${randomBytes(8).toString("hex")}` });
  }

  async payX402(args: { credentialId: string; accepts: unknown[]; resourceUrl: string }): Promise<Envelope> {
    const accept = args.accepts.map(asRecord).find((a) => a?.network === RAILS.base.v1Network);
    if (!accept) return this.step("pay_x402", "x402", ["error"], null);
    const amount = String(accept.maxAmountRequired);
    const header = await this.sign(String(accept.payTo), amount, Number(accept.maxTimeoutSeconds ?? 300));
    const isCheckout = args.resourceUrl.includes("/checkout");
    const statuses: EnvelopeStatus[] = isCheckout ? ["pending_approval", "pending_signature", "success"] : ["pending_signature", "success"];
    return this.step(
      "pay_x402",
      "x402",
      statuses,
      { output_type: "signature", value: { x_payment: { header: "X-PAYMENT", value: header } } },
      { approval_url: "https://app.paybox.sh/approvals/replay" },
    );
  }

  async getRequest(requestId: string): Promise<Envelope> {
    const row = this.requests.find((r) => r.requestId === requestId);
    return { request_id: requestId, status: row?.status ?? "error", output: null };
  }

  async getPortfolio(args: { address: string; token: string; networkId: number }) {
    await sleep(this.config.mockPaceMs / 2);
    if (args.networkId === 1) return { matched: true, items: [{ token: USDC_ETHEREUM, balance: String(this.funded.ethereum) }] };
    if (args.networkId === 8453 && args.token === "native") return { matched: true, items: [{ token: "native", balance: "0" }] };
    if (this.boughtUsd > 0) {
      this.buyPolls += 1;
      if (this.buyPolls >= 2) {
        this.funded.base += BigInt(this.boughtUsd * 1_000_000);
        this.boughtUsd = 0;
      }
    }
    return { matched: true, items: [{ token: RAILS.base.usdc, balance: String(this.funded.base) }] };
  }

  async getBuyLink(args: { credentialId: string; destinationChain: string; currencyCode: string; amountUsd: number }) {
    await sleep(this.config.mockPaceMs);
    this.boughtUsd = args.amountUsd;
    return {
      url: `https://buy.moonpay.com/?currencyCode=${args.currencyCode}&baseCurrencyAmount=${args.amountUsd}&replay=1`,
      network: args.destinationChain,
      currency: args.currencyCode,
    };
  }

  async verifySolanaBalance() {
    return { amount: "0" };
  }

  async discoverTokens(args: { mode: "search" | "token_detail"; chain: string; query?: string }) {
    await sleep(this.config.mockPaceMs);
    const onBase = args.chain === "eip155:8453" || args.chain === "base";
    return {
      tokens: [
        {
          symbol: "USDC",
          name: "USD Coin",
          address: onBase ? RAILS.base.usdc : USDC_ETHEREUM,
          src_chain: onBase ? "eip155:8453" : "eip155:1",
          network_id: onBase ? 8453 : 1,
          decimals: 6,
          priceUsd: 1,
        },
      ],
    };
  }

  async requestSwap(args: SwapRequest): Promise<Envelope> {
    const crossChain = Boolean(args.dstChain && args.dstChain !== args.srcChain);
    const statuses: EnvelopeStatus[] = crossChain
      ? ["pending_signature", "pending_confirmation", "pending_settlement", "pending_settlement", "success"]
      : ["pending_signature", "pending_confirmation", "success"];
    const envelope = await this.step("request_swap", "swap", statuses, {
      output_type: "tx_hash",
      value: { tx_hash: `0x${randomBytes(32).toString("hex")}` },
    });
    if (envelope.status === "success") {
      const moved = BigInt(args.amount);
      this.funded.ethereum -= moved;
      this.funded.base += (moved * 995n) / 1000n; // bridge fee
    }
    return envelope;
  }

  async requestPayment(): Promise<Envelope> {
    return this.step("request_payment", "payment", ["denied"], null);
  }

  async claimPaymentCredentials(): Promise<Record<string, unknown>> {
    throw new Error("card path is not available in replay");
  }

  async listRequests(limit: number) {
    await sleep(this.config.mockPaceMs);
    return this.requests.slice(0, limit);
  }

  private async sign(payTo: string, value: string, timeoutSeconds: number): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: this.account.address,
      to: payTo as `0x${string}`,
      value,
      validAfter: String(now - 30),
      validBefore: String(now + Math.min(timeoutSeconds, 300)),
      nonce: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
    };
    const signature = await this.account.signTypedData({
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: RAILS.base.usdc as `0x${string}` },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });
    return Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization } })).toString("base64");
  }
}
