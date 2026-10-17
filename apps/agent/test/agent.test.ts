import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentEvent, RAILS } from "@boxhaggle/core";
import { createApp } from "../../merchant/src/app.js";
import { loadConfig as loadMerchantConfig } from "../../merchant/src/config.js";
import { createLogger } from "../../merchant/src/log.js";
import { LocalEvmFacilitator } from "../../merchant/src/x402/facilitator.js";
import { loadConfig } from "../src/config.js";
import { Emitter } from "../src/emitter.js";
import { MockPaybox } from "../src/paybox-mock.js";
import { observingFetch } from "../src/paybox-sdk.js";
import type { EnvelopeObserver } from "../src/port.js";
import { SpendCap, runShowcase, selectAccept } from "../src/run.js";
import { extractPaymentHeader, extractSecretValue, readRawBalance } from "../src/util.js";

const KEY = "agent-test-merchant-key-0123456789abcdefgh";
const PAY_TO = "0x1111111111111111111111111111111111111111";

describe("adapters", () => {
  it("extracts the payment header from every documented-or-plausible shape", () => {
    expect(extractPaymentHeader({ x_payment: { header: "X-PAYMENT", value: "abc" } })).toEqual({ name: "X-PAYMENT", value: "abc" });
    expect(extractPaymentHeader({ x_payment: { name: "PAYMENT-SIGNATURE", value: "abc" } })).toEqual({ name: "PAYMENT-SIGNATURE", value: "abc" });
    expect(extractPaymentHeader({ x_payment: "abc" })).toEqual({ name: "X-PAYMENT", value: "abc" });
    expect(extractPaymentHeader({ x_payment: { "X-PAYMENT": "abc" } })).toEqual({ name: "X-PAYMENT", value: "abc" });
    expect(() => extractPaymentHeader({ nothing: true })).toThrow();
  });

  it("extracts secret values without guessing beyond known keys", () => {
    expect(extractSecretValue("k")).toBe("k");
    expect(extractSecretValue({ value: "k" })).toBe("k");
    expect(extractSecretValue({ secret: "k" })).toBe("k");
    expect(extractSecretValue({ other: "k" })).toBeNull();
  });

  it("reads one raw balance and refuses ambiguous portfolios", () => {
    expect(readRawBalance({ matched: false, items: [] }, "x")).toBe(0n);
    expect(readRawBalance({ items: [{ token: "MINT", balance: "1500000" }] }, "mint")).toBe(1_500_000n);
    expect(readRawBalance({ items: [{ token: "a", balance: "1" }, { token: "b", balance: "2" }] }, "c")).toBeNull();
    expect(readRawBalance({ items: [{ token: "MINT", balance: "1.5" }] }, "MINT")).toBeNull();
  });

  it("only pays the exact expected amount, on its own rail, in USDC, to a pinned payTo", () => {
    const good = { scheme: "exact", network: "base", asset: RAILS.base.usdc, maxAmountRequired: "10000", payTo: PAY_TO, resource: "http://m/offer" };
    expect(selectAccept([good], RAILS.base, 10_000, PAY_TO)).toEqual(good);
    expect(selectAccept([{ ...good, maxAmountRequired: "10001" }], RAILS.base, 10_000)).toBeNull();
    expect(selectAccept([{ ...good, network: "polygon" }], RAILS.base, 10_000)).toBeNull();
    expect(selectAccept([{ ...good, asset: "0x0000000000000000000000000000000000000001" }], RAILS.base, 10_000)).toBeNull();
    expect(selectAccept([good], RAILS.base, 10_000, "0x2222222222222222222222222222222222222222")).toBeNull();
    expect(selectAccept([{ ...good, network: "solana" }], RAILS.solana, 10_000)).toBeNull();
  });

  it("spend cap aborts before overspending", () => {
    const cap = new SpendCap(100);
    cap.assert(60, "a");
    cap.record(60);
    expect(() => cap.assert(41, "b")).toThrow(/spend cap/);
  });

  it("observes SDK envelopes once per status change and never forwards outputs", async () => {
    const seen: Array<{ tool: string; status: string; keys: string[] }> = [];
    const observer: EnvelopeObserver = (tool, env) => seen.push({ tool, status: env.status, keys: Object.keys(env) });
    const responses = [
      { response: { request_id: "r1", status: "pending_approval", output: null, approval_url: "https://app.paybox.sh/a" }, plan: {} },
      { request_id: "r1", status: "pending_approval", output: null },
      { request_id: "r1", status: "success", output: { output_type: "signature", value: { x_payment: "secret-ish" } } },
    ];
    let i = 0;
    const fake: typeof fetch = async () => new Response(JSON.stringify(responses[i++]), { status: 200, headers: { "content-type": "application/json" } });
    const f = observingFetch(observer, fake);
    await f("https://api.paybox.sh/agent/x402", { method: "POST", body: "{}" });
    await f("https://api.paybox.sh/agent/requests/r1", { method: "GET" });
    await f("https://api.paybox.sh/agent/requests/r1", { method: "GET" });
    expect(seen.map((s) => `${s.tool}:${s.status}`)).toEqual(["pay_x402:pending_approval", "pay_x402:success"]);
  });
});

