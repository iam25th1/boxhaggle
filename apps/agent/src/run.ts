import {
  RAILS,
  STRATEGY,
  formatUsd,
  formatUsdPrecise,
  planMove,
  scorecard,
  verifyReveal,
  type Observation,
  type OfferReply,
  type Rail,
} from "@boxhaggle/core";
import type { AgentConfig } from "./config.js";
import type { Emitter } from "./emitter.js";
import { MerchantClient } from "./merchant-client.js";
import { USDC_ETHEREUM } from "./paybox-mock.js";
import type { CredentialsView, Envelope, PayboxPort, SimpleCredential, WalletCredential } from "./port.js";
import { asRecord, asString, extractPaymentHeader, extractSecretValue, readPriceUsd, readRawBalance, shortId, sleep } from "./util.js";

export class RunAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunAbort";
  }
}

export interface RunResult {
  outcome: "deal" | "walked" | "aborted";
  sessionId: string | null;
  finalPrice: number | null;
  fees: number;
  spent: number;
}

/** Hard cap on what this run may pay the merchant (fees plus checkout). */
export class SpendCap {
  spent = 0;
  constructor(readonly cap: number) {}
  assert(amount: number, what: string): void {
    if (this.spent + amount > this.cap) {
      throw new RunAbort(`spend cap: ${what} (${formatUsdPrecise(amount)}) would bring this run to ${formatUsdPrecise(this.spent + amount)}, over the ${formatUsd(this.cap)} cap`);
    }
  }
  record(amount: number): void {
    this.spent += amount;
  }
}

interface FundingSource {
  label: string;
  chain: string;
  networkId: number;
  token: string;
  symbol: string;
  decimals: number;
  /** Raw units to keep for gas. */
  reserve: bigint;
}

function fundingSources(rail: Rail): FundingSource[] {
  if (rail.family === "solana") {
    return [{ label: "SOL on Solana", chain: "solana:mainnet", networkId: rail.portfolioNetworkId, token: "native", symbol: "SOL", decimals: 9, reserve: 10_000_000n }];
  }
  return [
    { label: "USDC on Ethereum", chain: "eip155:1", networkId: 1, token: USDC_ETHEREUM, symbol: "USDC", decimals: 6, reserve: 0n },
    { label: "ETH on Base", chain: "eip155:8453", networkId: 8453, token: "native", symbol: "ETH", decimals: 18, reserve: 300_000_000_000_000n },
  ];
}

const OUTPUT_TYPES = new Set(["payment_token", "signature", "tx_hash", "secret_token", "raw_secret"]);

