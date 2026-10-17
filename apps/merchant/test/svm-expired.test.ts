import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAgentData } from "@boxhaggle/core";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { HttpFacilitator } from "../src/x402/facilitator.js";

// Regression for the PayBox payments PayAI refused on 2026-10-17 with
// invalid_exact_svm_transaction_simulation_failed. The transaction itself was
// sound; its blockhash had expired before the paid retry reached the merchant.
// PayAI said so in invalidMessage, which the merchant used to drop.

const KEY = "svm-test-merchant-key-0123456789abcdef01234567";
const PAY_TO = "PayTo1111111111111111111111111111111111111";
const FEE_PAYER = "FeePayer11111111111111111111111111111111111";
const FACILITATOR = "http://facilitator.test";
const PAYAI_VERIFY = {
  isValid: false,
  invalidReason: "invalid_exact_svm_transaction_simulation_failed",
  invalidMessage: 'Simulation failed: "BlockhashNotFound"',
  payer: "Payer111111111111111111111111111111111111111",
};

/**
 * The layout of the rejected PayBox transaction, decoded from its x_payment with
 * every key replaced: a v0 message, two signers with the fee payer slot left
 * empty for the facilitator, one readonly signer, four readonly unsigned
 * accounts, no lookup tables, and four instructions: compute unit limit 20000,
 * compute unit price 1, TransferChecked 10000 at 6 decimals, a 32-byte hex
 * memo. 496 bytes, like the original. Nothing here can be spent.
 */
function rejectedPayBoxTransaction(memo: string): string {
  const key = (n: number) => Buffer.alloc(32, n);
  const u32 = (v: number) => Buffer.from(new Uint32Array([v]).buffer);
  const u64 = (v: bigint) => Buffer.from(new BigUint64Array([v]).buffer);
  const ix = (program: number, accounts: number[], data: Buffer) => Buffer.concat([Buffer.from([program, accounts.length, ...accounts, data.length]), data]);
  // Accounts: 0 fee payer, 1 payer, 2 payer ATA, 3 payTo ATA, 4 ComputeBudget, 5 Token, 6 USDC mint, 7 Memo.
  const message = Buffer.concat([
    Buffer.from([0x80, 2, 1, 4, 8]),
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(key),
    key(9),
    Buffer.from([4]),
    ix(4, [], Buffer.concat([Buffer.from([2]), u32(20_000)])),
    ix(4, [], Buffer.concat([Buffer.from([3]), u64(1n)])),
    ix(5, [2, 6, 3, 1], Buffer.concat([Buffer.from([12]), u64(10_000n), Buffer.from([6])])),
    ix(7, [], Buffer.from(memo)),
    Buffer.from([0]),
  ]);
  return Buffer.concat([Buffer.from([2]), Buffer.alloc(64), Buffer.alloc(64, 0xab), message]).toString("base64");
}

function setup() {
  const lines: string[] = [];
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/supported") {
      return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", extra: { feePayer: FEE_PAYER } }], extensions: [], signers: {} });
    }
    if (path === "/verify" && init?.method === "POST") return Response.json(PAYAI_VERIFY);
    return new Response("unexpected", { status: 500 });
  });
  const config = loadConfig({
    NODE_ENV: "test",
    MERCHANT_API_KEY: KEY,
    PAYTO_SOLANA: PAY_TO,
    X402_NETWORKS: "solana",
    FACILITATOR_MODE: "http",
    X402_FACILITATOR_URL: FACILITATOR,
    PUBLIC_BASE_URL: "http://merchant.test",
    TRUST_CF_CONNECTING_IP: "1",
  });
  const log = createLogger("debug", (line) => lines.push(line));
  const { app } = createApp({ config, facilitator: new HttpFacilitator(config.facilitatorUrl), log });
  return { app, lines, calls };
}

type App = ReturnType<typeof setup>["app"];
const socket = { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50000, remoteFamily: "IPv4" } } };
let nextId = 1;

async function tool(app: App, name: string, args: Record<string, unknown>) {
  const res = await app.request(
    "/mcp",
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", "cf-connecting-ip": "198.51.100.30" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    },
    socket,
  );
  const text = await res.text();
  const json = (res.headers.get("content-type")?.includes("text/event-stream")
    ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join(""))
    : JSON.parse(text)) as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, any> } };
  return json.result;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("svm: a payment whose blockhash expired before the retry", () => {
  it("is refused as payment_expired, with the reason and a fresh next step in the text and AGENT DATA", async () => {
    const { app, lines, calls } = setup();
    const start = await tool(app, "haggle_start", { itemId: "tin-robot" });
    const id = start.structuredContent!.sessionId as string;
    const quote = await tool(app, "haggle_offer", { sessionId: id, offerUsd: "1.20" });
    const payment = parseAgentData(quote.content[0]!.text)!.payment as { accepts: Array<Record<string, any>>; resource: Record<string, unknown> };
    expect(payment.accepts[0]!.extra).toEqual({ feePayer: FEE_PAYER });

    // The x_payment PayBox returned, in its own key order.
    const transaction = rejectedPayBoxTransaction("0123456789abcdef0123456789abcdef");
    expect(Buffer.from(transaction, "base64")).toHaveLength(496);
    const xPayment = Buffer.from(JSON.stringify({ accepted: payment.accepts[0], payload: { transaction }, resource: payment.resource, x402Version: 2 })).toString("base64");
    const out = await tool(app, "haggle_offer", { sessionId: id, offerUsd: "1.20", payment: xPayment });

    expect(out.isError).toBe(true);
    const text = out.content[0]!.text;
    expect(text.slice(0, 200)).toMatch(/^The Broker refused the payment \(payment_expired\): .*expired.*Nothing was charged\./);
    const data = parseAgentData(text)!;
    expect(data).toMatchObject({ sessionId: id, phase: "rejected", status: "open", round: 0, charged: false, reason: "payment_expired", offerUsd: "1.20" });
    expect((data.payment as { accepts: unknown }).accepts).toEqual(payment.accepts);
    expect(String(data.nextStep)).toContain(`haggle_offer with sessionId "${id}", offerUsd "1.20"`);
    expect(String(data.nextStep)).toMatch(/very next action/);
    expect(text).not.toContain(transaction);
    expect(text).not.toContain(xPayment);

    // Nothing settled, nothing spent, and the facilitator's words reach the log, not the payload.
    expect(calls.filter((p) => p === "/settle")).toHaveLength(0);
    expect((data.budget as { spentUsd: string }).spentUsd).toBe("$0.00");
    const failed = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "payment verify failed");
    expect(failed).toMatchObject({ reason: "invalid_exact_svm_transaction_simulation_failed", detail: 'Simulation failed: "BlockhashNotFound"' });
    for (const line of lines) {
      expect(line).not.toContain(transaction.slice(0, 64));
      expect(line).not.toContain(xPayment.slice(0, 64));
    }
  });

  it("warns about the 30 second window before the agent pays", async () => {
    const { app } = setup();
    const start = await tool(app, "haggle_start", { itemId: "tin-robot" });
    const quote = await tool(app, "haggle_offer", { sessionId: start.structuredContent!.sessionId, offerUsd: "1.20" });
    expect(String(parseAgentData(quote.content[0]!.text)!.fallback)).toMatch(/expires about 30 seconds after PayBox signs it/);
  });
});
