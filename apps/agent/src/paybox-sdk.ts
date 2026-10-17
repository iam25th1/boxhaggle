import { PayboxClient, type AgentResponse } from "@paybox-sh/sdk";
import type { PayboxTool } from "@boxhaggle/core";
import type { AgentConfig } from "./config.js";
import { McpTools } from "./mcp.js";
import type { CredentialsView, Envelope, EnvelopeObserver, PayboxPort, SwapRequest } from "./port.js";
import { asRecord, asString } from "./util.js";

// Live PayBox port over @paybox-sh/sdk 2.2.0. Method names and REST paths were
// read from the SDK's dist (see docs/RECON.md section 1).
//
// Observation: the SDK only signs a parked x402 or swap request inside the same
// payX402 / requestSwap call (completeX402 -> waitWhileApproval -> sign). So we
// pass waitForApproval and watch every /agent/* response through fetchImpl,
// which lets the UI show pending_approval (with its approval_url), then
// pending_signature, pending_confirmation and so on, without ever re-calling a
// write tool. The observer reads only request_id, status, output_type,
// approval_url and error; it never forwards outputs.

function toEnvelope(value: unknown): Envelope | null {
  const record = asRecord(value);
  if (!record) return null;
  const inner = asRecord(record.response) ?? record;
  const requestId = asString(inner.request_id);
  const status = asString(inner.status);
  if (!requestId || !status) return null;
  return inner as unknown as Envelope;
}

function toolForRequest(method: string, path: string, body: unknown): PayboxTool | "get_request" | null {
  if (method === "POST" && path === "/agent/x402") return "pay_x402";
  if (method === "POST" && path === "/agent/use-service") return "use_service";
  if (method === "POST" && path === "/agent/swap") return "request_swap";
  if (method === "POST" && path === "/agent/request") {
    const type = asString(asRecord(asRecord(body)?.operation)?.type);
    return type === "secret" ? "request_secret" : type === "payment" ? "request_payment" : null;
  }
  if (method === "GET" && /^\/agent\/requests\/[^/]+$/.test(path)) return "get_request";
  return null;
}

export function observingFetch(observer: EnvelopeObserver, base: typeof fetch = fetch): typeof fetch {
  const toolByRequest = new Map<string, PayboxTool>();
  const lastStatus = new Map<string, string>();
  return async (input, init) => {
    const response = await base(input, init);
    try {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      let body: unknown = undefined;
      if (typeof init?.body === "string") body = JSON.parse(init.body);
      const tool = toolForRequest(method, url.pathname, body);
      if (tool && response.ok) {
        const envelope = toEnvelope(await response.clone().json());
        if (envelope) {
          const resolved = tool === "get_request" ? toolByRequest.get(envelope.request_id) : tool;
          if (resolved) {
            toolByRequest.set(envelope.request_id, resolved);
            if (lastStatus.get(envelope.request_id) !== envelope.status) {
              lastStatus.set(envelope.request_id, envelope.status);
              observer(resolved, envelope);
            }
          }
        }
      }
    } catch {
      // Observation is best effort; never interfere with the SDK call.
    }
    return response;
  };
}

export class SdkPaybox implements PayboxPort {
  readonly label = "live" as const;
  private client: PayboxClient;
  private mcp: McpTools;

  constructor(private readonly config: AgentConfig, observer: EnvelopeObserver) {
    if (!config.payboxApiKey) throw new Error("PAYBOX_API_KEY missing");
    const fetchImpl = observingFetch(observer);
    this.client = new PayboxClient({
      baseUrl: config.payboxApiUrl,
      apiKey: config.payboxApiKey,
      ...(config.payboxSigningKey ? { signingKey: config.payboxSigningKey } : {}),
      fetchImpl,
    });
    this.mcp = new McpTools(config.payboxApiUrl, config.payboxApiKey);
  }

  private wait() {
    return { waitForApproval: { intervalMs: 3_000, timeoutMs: this.config.approvalWaitMs } };
  }

  async listCredentials(): Promise<CredentialsView> {
    const list = (await this.client.listCredentials()) as unknown as Record<string, unknown>;
    const view: CredentialsView = { wallets: [], cards: [], secrets: [], ungrantedCount: 0 };
    const rows = Array.isArray(list.credentials) ? list.credentials : [];
    for (const row of rows) {
      const r = asRecord(row) ?? {};
      const cred = asRecord(r.credential) ?? r;
      const id = asString(cred.id) ?? asString(cred.credential_id);
      const kind = asString(cred.credential_type) ?? asString(cred.kind);
      const name = asString(cred.name) ?? "unnamed";
      const meta = asRecord(cred.metadata) ?? {};
      if (!id || !kind) continue;
      if (kind === "wallet") {
        const chains = Array.isArray(meta.chains) ? meta.chains.map(String) : [];
        view.wallets.push({ id, name, family: chains.includes("solana") ? "solana" : "evm", address: asString(meta.address) ?? null });
      } else if (kind === "card") {
        view.cards.push({ id, name, brand: asString(meta.brand) });
      } else if (kind === "secret") {
        view.secrets.push({ id, name });
      }
    }
    view.ungrantedCount = Array.isArray(list.ungranted) ? list.ungranted.length : 0;
    return view;
  }

