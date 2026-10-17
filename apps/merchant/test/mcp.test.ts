import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FRAME_WIDTH, displayWidth, parseAgentData } from "@boxhaggle/core";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { LocalEvmFacilitator } from "../src/x402/facilitator.js";
import { generatePrivateKeyToAccountPair, signExactEvm } from "./sign.js";

const KEY = "mcp-test-merchant-key-0123456789abcdef0123456";
const PAY_TO = "0x2222222222222222222222222222222222222222";
const COUNTER = "<!doctype html><title>counter</title><p>counter</p>";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "boxhaggle-mcp-"));
  const counterHtmlPath = join(dir, "counter.html");
  writeFileSync(counterHtmlPath, COUNTER);
  const lines: string[] = [];
  const config = loadConfig({
    NODE_ENV: "test",
    MERCHANT_API_KEY: KEY,
    PAYTO_BASE: PAY_TO,
    X402_NETWORKS: "base",
    FACILITATOR_MODE: "local",
    PUBLIC_BASE_URL: "http://merchant.test",
    TRUST_CF_CONNECTING_IP: "1",
  });
  const { app } = createApp({ config, facilitator: new LocalEvmFacilitator(), log: createLogger("debug", (line) => lines.push(line)), counterHtmlPath });
  return { app, lines };
}

type App = ReturnType<typeof setup>["app"];
const socket = { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50000, remoteFamily: "IPv4" } } };
let nextId = 1;

/** One 2025-era JSON-RPC request over streamable HTTP, as a remote connector sends it. */
async function rpc(app: App, method: string, params: Record<string, unknown> = {}, ip = "198.51.100.20") {
  const res = await app.request(
    "/mcp",
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", "cf-connecting-ip": ip },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    },
    socket,
  );
  const text = await res.text();
  const json = res.headers.get("content-type")?.includes("text/event-stream")
    ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join(""))
    : JSON.parse(text);
  return { status: res.status, json, text };
}

interface ToolOut {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, any>;
}

async function tool(app: App, name: string, args: Record<string, unknown>, ip?: string): Promise<ToolOut> {
  const { json } = await rpc(app, "tools/call", { name, arguments: args }, ip);
  if (json.error) return { isError: true, content: [{ type: "text", text: String(json.error.message) }] };
  return json.result as ToolOut;
}

function frameLines(out: ToolOut): string[] {
  const match = /^```text\n([\s\S]*?)\n```/.exec(out.content[0]!.text);
  expect(match).not.toBeNull();
  const lines = match![1]!.split("\n");
  for (const line of lines) expect(displayWidth(line), line).toBe(FRAME_WIDTH);
  return lines;
}

async function pay(account: ReturnType<typeof generatePrivateKeyToAccountPair>, out: ToolOut) {
  const p = out.structuredContent!.payment;
  const accept = p.accepts[0];
  const signed = await signExactEvm(account, { to: accept.payTo, value: Number(accept.amount), version: 2, network: accept.network, resource: p.resourceUrl });
  return signed.value;
}

describe("mcp: discovery", () => {
  it("lists five tools linked to the counter UI and serves the UI resource", async () => {
    const { app } = setup();
    const list = await rpc(app, "tools/list");
    const tools = list.json.result.tools as Array<{ name: string; description: string; _meta: Record<string, any> }>;
    expect(tools.map((t) => t.name).sort()).toEqual(["haggle_checkout", "haggle_offer", "haggle_reveal", "haggle_start", "haggle_status"]);
    for (const t of tools) {
      expect(t._meta.ui.resourceUri).toBe("ui://boxhaggle/counter");
      expect(t._meta["ui/resourceUri"]).toBe("ui://boxhaggle/counter");
    }
    for (const name of ["haggle_offer", "haggle_checkout"]) expect(tools.find((t) => t.name === name)!.description).toContain("pay_x402");

    const read = await rpc(app, "resources/read", { uri: "ui://boxhaggle/counter" });
    const content = read.json.result.contents[0];
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(content.text).toBe(COUNTER);
    expect(content._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [] });

    // No arguments at all: the default item and budget.
    const quick = await tool(app, "haggle_start", {});
    expect(quick.structuredContent!.state.itemId).toBe("brass-compass");
    expect(quick.structuredContent!.budget.capUsd).toBe("$3.00");
  });
});

