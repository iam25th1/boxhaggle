import { describe, expect, it } from "vitest";
import { parseAgentData } from "@boxhaggle/core";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { LocalEvmFacilitator } from "../src/x402/facilitator.js";
import { generatePrivateKeyToAccountPair, signExactEvm } from "./sign.js";

// PayBox use_service (gateway mode) against /mcp-pay: PayBox probes the url
// with no body, reads the 402, signs, and re-fetches the same url with the
// payment header. These tests play PayBox's part with real EIP-3009 signatures
// and the local facilitator.

const KEY = "mcp-pay-test-merchant-key-0123456789abcdef0123";
const PAY_TO = "0x3333333333333333333333333333333333333333";

function setup() {
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
  const { app } = createApp({ config, facilitator: new LocalEvmFacilitator(), log: createLogger("debug", (line) => lines.push(line)) });
  return { app, lines };
}

type App = ReturnType<typeof setup>["app"];
type Account = ReturnType<typeof generatePrivateKeyToAccountPair>;
const socket = { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50000, remoteFamily: "IPv4" } } };
const IP = "203.0.113.40";
let nextId = 1;
const decode = (header: string | null) => JSON.parse(Buffer.from(header ?? "", "base64").toString("utf8"));

async function tool(app: App, name: string, args: Record<string, unknown>) {
  const res = await app.request(
    "/mcp",
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", "cf-connecting-ip": IP },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    },
    socket,
  );
  const text = await res.text();
  const json = res.headers.get("content-type")?.includes("text/event-stream")
    ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join(""))
    : JSON.parse(text);
  const result = json.result as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, any> };
  return { ...result, data: parseAgentData(result.content[0]!.text) as Record<string, any> };
}

/** One request as PayBox sends it: POST, the agent's url, no body unless given. */
function post(app: App, url: string, headers: Record<string, string> = {}, body?: string) {
  return app.request(url, { method: "POST", headers: { "cf-connecting-ip": IP, ...headers }, ...(body === undefined ? {} : { body }) }, socket);
}

/** PayBox's half of use_service: probe, sign what the 402 asks, re-fetch with the header. */
async function sign(app: App, url: string, account: Account, o: { value?: (amount: number) => number; resource?: string; forgeFrom?: string } = {}) {
  const probe = await post(app, url);
  expect(probe.status).toBe(402);
  const v2 = decode(probe.headers.get("payment-required"));
  const accept = v2.accepts[0];
  const amount = Number(accept.amount);
  return signExactEvm(account, { to: accept.payTo, value: o.value ? o.value(amount) : amount, version: 2, network: accept.network, resource: o.resource ?? v2.resource.url, forgeFrom: o.forgeFrom });
}

async function quote(app: App, sessionId: string, offerUsd: string) {
  const q = await tool(app, "haggle_offer", { sessionId, offerUsd });
  expect(q.data.phase).toBe("payment_required");
  return q.data.useService.url as string;
}