  async requestAccountChange(note: string) {
    const result = await this.client.requestAccountChange(note);
    return { manageUrl: result.manage_url };
  }

  async requestSecret(args: { credentialId: string; raw: boolean; purpose: string }): Promise<Envelope> {
    const first = (await this.client.requestSecret(args)) as unknown as Envelope;
    return this.pollUntilTerminal(first);
  }

  async payX402(args: { credentialId: string; accepts: unknown[]; resourceUrl: string }): Promise<Envelope> {
    const result = await this.client.payX402(args, this.wait());
    return result.response as unknown as Envelope;
  }

  async getRequest(requestId: string): Promise<Envelope> {
    return (await this.client.getRequest(requestId)) as unknown as Envelope;
  }

  getPortfolio(args: { address: string; token: string; networkId: number }) {
    return this.client.getPortfolio({ address: args.address, token: args.token, networkId: args.networkId });
  }

  async getBuyLink(args: { credentialId: string; destinationChain: string; currencyCode: string; amountUsd: number }) {
    const result = await this.client.getBuyLink({
      credentialId: args.credentialId,
      destinationChain: args.destinationChain as "solana:mainnet",
      currencyCode: args.currencyCode,
      amountUsd: args.amountUsd,
    });
    return { url: result.url, network: result.network, currency: result.currency_code };
  }

  async verifySolanaBalance(args: { address: string; tokenMint: string; transactionSignature: string }) {
    const result = await this.client.verifySolanaBalance(args);
    return { amount: result.balance.amount };
  }

  discoverTokens(args: { mode: "search" | "token_detail"; chain: string; query?: string; tokenAddress?: string }) {
    return this.mcp.call("discover_tokens", {
      mode: args.mode,
      chain: args.chain,
      ...(args.query ? { query: args.query } : {}),
      ...(args.tokenAddress ? { token_address: args.tokenAddress } : {}),
      limit: 5,
    });
  }

  async requestSwap(args: SwapRequest): Promise<Envelope> {
    const result = await this.client.requestSwap(
      {
        credentialId: args.credentialId,
        srcChain: args.srcChain,
        ...(args.dstChain ? { dstChain: args.dstChain } : {}),
        srcToken: args.srcToken,
        dstToken: args.dstToken,
        amount: args.amount,
        swapDirection: "exact-amount-in",
        ...(args.valueCents !== undefined ? { valueCents: args.valueCents } : {}),
      },
      this.wait(),
    );
    return this.pollUntilTerminal(result.response as unknown as Envelope);
  }

  async requestPayment(args: { credentialId: string; merchant: string; merchantUrl: string; amountCents: number }): Promise<Envelope> {
    const first = (await this.client.requestPayment({ ...args, currency: "USD" })) as unknown as Envelope;
    return this.pollUntilTerminal(first);
  }

  claimPaymentCredentials(requestId: string) {
    return this.client.claimPaymentCredentials(requestId);
  }

  async listRequests(limit: number) {
    const raw = await this.mcp.call("list_requests", { limit });
    const record = asRecord(raw);
    const rows = Array.isArray(raw) ? raw : Array.isArray(record?.requests) ? record.requests : Array.isArray(record?.rows) ? record.rows : [];
    return rows
      .map((row) => asRecord(row))
      .filter((row): row is Record<string, unknown> => Boolean(row))
      .map((row) => ({
        requestId: asString(row.request_id) ?? "?",
        kind: asString(row.kind) ?? "?",
        status: asString(row.status) ?? "?",
      }));
  }

  /** Poll get_request for a request that needs no signing (secret, payment) or that the SDK returned mid-flight. */
  private async pollUntilTerminal(envelope: Envelope): Promise<Envelope> {
    let current = envelope;
    let interval = 2_000;
    const deadline = Date.now() + this.config.approvalWaitMs;
    while (isPending(current) && Date.now() < deadline) {
      if (current.status === "pending_signature" && !this.client.canSign) return current;
      await new Promise((resolve) => setTimeout(resolve, interval));
      current = await this.getRequest(current.request_id);
      interval = Math.min(interval * 1.5, 10_000);
    }
    return current;
  }
}

function isPending(envelope: Envelope): boolean {
  return envelope.status.startsWith("pending_");
}

export type { AgentResponse };