describe("mock run against a real in-process merchant", () => {
  let server: ServerType;
  let url = "";

  beforeAll(async () => {
    const config = loadMerchantConfig({
      NODE_ENV: "test",
      MERCHANT_API_KEY: KEY,
      PAYTO_BASE: PAY_TO,
      X402_NETWORKS: "base",
      FACILITATOR_MODE: "local",
      PUBLIC_BASE_URL: "http://127.0.0.1:0",
    });
    // PUBLIC_BASE_URL must match the bound port, so start, read the port, then rebuild.
    const probe = serve({ fetch: () => new Response("x"), port: 0, hostname: "127.0.0.1" });
    await new Promise((r) => probe.once("listening", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    url = `http://127.0.0.1:${port}`;
    const { app } = createApp({ config: { ...config, publicBaseUrl: url }, facilitator: new LocalEvmFacilitator(), log: createLogger("error", () => {}) });
    server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
    await new Promise((r) => server.once("listening", r));
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  const agentConfig = (cap: string) =>
    loadConfig(["--mock"], { MERCHANT_URL: url, MOCK_MERCHANT_KEY: KEY, MOCK_PACE_MS: "0", SPEND_CAP_USD: cap, FUNDING_WAIT_SECONDS: "5", ITEM_ID: "tin-robot" });

  it("reaches a deal under the cap, every event validates, nothing secret is emitted", async () => {
    const config = agentConfig("3");
    const lines: string[] = [];
    const emitter = new Emitter(url, true, (line) => lines.push(line));
    const observer: EnvelopeObserver = (tool, envelope) =>
      emitter.emit({ t: "paybox.envelope", tool, requestId: envelope.request_id.slice(0, 12), status: envelope.status });
    const result = await runShowcase(config, new MockPaybox(config, observer), emitter);
    expect(result.outcome).toBe("deal");
    expect(result.spent).toBeLessThanOrEqual(3_000_000);
    for (const event of emitter.history) expect(AgentEvent.safeParse(event).success).toBe(true);
    const everything = JSON.stringify(emitter.history) + lines.join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).not.toMatch(/eyJ4NDAy/); // base64 of {"x402 ... never printed
    const types = new Set(emitter.history.map((e) => e.t));
    for (const t of ["credentials.listed", "vault.opened", "funds.checked", "swap.quote", "funds.buylink", "receipt", "score", "run.ended"]) expect(types.has(t as never)).toBe(true);

    const stream = await fetch(`${url}/events/${result.sessionId}`);
    const reader = stream.body!.getReader();
    let text = "";
    while (!text.includes('"t":"run.ended"')) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toContain('"t":"broker.reply"');
    expect(text).toContain('"t":"checkout.paid"');
    expect(text).toContain('"t":"reveal"');
    expect(text).not.toContain(KEY);
  });

  it("aborts cleanly when the cap cannot cover the deal", async () => {
    const config = agentConfig("0.5");
    const emitter = new Emitter(url, false, () => {});
    const result = await runShowcase(config, new MockPaybox(config, () => {}), emitter);
    expect(result.outcome).toBe("aborted");
    expect(result.spent).toBeLessThanOrEqual(500_000);
    const ended = emitter.history.find((e) => e.t === "run.ended");
    expect(ended && "reason" in ended ? ended.reason : "").toMatch(/spend cap/);
  });
});