describe("mcp-pay: PayBox use_service for MCP sessions", () => {
  it("answers the bodyless probe with the 402 for that session and round, then a paid re-fetch with the reply and state", async () => {
    const { app } = setup();
    const owner = generatePrivateKeyToAccountPair();
    const start = await tool(app, "haggle_start", {});
    const id = start.data.sessionId as string;

    const q = await tool(app, "haggle_offer", { sessionId: id, offerUsd: "1.40" });
    expect(q.data.useService).toEqual({ url: `http://merchant.test/mcp-pay/offer/${id}?round=1&offerUsd=1.40`, method: "POST" });
    expect(q.data.instruction).toContain("use_service");
    expect(q.data.instruction).toContain("haggle_status");
    expect(q.data.nextStep).toContain(q.data.useService.url);
    const url = q.data.useService.url as string;

    const probe = await post(app, url);
    expect(probe.status).toBe(402);
    const v2 = decode(probe.headers.get("payment-required"));
    expect(v2).toMatchObject({ x402Version: 2, error: "payment_required", resource: { url: `http://merchant.test/offer?session=${id}&round=1` } });
    expect(v2.accepts).toEqual(q.data.payment.accepts);
    expect(v2.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:8453", amount: "10000", payTo: PAY_TO });
    expect((await probe.json()).accepts[0]).toMatchObject({ network: "base", maxAmountRequired: "10000" });

    const signed = await sign(app, url, owner);
    const paid = await post(app, url, { [signed.name]: signed.value });
    expect(paid.status).toBe(200);
    expect(paid.headers.get("payment-response")).toBeTruthy();
    const out = await paid.json();
    expect(out.reply).toMatchObject({ sessionId: id, round: 1, offer: 1_400_000, fee: 10_000 });
    expect(typeof out.reply.line).toBe("string");
    expect(out.state).toMatchObject({ sessionId: id, phase: "paid", round: 1, askUsd: expect.stringMatching(/^\$/), budget: { spentUsd: "$0.01" } });
    expect(out.state.nextStep).toContain(`haggle_status with sessionId "${id}"`);
    expect(out.frame.startsWith("```text\n")).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/"floor|"salt/i);

    // haggle_status refreshes the counter and animates the paid round.
    const status = await tool(app, "haggle_status", { sessionId: id });
    expect(status.isError).toBeFalsy();
    expect(status.data).toMatchObject({ sessionId: id, phase: "paid", round: 1, budget: { spentUsd: "$0.01" } });
    const sc = status.structuredContent!;
    const replies = sc.events.filter((e: { t: string; seq: number }) => e.t === "broker.reply" && e.seq > sc.fromSeq);
    expect(replies).toHaveLength(1);
    expect(status.content[0]!.text).toContain(out.reply.line);
    const again = await tool(app, "haggle_status", { sessionId: id });
    expect(again.structuredContent!.fromSeq).toBe(Math.max(...sc.events.map((e: { seq: number }) => e.seq)));
  });

  it("refuses forged, wrong-amount, wrong-session, replayed and second-payer payments without changing the session", async () => {
    const { app, lines } = setup();
    const owner = generatePrivateKeyToAccountPair();
    const stranger = generatePrivateKeyToAccountPair();
    const id = (await tool(app, "haggle_start", {})).data.sessionId as string;
    const other = (await tool(app, "haggle_start", {})).data.sessionId as string;
    const url1 = await quote(app, id, "1.40");
    const otherUrl = await quote(app, other, "1.40");
    const sent: string[] = [];
    const reason = async (res: Response) => {
      expect(res.status).toBe(402);
      return decode(res.headers.get("payment-required")).error as string;
    };
    const send = async (url: string, signed: { name: string; value: string }) => {
      sent.push(signed.value);
      return post(app, url, { [signed.name]: signed.value });
    };

    expect(await reason(await send(url1, await sign(app, url1, owner, { value: (a) => a - 1 })))).toBe("accepted_requirements_mismatch");
    expect(await reason(await send(url1, await sign(app, url1, stranger, { forgeFrom: owner.address })))).toMatch(/^payment_invalid:/);
    expect(await reason(await send(otherUrl, await sign(app, url1, owner)))).toBe("resource_mismatch");
    expect((await tool(app, "haggle_status", { sessionId: id })).data).toMatchObject({ round: 0, budget: { spentUsd: "$0.00" } });

    const good = await sign(app, url1, owner);
    expect((await send(url1, good)).status).toBe(200);
    expect((await send(url1, good)).status).toBe(409); // the same request again: that round is gone
    const url2 = await quote(app, id, "1.50");
    expect(await reason(await send(url2, good))).toBe("resource_mismatch");
    const strangers = await sign(app, url2, stranger);
    expect(await reason(await send(url2, strangers))).toBe("payer_not_session_owner");
    expect(await reason(await send(url2, strangers))).toBe("payment_replayed");

    expect((await tool(app, "haggle_status", { sessionId: id })).data).toMatchObject({ round: 1, budget: { spentUsd: "$0.01" } });
    expect((await tool(app, "haggle_status", { sessionId: other })).data).toMatchObject({ round: 0 });
    for (const line of lines) {
      for (const value of sent) expect(line).not.toContain(value.slice(0, 48));
      expect(line).not.toContain(KEY);
    }
  });

  it("takes MCP sessions only and refuses malformed requests", async () => {
    const { app } = setup();
    const owner = generatePrivateKeyToAccountPair();
    for (const channel of ["sdk", "plugin"]) {
      const res = await app.request("/session", { method: "POST", headers: { "content-type": "application/json", "x-merchant-key": KEY, "cf-connecting-ip": IP }, body: JSON.stringify({ itemId: "tin-robot", channel }) }, socket);
      expect(res.status).toBe(201);
      const sid = (await res.json()).sessionId as string;
      const url = `http://merchant.test/mcp-pay/offer/${sid}?round=1&offerUsd=1.00`;
      const probe = await post(app, url);
      expect(probe.status).toBe(404);
      expect((await probe.json()).error).toBe("unknown_session");
      const signed = await signExactEvm(owner, { to: PAY_TO, value: 10_000, version: 2, resource: `http://merchant.test/offer?session=${sid}&round=1` });
      expect((await post(app, url, { [signed.name]: signed.value })).status).toBe(404);
      expect((await post(app, url, { "x-merchant-key": KEY })).status).toBe(404);
    }
    expect((await post(app, `http://merchant.test/mcp-pay/offer/${"a".repeat(32)}?round=1&offerUsd=1.00`)).status).toBe(404);

    const id = (await tool(app, "haggle_start", {})).data.sessionId as string;
    const base = `http://merchant.test/mcp-pay/offer/${id}`;
    for (const bad of [`${base}?round=1&offerUsd=1.00&note=hi`, `${base}?round=1`, `${base}?round=1&round=1&offerUsd=1.00`, `${base}?round=0&offerUsd=1.00`, `${base}?round=1&offerUsd=abc`, `http://merchant.test/mcp-pay/offer/XYZ?round=1&offerUsd=1.00`]) {
      expect((await post(app, bad)).status, bad).toBe(400);
    }
    const withBody = await post(app, `${base}?round=1&offerUsd=1.00`, { "content-type": "application/json" }, JSON.stringify({ amount: "1" }));
    expect(withBody.status).toBe(400);
    expect((await withBody.json()).error).toBe("unexpected_body");
    expect((await post(app, `${base}?round=1&offerUsd=1.00`, { "content-type": "application/json" }, "{}")).status).toBe(402);
    expect((await (await post(app, `${base}?round=1&offerUsd=0.00`)).json()).error).toBe("offer_too_low");
    expect((await post(app, `${base}?round=2&offerUsd=1.00`)).status).toBe(409);
    expect((await post(app, `http://merchant.test/mcp-pay/checkout/${id}?round=0`)).status).toBe(409);
    expect((await app.request(`${base}?round=1&offerUsd=1.00`, { method: "GET", headers: { "cf-connecting-ip": IP } }, socket)).status).toBe(404);
  });

  it("closes a deal and pays checkout through use_service, and holds the spend cap", async () => {
    const { app } = setup();
    const owner = generatePrivateKeyToAccountPair();
    const id = (await tool(app, "haggle_start", {})).data.sessionId as string;
    let state: Record<string, any> = { status: "open", askUsd: "$1.80" };
    for (let i = 0; i < 8 && state.status === "open"; i += 1) {
      const url = await quote(app, id, String(state.askUsd).slice(1));
      const signed = await sign(app, url, owner);
      const res = await post(app, url, { [signed.name]: signed.value });
      expect(res.status).toBe(200);
      state = (await res.json()).state;
    }
    expect(state.status).toBe("sold");
    expect(state.nextStep).toContain("haggle_checkout");

    const cq = await tool(app, "haggle_checkout", { sessionId: id });
    expect(cq.data.useService).toEqual({ url: `http://merchant.test/mcp-pay/checkout/${id}?round=${state.round}`, method: "POST" });
    const url = cq.data.useService.url as string;
    const probe = await post(app, url);
    expect(decode(probe.headers.get("payment-required")).accepts[0].amount).toBe(String(Math.round(Number(String(state.finalPriceUsd).slice(1)) * 1_000_000)));
    const signed = await sign(app, url, owner);
    const paid = await post(app, url, { [signed.name]: signed.value });
    expect(paid.status).toBe(200);
    const out = await paid.json();
    expect(out.reply.receiptId).toMatch(/^BH-/);
    expect(out.state).toMatchObject({ phase: "closed", checkoutPaid: true });
    expect(out.state.nextStep).toContain("haggle_reveal");
    expect((await post(app, url, { [signed.name]: signed.value })).status).toBe(409);
    const status = await tool(app, "haggle_status", { sessionId: id });
    expect(status.data).toMatchObject({ phase: "closed", checkoutPaid: true });
    expect(status.data.nextStep).toContain("haggle_reveal");

    const capped = (await tool(app, "haggle_start", { budgetUsd: "0.01" })).data.sessionId as string;
    const first = await quote(app, capped, "1.00");
    const pay = await sign(app, first, owner);
    expect((await post(app, first, { [pay.name]: pay.value })).status).toBe(200);
    const over = await post(app, `http://merchant.test/mcp-pay/offer/${capped}?round=2&offerUsd=1.10`);
    expect(over.status).toBe(409);
    expect((await over.json()).error).toBe("budget_exceeded");
  });
});