export async function runShowcase(config: AgentConfig, port: PayboxPort, emitter: Emitter): Promise<RunResult> {
  const merchant = new MerchantClient(config.merchantUrl);
  const cap = new SpendCap(config.spendCapAtomic);
  const fees: number[] = [];
  let sessionId: string | null = null;
  let finalPrice: number | null = null;

  const thought = (text: string) => emitter.emit({ t: "agent.thought", text: text.slice(0, 280) });
  const call = (tool: Parameters<typeof emitter.emit>[0] extends infer D ? (D extends { t: "paybox.call"; tool: infer T } ? T : never) : never, note?: string) =>
    emitter.emit({ t: "paybox.call", tool, ...(note ? { note } : {}) });

  const requireSuccess = (envelope: Envelope, what: string): Envelope => {
    if (envelope.status === "success") return envelope;
    if (envelope.status === "pending_signature") {
      throw new RunAbort(`${what} is waiting for a signature. Pair a signing key (paybox connect) and set PAYBOX_SIGNING_KEY. Request ${shortId(envelope.request_id)} stays parked; do not re-issue it.`);
    }
    if (envelope.status.startsWith("pending_")) {
      throw new RunAbort(`${what} is still ${envelope.status} after the wait window. Check request ${shortId(envelope.request_id)} with get_request; nothing was re-issued.`);
    }
    throw new RunAbort(`${what} ended ${envelope.status}${envelope.error ? `: ${String(envelope.error).slice(0, 160)}` : ""}`);
  };

  emitter.emit({ t: "run.started", mode: port.label, capUsd: config.spendCapAtomic / 1_000_000, strategy: STRATEGY.name });

  try {
    // ---- 1. credentials ----
    call("list_credentials");
    let creds = await port.listCredentials();
    const pick = (view: CredentialsView) => ({
      wallet: pickWallet(view, config.walletCredentialId),
      secret: pickSecret(view, config.secretCredentialId),
      card: view.cards[0],
    });
    let chosen = pick(creds);
    emitCredentials(emitter, chosen.wallet, chosen.card, chosen.secret);

    if (!chosen.wallet || !chosen.secret) {
      const missing = [!chosen.wallet ? "a Solana or Base wallet" : null, !chosen.secret ? "the BOXHAGGLE merchant key as a secret" : null].filter(Boolean).join(" and ");
      const note = `BOXHAGGLE needs ${missing} granted to this agent.`;
      call("request_account_change", note);
      const change = await port.requestAccountChange(note);
      emitter.emit({ t: "account.change", note, manageUrl: change.manageUrl });
      const deadline = Date.now() + config.accountWaitMs;
      while ((!chosen.wallet || !chosen.secret) && Date.now() < deadline) {
        await sleep(5_000);
        call("list_credentials", "checking for the new grant");
        creds = await port.listCredentials();
        chosen = pick(creds);
      }
      emitCredentials(emitter, chosen.wallet, chosen.card, chosen.secret);
      if (!chosen.wallet || !chosen.secret) throw new RunAbort("grants still missing after the account change window");
    }
    const wallet = chosen.wallet;
    const secret = chosen.secret;
    const rail = wallet.family === "solana" ? RAILS.solana : RAILS.base;

    // ---- 2. merchant key through PayBox ----
    let key: string | null = null;
    if (config.secretMode === "token-then-raw") {
      call("request_secret", "raw: false (one-time token)");
      requireSuccess(
        await port.requestSecret({ credentialId: secret.id, raw: false, purpose: "BOXHAGGLE: authenticate to The Broker's merchant API" }),
        "request_secret (token)",
      );
      emitter.emit({ t: "vault.opened", drawer: "secret", outputType: "secret_token", note: "one-time token, never shown" });
      thought("PayBox documents no way for a third-party merchant to redeem a secret_token, so the agent asks for the raw key. It lives in process memory only and is never logged or relayed.");
    }
    call("request_secret", "raw: true (merchant egress)");
    const raw = requireSuccess(
      await port.requestSecret({ credentialId: secret.id, raw: true, purpose: "BOXHAGGLE: send X-Merchant-Key to The Broker" }),
      "request_secret (raw)",
    );
    key = extractSecretValue(raw.output?.value);
    if (!key) throw new RunAbort("request_secret succeeded but returned no usable value");
    emitter.emit({ t: "vault.opened", drawer: "secret", outputType: "raw_secret", note: "held in process memory only" });

    // ---- 3. session ----
    const session = await merchant.createSession(config.itemId, key);
    sessionId = session.sessionId;
    emitter.attach(session.sessionId, key);
    if (!session.networks.includes(rail.v2Network)) {
      throw new RunAbort(`The Broker does not accept ${rail.label} payments here (accepts ${session.networks.join(", ")})`);
    }
    thought(`Session open for the ${session.item.name} at ${formatUsd(session.listPrice)}. Each counter-offer costs ${formatUsdPrecise(session.offerFee)} on ${rail.label}.`);

    const paidCall = async (route: "offer" | "checkout", body: Record<string, unknown>, expected: number, what: string) => {
      const probe = await merchant.post(`/${route}`, body, key!);
      if (probe.status !== 402) throw new RunAbort(`${what}: expected a 402 challenge, got ${probe.status}`);
      const challenge = asRecord(await probe.json());
      const accepts = Array.isArray(challenge?.accepts) ? challenge.accepts : [];
      const accept = selectAccept(accepts, rail, expected, rail.id === "solana" ? config.expectPayTo.solana : config.expectPayTo.base);
      if (!accept) throw new RunAbort(`${what}: no payment requirement matched ${formatUsdPrecise(expected)} USDC on ${rail.label}`);
      cap.assert(expected, what);
      call("pay_x402", `${formatUsdPrecise(expected)} on ${rail.label}`);
      const envelope = requireSuccess(
        await port.payX402({ credentialId: wallet.id, accepts: [accept], resourceUrl: String(accept.resource) }),
        `pay_x402 (${what})`,
      );
      const header = extractPaymentHeader(envelope.output?.value);
      emitter.emit({ t: "vault.opened", drawer: "wallet", outputType: "signature", note: "x402 payment authorization" });
      const paid = await merchant.post(String(accept.resource), body, key!, header);
      if (paid.status === 402) {
        const reason = asString(asRecord(await paid.json())?.error) ?? "unknown";
        throw new RunAbort(`${what}: the merchant rejected the payment (${reason}). Not retrying, to avoid a second charge.`);
      }
      cap.record(expected);
      return paid;
    };

    // ---- 4. haggle ----
    const obs: Observation = {
      listPrice: session.listPrice,
      ask: session.ask,
      patience: session.patience,
      mood: session.mood,
      round: 0,
      lastOffer: null,
      previousAsk: null,
      fee: session.offerFee,
    };
    let status: OfferReply["status"] = "open";
    while (status === "open") {
      const move = planMove(obs);
      thought(`${move.reason} Offer ${formatUsd(move.amount)}.`);
      cap.assert(obs.fee + move.amount, `round ${obs.round + 1} plus that price`);
      const res = await paidCall("offer", { sessionId: session.sessionId, amount: String(move.amount) }, obs.fee, `round ${obs.round + 1}`);
      const reply = await merchant.parseOffer(res);
      fees.push(reply.fee);
      Object.assign(obs, {
        ask: reply.ask,
        patience: reply.patience,
        mood: reply.mood,
        round: reply.round,
        lastOffer: move.amount,
        previousAsk: reply.previousAsk,
      });
      status = reply.status;
      finalPrice = reply.finalPrice;
    }

    if (status === "walked" || finalPrice === null) {
      thought("The Broker walked. No deal, fees spent.");
      const reveal = await merchant.reveal(session.sessionId);
      thought(`Floor was ${formatUsd(reveal.floor)}. Commitment check: ${verifyReveal(session.commitment, reveal.floor, reveal.salt).verified ? "verified" : "MISMATCH"}.`);
      const card = scorecard(session.listPrice, null, fees);
      emitter.emit({ t: "score", ...card });
      emitter.emit({ t: "run.ended", outcome: "walked" });
      return { outcome: "walked", sessionId, finalPrice: null, fees: card.fees, spent: cap.spent };
    }

    // ---- 5. funds ----
    await ensureFunds(config, port, emitter, wallet, rail, finalPrice, thought, call);

    // ---- 6. checkout ----
    thought(`Deal at ${formatUsd(finalPrice)}. Paying the exact price through PayBox. Above the approval threshold this waits for a passkey.`);
    const checkout = await merchant.parseCheckout(await paidCall("checkout", { sessionId: session.sessionId }, finalPrice, "checkout"));
    thought(`Cleared. Receipt ${checkout.receiptId}.`);

    // ---- 7. card path (fails closed) ----
    if (config.cardPath) {
      thought("CARD_PATH=on, but no processor-hosted charger is configured. Refusing to request a one-time card that nothing could charge safely.");
    }

    // ---- 8. reveal ----
    const reveal = await merchant.reveal(session.sessionId);
    const check = verifyReveal(session.commitment, reveal.floor, reveal.salt);
    thought(`Floor was ${formatUsd(reveal.floor)}. Recomputed the commitment locally: ${check.verified ? "verified" : "MISMATCH"}.`);

    // ---- 9. receipt ----
    call("list_requests");
    try {
      const rows = await port.listRequests(20);
      emitter.emit({ t: "receipt", rows: rows.slice(0, 20).map((r) => ({ requestId: shortId(r.requestId), kind: r.kind.slice(0, 32), status: r.status.slice(0, 32) })) });
    } catch (error) {
      thought(`list_requests unavailable: ${error instanceof Error ? error.message.slice(0, 120) : "error"}`);
    }

    // ---- 10. score ----
    const card = scorecard(session.listPrice, finalPrice, fees);
    emitter.emit({ t: "score", ...card });
    emitter.emit({ t: "run.ended", outcome: "deal" });
    return { outcome: "deal", sessionId, finalPrice, fees: card.fees, spent: cap.spent };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    emitter.emit({ t: "run.ended", outcome: "aborted", reason: reason.slice(0, 280) });
    return { outcome: "aborted", sessionId, finalPrice, fees: fees.reduce((a, b) => a + b, 0), spent: cap.spent };
  } finally {
    await emitter.drain();
  }
}