describe("mcp: a full haggle", () => {
  it("starts, quotes x402 requirements, accepts real payments, closes and verifies the reveal", async () => {
    const { app, lines } = setup();
    const payer = generatePrivateKeyToAccountPair();
    const start = await tool(app, "haggle_start", { itemId: "brass-compass", budgetUsd: "5.00" });
    expect(start.isError).toBeUndefined();
    const id = start.structuredContent!.sessionId as string;
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(start.structuredContent!.phase).toBe("opened");
    expect(start.structuredContent!.events[0].t).toBe("session.opened");
    expect(start.structuredContent!.events[0].channel).toBe("plugin");
    frameLines(start);

    // Not announced in the public lobby.
    const lobby = await app.request("/lobby", {}, socket);
    const reader = lobby.body!.getReader();
    const first = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 200))]);
    await reader.cancel();
    expect(first && first.value ? Buffer.from(first.value).toString() : "").not.toContain(id);

    // Offer without payment: requirements, nothing charged.
    const ask = start.structuredContent!.state.askUsd as string;
    const quote = await tool(app, "haggle_offer", { sessionId: id, offerUsd: "1.40" });
    expect(quote.structuredContent!.phase).toBe("payment_required");
    const req = quote.structuredContent!.payment;
    expect(req.x402Version).toBe(2);
    expect(req.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:8453", amount: "10000", payTo: PAY_TO });
    expect(req.resourceUrl).toBe(`http://merchant.test/offer?session=${id}&round=1`);
    expect(quote.structuredContent!.budget.spentUsd).toBe("$0.00");
    expect(frameLines(quote).join("\n")).toContain("awaiting payment");

    // Paid offer.
    const header = await pay(payer, quote);
    const paid = await tool(app, "haggle_offer", { sessionId: id, offerUsd: "1.40", payment: header });
    expect(paid.isError).toBeUndefined();
    expect(paid.structuredContent!.phase).toBe("paid");
    expect(paid.structuredContent!.budget.spentUsd).toBe("$0.01");
    expect(paid.structuredContent!.events.some((e: { t: string }) => e.t === "offer.paid")).toBe(true);
    expect(paid.structuredContent!.fromSeq).toBe(quote.structuredContent!.events.at(-1).seq);
    expect(ask).not.toBe(paid.structuredContent!.state.askUsd);

    // The same payment again is a replay.
    const replay = await tool(app, "haggle_offer", { sessionId: id, offerUsd: "1.40", payment: header });
    expect(replay.isError).toBe(true);
    expect(replay.content[0]!.text).toMatch(/refused/);

    // Meet the ask until The Broker sells.
    let last = paid;
    for (let i = 0; i < 6 && last.structuredContent!.state.status === "open"; i += 1) {
      const offerUsd = String(last.structuredContent!.state.askUsd).slice(1);
      const q = await tool(app, "haggle_offer", { sessionId: id, offerUsd });
      last = await tool(app, "haggle_offer", { sessionId: id, offerUsd, payment: await pay(payer, q) });
    }
    expect(last.structuredContent!.state.status).toBe("sold");
    expect(last.structuredContent!.nextStep).toContain("haggle_checkout");

    const checkoutQuote = await tool(app, "haggle_checkout", { sessionId: id });
    expect(checkoutQuote.structuredContent!.phase).toBe("payment_required");
    const checkout = await tool(app, "haggle_checkout", { sessionId: id, payment: await pay(payer, checkoutQuote) });
    expect(checkout.structuredContent!.phase).toBe("closed");
    expect(checkout.structuredContent!.state.checkoutPaid).toBe(true);

    const reveal = await tool(app, "haggle_reveal", { sessionId: id });
    expect(reveal.structuredContent!.phase).toBe("revealed");
    expect(frameLines(reveal).join("\n")).toContain("SHA-256(floor|salt) VERIFIED");

    // The merchant key never leaves the server and payment headers are not logged.
    const everything = JSON.stringify([start, quote, paid, checkout, reveal]);
    expect(everything).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain(header.slice(0, 40));
  });
});

describe("mcp: refusals", () => {
  it("rejects a forged payment and a second payer, and binds the session to its first payer", async () => {
    const { app } = setup();
    const owner = generatePrivateKeyToAccountPair();
    const stranger = generatePrivateKeyToAccountPair();
    const start = await tool(app, "haggle_start", { itemId: "tin-robot" });
    const id = start.structuredContent!.sessionId as string;
    const q1 = await tool(app, "haggle_offer", { sessionId: id, offerUsd: "1.00" });
    const accept = q1.structuredContent!.payment.accepts[0];
    const forged = await signExactEvm(stranger, { to: accept.payTo, value: Number(accept.amount), version: 2, network: accept.network, resource: q1.structuredContent!.payment.resourceUrl, forgeFrom: owner.address });
    const out = await tool(app, "haggle_offer", { sessionId: id, offerUsd: "1.00", payment: forged.value });
    expect(out.isError).toBe(true);

    const ok = await tool(app, "haggle_offer", { sessionId: id, offerUsd: "1.00", payment: await pay(owner, q1) });
    expect(ok.structuredContent!.phase).toBe("paid");
    const q2 = await tool(app, "haggle_offer", { sessionId: id, offerUsd: "1.10" });
    const other = await tool(app, "haggle_offer", { sessionId: id, offerUsd: "1.10", payment: await pay(stranger, q2) });
    expect(other.isError).toBe(true);
  });

  it("rejects unknown fields, malformed ids and payments, and unknown sessions", async () => {
    const { app } = setup();
    for (const args of [
      { itemId: "tin-robot", floor: 1 },
      { itemId: "not-an-item" },
      { itemId: "tin-robot", budgetUsd: "-1" },
    ]) {
      expect((await tool(app, "haggle_start", args)).isError).toBe(true);
    }
    expect((await tool(app, "haggle_offer", { sessionId: "x", offerUsd: "1.00" })).isError).toBe(true);
    expect((await tool(app, "haggle_offer", { sessionId: "a".repeat(32), offerUsd: "1.00" })).isError).toBe(true);
    const start = await tool(app, "haggle_start", { itemId: "tin-robot" });
    const id = start.structuredContent!.sessionId;
    expect((await tool(app, "haggle_offer", { sessionId: id, offerUsd: "1.00", payment: "not base64 at all!" })).isError).toBe(true);
    expect((await tool(app, "haggle_offer", { sessionId: id, offerUsd: "1.00", note: "hi" })).isError).toBe(true);
    expect((await tool(app, "haggle_reveal", { sessionId: id })).isError).toBe(true);
  });

  it("holds the spend cap chosen at the start", async () => {
    const { app } = setup();
    const payer = generatePrivateKeyToAccountPair();
    const start = await tool(app, "haggle_start", { itemId: "tin-robot", budgetUsd: "0.01" });
    const id = start.structuredContent!.sessionId;
    const q = await tool(app, "haggle_offer", { sessionId: id, offerUsd: "1.00" });
    await tool(app, "haggle_offer", { sessionId: id, offerUsd: "1.00", payment: await pay(payer, q) });
    const over = await tool(app, "haggle_offer", { sessionId: id, offerUsd: "1.10" });
    expect(over.isError).toBe(true);
    expect(over.content[0]!.text).toContain("budget");
  });

  it("rate limits session creation per client IP, behind the tunnel", async () => {
    const { app } = setup();
    const results = [];
    for (let i = 0; i < 13; i += 1) results.push(await tool(app, "haggle_start", { itemId: "tin-robot" }, "203.0.113.9"));
    expect(results.slice(0, 12).every((r) => !r.isError)).toBe(true);
    expect(results[12]!.isError).toBe(true);
    expect(results[12]!.content[0]!.text).toContain("rate_limited");
    // A different client behind the same tunnel is unaffected.
    expect((await tool(app, "haggle_start", { itemId: "tin-robot" }, "203.0.113.10")).isError).toBeUndefined();
  });
});