function pickWallet(view: CredentialsView, wanted?: string): WalletCredential | undefined {
  if (wanted) return view.wallets.find((w) => w.id === wanted);
  return view.wallets.find((w) => w.family === "solana") ?? view.wallets[0];
}

function pickSecret(view: CredentialsView, wanted?: string): SimpleCredential | undefined {
  if (wanted) return view.secrets.find((s) => s.id === wanted);
  return view.secrets.find((s) => /boxhaggle|broker|merchant/i.test(s.name)) ?? view.secrets[0];
}

function emitCredentials(emitter: Emitter, wallet?: WalletCredential, card?: SimpleCredential, secret?: SimpleCredential) {
  emitter.emit({
    t: "credentials.listed",
    wallet: wallet
      ? { present: true, chain: wallet.family === "solana" ? "Solana" : "EVM", ...(wallet.address ? { address: shortId(wallet.address) } : {}) }
      : { present: false },
    card: card ? { present: true, ...(card.brand ? { brand: card.brand.slice(0, 32) } : {}) } : { present: false },
    secret: secret ? { present: true, name: secret.name.slice(0, 64) } : { present: false },
  });
}

/** Choose the one x402 requirement we are willing to pay: our rail, USDC, the exact expected amount, optional payTo pin. */
export function selectAccept(accepts: unknown[], rail: Rail, expected: number, pinnedPayTo?: string): Record<string, unknown> | null {
  for (const candidate of accepts) {
    const a = asRecord(candidate);
    if (!a) continue;
    const asset = asString(a.asset) ?? "";
    const payTo = asString(a.payTo) ?? "";
    const sameAsset = rail.family === "evm" ? asset.toLowerCase() === rail.usdc.toLowerCase() : asset === rail.usdc;
    if (a.scheme !== "exact" || a.network !== rail.v1Network || !sameAsset) continue;
    if (String(a.maxAmountRequired) !== String(expected)) continue;
    if (pinnedPayTo && (rail.family === "evm" ? payTo.toLowerCase() !== pinnedPayTo.toLowerCase() : payTo !== pinnedPayTo)) continue;
    if (typeof a.resource !== "string" || !/^https?:\/\//.test(a.resource)) continue;
    return a;
  }
  return null;
}

async function ensureFunds(
  config: AgentConfig,
  port: PayboxPort,
  emitter: Emitter,
  wallet: WalletCredential,
  rail: Rail,
  need: number,
  thought: (text: string) => void,
  call: (tool: "get_portfolio" | "discover_tokens" | "request_swap" | "get_buy_link" | "verify_solana_balance", note?: string) => void,
): Promise<void> {
  if (!wallet.address) throw new RunAbort("wallet has no public address in list_credentials; cannot check funds");
  const address = wallet.address;

  const readTarget = async (note?: string): Promise<bigint | null> => {
    call("get_portfolio", note ?? `USDC on ${rail.label}`);
    const have = readRawBalance(await port.getPortfolio({ address, token: rail.usdc, networkId: rail.portfolioNetworkId }), rail.usdc);
    emitter.emit({ t: "funds.checked", need, have: have === null ? null : Number(have), asset: "USDC", network: rail.label, ok: have !== null && have >= BigInt(need) });
    return have;
  };

  let have = await readTarget();
  if (have !== null && have >= BigInt(need)) return;
  if (have === null) thought("Could not read a single USDC balance from get_portfolio. Treating it as unconfirmed.");

  // Funds in the wrong token or on the wrong chain: swap or bridge what is there.
  for (const source of fundingSources(rail)) {
    const shortfall = BigInt(need) - (have ?? 0n);
    if (shortfall <= 0n) return;
    call("get_portfolio", source.label);
    const balance = readRawBalance(await port.getPortfolio({ address, token: source.token, networkId: source.networkId }), source.token);
    if (balance === null || balance <= source.reserve) continue;

    call("discover_tokens", `USDC on ${rail.label}`);
    const resolved = await port.discoverTokens({ mode: "search", chain: rail.payboxChain, query: "USDC" });
    const rows = asRecord(resolved)?.tokens;
    const tokenRows = Array.isArray(rows) ? rows : Array.isArray(resolved) ? resolved : [];
    const match = tokenRows.map(asRecord).find((r) => {
      const addr = asString(r?.address) ?? "";
      return rail.family === "evm" ? addr.toLowerCase() === rail.usdc.toLowerCase() : addr === rail.usdc;
    });
    if (!match) {
      thought("discover_tokens did not confirm the USDC address for this rail. Not swapping into an unverified token.");
      break;
    }

    let amountIn: bigint;
    if (source.symbol === "USDC") {
      amountIn = (shortfall * 102n) / 100n;
    } else {
      call("discover_tokens", `${source.symbol} price`);
      const price = readPriceUsd(await port.discoverTokens({ mode: "search", chain: source.chain, query: source.symbol }), source.symbol);
      if (!price) {
        thought(`No ${source.symbol} price from discover_tokens. Skipping the swap.`);
        continue;
      }
      const usdNeeded = (Number(shortfall) / 1_000_000) * 1.03;
      amountIn = BigInt(Math.ceil((usdNeeded / price) * 10 ** source.decimals));
    }
    const spendable = balance - source.reserve;
    if (amountIn > spendable) amountIn = spendable;
    if (amountIn <= 0n) continue;

    const crossChain = source.chain !== rail.payboxChain;
    emitter.emit({ t: "swap.quote", fromSymbol: source.symbol, fromChain: source.chain, toSymbol: "USDC", toChain: rail.payboxChain, amountIn: amountIn.toString() });
    thought(crossChain ? `Funds are on the wrong chain. Bridging ${source.label} to ${rail.label}.` : `Funds are in the wrong token. Swapping ${source.symbol} to USDC.`);
    call("request_swap", crossChain ? "cross-chain" : "same chain");
    const envelope = await port.requestSwap({
      credentialId: wallet.id,
      srcChain: source.chain,
      ...(crossChain ? { dstChain: rail.payboxChain } : {}),
      srcToken: source.token,
      dstToken: rail.usdc,
      amount: amountIn.toString(),
      valueCents: Math.ceil((Number(shortfall) / 1_000_000) * 100),
    });
    if (envelope.status !== "success") {
      thought(`Swap ended ${envelope.status}. Not re-issuing it.`);
      continue;
    }
    // Re-read only (never re-issue the swap); stop once the balance moves.
    const before = have;
    for (const backoff of [0, 2_000, 5_000, 10_000]) {
      if (backoff) await sleep(port.label === "replay" ? 300 : backoff);
      have = await readTarget("after swap");
      if (have !== null && have >= BigInt(need)) return;
      if (have !== null && before !== null && have > before) break;
    }
  }

  // Still short: fund with a MoonPay buy link.
  const shortfall = BigInt(need) - (have ?? 0n);
  const amountUsd = Math.max(20, Math.ceil(Number(shortfall) / 1_000_000));
  call("get_buy_link", `${amountUsd} USD of USDC on ${rail.label}`);
  const link = await port.getBuyLink({
    credentialId: wallet.id,
    destinationChain: rail.payboxChain,
    currencyCode: rail.id === "solana" ? "usdc_sol" : "usdc_base",
    amountUsd,
  });
  emitter.emit({ t: "funds.buylink", url: link.url, network: link.network, currency: link.currency });
  thought("Waiting for the MoonPay checkout to land in the wallet. Only a balance read counts as arrival.");

  if (config.buyTxSignature && rail.family === "solana") {
    call("verify_solana_balance");
    const verified = await port.verifySolanaBalance({ address, tokenMint: rail.usdc, transactionSignature: config.buyTxSignature });
    if (BigInt(verified.amount) >= BigInt(need)) {
      emitter.emit({ t: "funds.checked", need, have: Number(verified.amount), asset: "USDC", network: rail.label, ok: true });
      return;
    }
  }

  const deadline = Date.now() + config.fundingWaitMs;
  while (Date.now() < deadline) {
    await sleep(port.label === "replay" ? 800 : 15_000);
    have = await readTarget("waiting for funding");
    if (have !== null && have >= BigInt(need)) return;
  }
  throw new RunAbort("wallet is still short of USDC after the funding window");
}

export { OUTPUT_TYPES };