describe("mcp: an agent that reads only the text", () => {
  it("finds the session id, the x402 requirements and every next-call value in the text alone", async () => {
    const { app, lines } = setup();
    const payer = generatePrivateKeyToAccountPair();
    const texts: string[] = [];
    const headers: string[] = [];
    const read = (out: ToolOut) => {
      expect(out.isError, out.content[0]?.text).toBeUndefined();
      const text = out.content[0]!.text;
      texts.push(text);
      const data = parseAgentData(text);
      expect(data, text.slice(-300)).not.toBeNull();
      return data as Record<string, any>;
    };
    // Signs from the text's requirements only, as pay_x402 would.
    const payFromText = async (data: Record<string, any>) => {
      const accept = data.payment.accepts[0];
      const signed = await signExactEvm(payer, { to: accept.payTo, value: Number(accept.amount), version: 2, network: accept.network, resource: data.payment.resourceUrl });
      headers.push(signed.value);
      return signed.value;
    };

    const start = await tool(app, "haggle_start", {});
    const opened = read(start);
    const id = opened.sessionId as string;
    expect(id).toBe(start.structuredContent!.sessionId);
    expect(opened).toMatchObject({ phase: "opened", status: "open", round: 0, askUsd: "$1.80", patience: 100, mood: "calm" });
    expect(opened.nextStep).toContain("haggle_offer");

    let data = opened;
    let offerUsd = "1.40";
    for (let i = 0; i < 8 && data.status === "open"; i += 1) {
      const quote = await tool(app, "haggle_offer", { sessionId: data.sessionId, offerUsd });
      const q = read(quote);
      expect(q.phase).toBe("payment_required");
      expect(q.payment.accepts).toEqual(quote.structuredContent!.payment.accepts);
      expect(q.payment.resource).toEqual(quote.structuredContent!.payment.resource);
      expect(q.payment).toMatchObject({ x402Version: 2, resourceUrl: `http://merchant.test/offer?session=${id}&round=${q.round + 1}`, amountUsd: "$0.01" });
      expect(q).toMatchObject({ offerUsd, paysForRound: q.round + 1 });
      expect(q.useService).toEqual({ url: `http://merchant.test/mcp-pay/offer/${id}?round=${q.round + 1}&offerUsd=${offerUsd}`, method: "POST" });
      expect(q.instruction).toContain("use_service");
      expect(q.fallback).toContain("pay_x402");
      expect(q.fallback).toContain(`sessionId "${id}", offerUsd "${offerUsd}"`);
      data = read(await tool(app, "haggle_offer", { sessionId: q.sessionId, offerUsd: q.offerUsd, payment: await payFromText(q) }));
      expect(data.phase).toBe("paid");
      offerUsd = String(data.askUsd).slice(1);
    }
    expect(data.status).toBe("sold");
    expect(data.nextStep).toContain("haggle_checkout");

    const cq = read(await tool(app, "haggle_checkout", { sessionId: id }));
    expect(cq.payment.amountUsd).toBe(cq.finalPriceUsd);
    expect(cq.fallback).toContain(`haggle_checkout again with sessionId "${id}" and payment`);
    const closed = read(await tool(app, "haggle_checkout", { sessionId: cq.sessionId, payment: await payFromText(cq) }));
    expect(closed.checkoutPaid).toBe(true);
    expect(closed.nextStep).toContain("haggle_reveal");

    const revealed = read(await tool(app, "haggle_reveal", { sessionId: id }));
    expect(revealed).toMatchObject({ phase: "revealed", verified: true });
    expect(revealed.salt).toMatch(/^[a-f0-9]{64}$/);
    expect(revealed.floorUsd).toMatch(/^\$\d+\.\d{2}$/);

    for (const text of texts) expect(text).toContain(id);
    // Before the reveal no text carried the floor or the salt.
    for (const text of texts.slice(0, -1)) {
      expect(text).not.toContain(revealed.salt);
      expect(Object.keys(parseAgentData(text)!).filter((k) => /floor|salt/i.test(k))).toEqual([]);
    }
    // No payment header and no merchant key in any text, and no payment header in the logs.
    const all = texts.join("\n");
    expect(all).not.toContain(KEY);
    for (const header of headers) {
      expect(all).not.toContain(header.slice(0, 40));
      expect(lines.join("\n")).not.toContain(header.slice(0, 40));
    }
  });
});
