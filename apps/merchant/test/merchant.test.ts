import { beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKeyToAccountPair, signExactEvm } from "./sign.js";
import { RAILS, verifyReveal } from "@boxhaggle/core";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger, redact } from "../src/log.js";
import { LocalEvmFacilitator } from "../src/x402/facilitator.js";

const KEY = "test-merchant-key-0123456789abcdef0123456789";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const WEB = "http://localhost:5173";

function setup(extra: Record<string, string> = {}) {
  const lines: string[] = [];
  const config = loadConfig({
    NODE_ENV: "test",
    MERCHANT_API_KEY: KEY,
    PAYTO_BASE: PAY_TO,
    X402_NETWORKS: "base",
    FACILITATOR_MODE: "local",
    WEB_ORIGIN: WEB,
    PUBLIC_BASE_URL: "http://merchant.test",
    ...extra,
  });
  const log = createLogger("debug", (line) => lines.push(line));
  const { app } = createApp({ config, facilitator: new LocalEvmFacilitator(), log });
  return { app, config, lines };
}

type App = ReturnType<typeof setup>["app"];

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

async function openSession(app: App, channel: "sdk" | "plugin" = "sdk") {
  const res = await app.request("/session", json({ itemId: "brass-compass", channel }, { "x-merchant-key": KEY }));
  expect(res.status).toBe(201);
  return (await res.json()) as { sessionId: string; commitment: string; listPrice: number; offerFee: number; ask: number };
}

const decode = (header: string | null) => JSON.parse(Buffer.from(header ?? "", "base64").toString("utf8"));

describe("merchant: sessions and auth", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("requires the merchant key to open a session", async () => {
    const res = await ctx.app.request("/session", json({ itemId: "brass-compass" }));
    expect(res.status).toBe(401);
  });

  it("rejects unknown fields", async () => {
    const res = await ctx.app.request("/session", json({ itemId: "brass-compass", floor: 1 }, { "x-merchant-key": KEY }));
    expect(res.status).toBe(400);
    const s = await openSession(ctx.app);
    const offer = await ctx.app.request("/offer", json({ sessionId: s.sessionId, amount: "1000000", round: 9 }, { "x-merchant-key": KEY }));
    expect(offer.status).toBe(400);
  });

  it("never returns the floor or salt before the session ends", async () => {
    const res = await ctx.app.request("/session", json({ itemId: "tin-robot" }, { "x-merchant-key": KEY }));
    const text = await res.text();
    expect(text).not.toMatch(/floor|salt/i);
    const s = JSON.parse(text) as { sessionId: string };
    const reveal = await ctx.app.request(`/reveal/${s.sessionId}`);
    expect(reveal.status).toBe(409);
    const view = await (await ctx.app.request(`/session/${s.sessionId}`)).text();
    expect(view).not.toMatch(/floor|salt/i);
  });

  it("rejects an offer without the merchant key on an sdk session", async () => {
    const s = await openSession(ctx.app);
    const res = await ctx.app.request("/offer", json({ sessionId: s.sessionId, amount: "1000000" }));
    expect(res.status).toBe(401);
  });

  it("plugin sessions are payment-gated instead of key-gated on paid routes", async () => {
    const s = await openSession(ctx.app, "plugin");
    const res = await ctx.app.request("/offer", json({ sessionId: s.sessionId, amount: "1000000" }));
    expect(res.status).toBe(402);
  });
});

describe("merchant: x402 verification", () => {
  let ctx: ReturnType<typeof setup>;
  const payer = generatePrivateKeyToAccountPair();
  beforeEach(() => {
    ctx = setup();
  });

  const offerReq = (sessionId: string, amount: string, payment?: { name: string; value: string }) =>
    ctx.app.request(
      "/offer",
      json({ sessionId, amount }, { "x-merchant-key": KEY, ...(payment ? { [payment.name]: payment.value } : {}) }),
    );

  it("answers an unpaid offer with v1 body and v2 PAYMENT-REQUIRED bound to session and round", async () => {
    const s = await openSession(ctx.app);
    const res = await offerReq(s.sessionId, "1000000");
    expect(res.status).toBe(402);
    const body = (await res.json()) as { x402Version: number; accepts: Array<Record<string, unknown>> };
    expect(body.x402Version).toBe(1);
    expect(body.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "base",
      maxAmountRequired: String(s.offerFee),
      payTo: PAY_TO,
      asset: RAILS.base.usdc,
    });
    expect(String(body.accepts[0]?.resource)).toContain(`session=${s.sessionId}`);
    expect(String(body.accepts[0]?.resource)).toContain("round=1");
    const v2 = decode(res.headers.get("PAYMENT-REQUIRED"));
    expect(v2.x402Version).toBe(2);
    expect(v2.accepts[0]).toMatchObject({ network: "eip155:8453", amount: String(s.offerFee) });
    expect(v2.resource.url).toBe(body.accepts[0]?.resource);
  });

  it("accepts a valid payment, applies the offer and returns a settlement header", async () => {
    const s = await openSession(ctx.app);
    const pay = await signExactEvm(payer, { to: PAY_TO, value: s.offerFee, version: 1 });
    const res = await offerReq(s.sessionId, "1500000", pay);
    expect(res.status).toBe(200);
    const reply = (await res.json()) as { round: number; ask: number; status: string; payment: { txRef: string } };
    expect(reply.round).toBe(1);
    expect(reply.ask).toBeLessThan(s.listPrice);
    expect(reply.payment.txRef).toMatch(/^local_/);
    expect(decode(res.headers.get("X-PAYMENT-RESPONSE")).success).toBe(true);
  });

  it("rejects a replayed payment", async () => {
    const s = await openSession(ctx.app);
    const pay = await signExactEvm(payer, { to: PAY_TO, value: s.offerFee, version: 1 });
    expect((await offerReq(s.sessionId, "1500000", pay)).status).toBe(200);
    const again = await offerReq(s.sessionId, "1500000", pay);
    expect(again.status).toBe(402);
    expect(((await again.json()) as { error: string }).error).toBe("payment_replayed");
  });

  it("rejects the same authorization re-encoded in a different header version", async () => {
    const s = await openSession(ctx.app);
    const pay = await signExactEvm(payer, { to: PAY_TO, value: s.offerFee, version: 1 });
    expect((await offerReq(s.sessionId, "1500000", pay)).status).toBe(200);
    const inner = decode(pay.value);
    const v2 = {
      name: "PAYMENT-SIGNATURE",
      value: Buffer.from(
        JSON.stringify({
          x402Version: 2,
          resource: { url: `http://merchant.test/offer?session=${s.sessionId}&round=2` },
          accepted: { scheme: "exact", network: "eip155:8453", amount: String(s.offerFee), asset: RAILS.base.usdc, payTo: PAY_TO },
          payload: inner.payload,
        }),
      ).toString("base64"),
    };
    const again = await offerReq(s.sessionId, "1500000", v2);
    expect(((await again.json()) as { error: string }).error).toBe("payment_replayed");
  });

  it("rejects the wrong amount", async () => {
    const s = await openSession(ctx.app);
    const pay = await signExactEvm(payer, { to: PAY_TO, value: s.offerFee - 1, version: 1 });
    const res = await offerReq(s.sessionId, "1500000", pay);
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toBe("wrong_amount");
  });

  it("rejects the wrong network", async () => {
    const s = await openSession(ctx.app);
    const pay = await signExactEvm(payer, { to: PAY_TO, value: s.offerFee, version: 1, network: "polygon" });
    const res = await offerReq(s.sessionId, "1500000", pay);
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_network_or_scheme");
  });

  it("rejects the wrong payTo", async () => {
    const s = await openSession(ctx.app);
    const pay = await signExactEvm(payer, { to: "0x2222222222222222222222222222222222222222", value: s.offerFee, version: 1 });
    const res = await offerReq(s.sessionId, "1500000", pay);
    expect(((await res.json()) as { error: string }).error).toBe("wrong_pay_to");
  });

  it("rejects a forged signature", async () => {
    const s = await openSession(ctx.app);
    const pay = await signExactEvm(payer, { to: PAY_TO, value: s.offerFee, version: 1, forgeFrom: "0x3333333333333333333333333333333333333333" });
    const res = await offerReq(s.sessionId, "1500000", pay);
    expect(((await res.json()) as { error: string }).error).toBe("payment_invalid:invalid_signature");
  });

  it("rejects an expired authorization", async () => {
    const s = await openSession(ctx.app);
    const pay = await signExactEvm(payer, { to: PAY_TO, value: s.offerFee, version: 1, validForSeconds: -10 });
    const res = await offerReq(s.sessionId, "1500000", pay);
    expect(((await res.json()) as { error: string }).error).toBe("authorization_expired");
  });

  it("rejects malformed payment headers", async () => {
    const s = await openSession(ctx.app);
    const res = await offerReq(s.sessionId, "1500000", { name: "X-PAYMENT", value: "not-json!!" });
    expect(((await res.json()) as { error: string }).error).toBe("malformed_payment");
  });

  it("v2: binds the payment to the resource issued for this session and round", async () => {
    const s = await openSession(ctx.app);
    const wrong = await signExactEvm(payer, { to: PAY_TO, value: s.offerFee, version: 2, resource: "http://merchant.test/offer?session=x&round=1" });
    const bad = await offerReq(s.sessionId, "1500000", wrong);
    expect(((await bad.json()) as { error: string }).error).toBe("resource_mismatch");
    const right = await signExactEvm(payer, {
      to: PAY_TO,
      value: s.offerFee,
      version: 2,
      resource: `http://merchant.test/offer?session=${s.sessionId}&round=1`,
    });
    const ok = await offerReq(s.sessionId, "1500000", right);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
  });

  it("rejects a stale round in the resource query", async () => {
    const s = await openSession(ctx.app);
    const res = await ctx.app.request(
      `/offer?session=${s.sessionId}&round=7`,
      json({ sessionId: s.sessionId, amount: "1500000" }, { "x-merchant-key": KEY }),
    );
    expect(res.status).toBe(409);
  });

  it("checkout charges the exact agreed price once, then reveal verifies", async () => {
    const s = await openSession(ctx.app);
    const early = await ctx.app.request("/checkout", json({ sessionId: s.sessionId }, { "x-merchant-key": KEY }));
    expect(early.status).toBe(409);

    const deal = await offerReq(s.sessionId, String(s.listPrice), await signExactEvm(payer, { to: PAY_TO, value: s.offerFee, version: 1 }));
    const dealBody = (await deal.json()) as { status: string; finalPrice: number };
    expect(dealBody.status).toBe("sold");

    const quote = await ctx.app.request("/checkout", json({ sessionId: s.sessionId }, { "x-merchant-key": KEY }));
    expect(quote.status).toBe(402);
    const accepts = ((await quote.json()) as { accepts: Array<{ maxAmountRequired: string }> }).accepts;
    expect(accepts[0]?.maxAmountRequired).toBe(String(dealBody.finalPrice));

    const underpay = await signExactEvm(payer, { to: PAY_TO, value: s.offerFee, version: 1 });
    const under = await ctx.app.request("/checkout", json({ sessionId: s.sessionId }, { "x-merchant-key": KEY, [underpay.name]: underpay.value }));
    expect(((await under.json()) as { error: string }).error).toBe("wrong_amount");

    const pay = await signExactEvm(payer, { to: PAY_TO, value: dealBody.finalPrice, version: 1 });
    const paid = await ctx.app.request("/checkout", json({ sessionId: s.sessionId }, { "x-merchant-key": KEY, [pay.name]: pay.value }));
    expect(paid.status).toBe(200);
    const twice = await ctx.app.request("/checkout", json({ sessionId: s.sessionId }, { "x-merchant-key": KEY }));
    expect(twice.status).toBe(409);

    const reveal = (await (await ctx.app.request(`/reveal/${s.sessionId}`)).json()) as { floor: number; salt: string; commitment: string; verified: boolean };
    expect(reveal.commitment).toBe(s.commitment);
    expect(reveal.verified).toBe(true);
    expect(verifyReveal(s.commitment, reveal.floor, reveal.salt).verified).toBe(true);
  });

  it("refuses offers after the session is closed", async () => {
    const s = await openSession(ctx.app);
    await offerReq(s.sessionId, String(s.listPrice), await signExactEvm(payer, { to: PAY_TO, value: s.offerFee, version: 1 }));
    const res = await offerReq(s.sessionId, "100000");
    expect(res.status).toBe(409);
  });

  it("never logs the merchant key or payment headers", async () => {
    const s = await openSession(ctx.app);
    const pay = await signExactEvm(payer, { to: PAY_TO, value: s.offerFee, version: 1 });
    await offerReq(s.sessionId, "1500000", pay);
    await offerReq(s.sessionId, "1500000", pay);
    const all = ctx.lines.join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(pay.value.slice(0, 40));
    expect(all).not.toContain(decode(pay.value).payload.signature);
  });
});

describe("merchant: plugin session ownership", () => {
  it("binds a plugin session to its first payer and refuses strangers before settlement", async () => {
    const { app } = setup();
    const owner = generatePrivateKeyToAccountPair();
    const stranger = generatePrivateKeyToAccountPair();
    const s = await openSession(app, "plugin");
    const offer = (pay: { name: string; value: string }) =>
      app.request("/offer", json({ sessionId: s.sessionId, amount: "1500000" }, { [pay.name]: pay.value }));
    expect((await offer(await signExactEvm(owner, { to: PAY_TO, value: s.offerFee, version: 1 }))).status).toBe(200);
    const grief = await offer(await signExactEvm(stranger, { to: PAY_TO, value: s.offerFee, version: 1 }));
    expect(((await grief.json()) as { error: string }).error).toBe("payer_not_session_owner");
    expect((await offer(await signExactEvm(owner, { to: PAY_TO, value: s.offerFee, version: 1 }))).status).toBe(200);
  });

  it("never announces plugin session ids in the lobby", async () => {
    const created = setup();
    const plugin = await openSession(created.app, "plugin");
    const sdk = await openSession(created.app, "sdk");
    const res = await created.app.request("/lobby");
    const reader = res.body!.getReader();
    const text = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toContain(sdk.sessionId);
    expect(text).not.toContain(plugin.sessionId);
  });
});

describe("merchant: relay, streams, headers", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("relay requires the key and refuses forged merchant events", async () => {
    const s = await openSession(ctx.app);
    const ok = { events: [{ t: "paybox.call", at: Date.now(), tool: "list_credentials" }] };
    expect((await ctx.app.request(`/relay/${s.sessionId}`, json(ok))).status).toBe(401);
    const forged = { events: [{ t: "broker.reply", at: Date.now(), round: 1, offer: 1, previousAsk: 1, ask: 1, patience: 1, mood: "sold", status: "sold", line: "x" }] };
    expect((await ctx.app.request(`/relay/${s.sessionId}`, json(forged, { "x-merchant-key": KEY }))).status).toBe(400);
    const accepted = await ctx.app.request(`/relay/${s.sessionId}`, json(ok, { "x-merchant-key": KEY }));
    expect(accepted.status).toBe(200);
  });

  it("streams history over SSE", async () => {
    const s = await openSession(ctx.app);
    const res = await ctx.app.request(`/events/${s.sessionId}`, { headers: { origin: WEB } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("access-control-allow-origin")).toBe(WEB);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("event: haggle");
    expect(chunk).toContain("session.opened");
  });

  it("serves a session's public events as JSON, without floor or salt before reveal", async () => {
    const s = await openSession(ctx.app);
    const res = await ctx.app.request(`/session/${s.sessionId}/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; events: Array<{ t: string }> };
    expect(body.sessionId).toBe(s.sessionId);
    expect(body.events[0]?.t).toBe("session.opened");
    expect(JSON.stringify(body)).not.toMatch(/"floor"|"salt"/);
    expect((await ctx.app.request(`/session/${"0".repeat(32)}/events`)).status).toBe(404);
  });

  it("locks CORS to the web origin", async () => {
    const good = await ctx.app.request("/healthz", { headers: { origin: WEB } });
    expect(good.headers.get("access-control-allow-origin")).toBe(WEB);
    const evil = await ctx.app.request("/healthz", { headers: { origin: "https://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("sends security headers", async () => {
    const res = await ctx.app.request("/healthz");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-frame-options")).toBeTruthy();
  });

  it("rejects oversized bodies", async () => {
    const res = await ctx.app.request("/session", json({ itemId: "a".repeat(20_000) }, { "x-merchant-key": KEY }));
    expect(res.status).toBe(413);
  });
});

describe("merchant: client IP behind the local cloudflared", () => {
  // The node server puts the socket on the env; app.request takes it as the third argument.
  const from = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress, remotePort: 50000, remoteFamily: "IPv4" } } });
  const sessionFrom = (app: App, peer: string, cfIp: string) =>
    app.request("/session", json({ itemId: "brass-compass" }, { "x-merchant-key": KEY, "cf-connecting-ip": cfIp }), from(peer));
  const limit = 12; // LIMITS.sessionPerIp

  it("keys the limit on CF-Connecting-IP when the peer is the local cloudflared", async () => {
    const { app } = setup({ TRUST_CF_CONNECTING_IP: "1" });
    for (let i = 0; i < limit; i += 1) expect((await sessionFrom(app, "127.0.0.1", "198.51.100.1")).status).toBe(201);
    expect((await sessionFrom(app, "127.0.0.1", "198.51.100.1")).status).toBe(429);
    // A different real client behind the same tunnel keeps its own budget.
    expect((await sessionFrom(app, "127.0.0.1", "198.51.100.2")).status).toBe(201);
    expect((await sessionFrom(app, "::ffff:127.0.0.1", "198.51.100.3")).status).toBe(201);
  });

  it("ignores a spoofed CF-Connecting-IP from a non-loopback peer", async () => {
    const { app } = setup({ TRUST_CF_CONNECTING_IP: "1" });
    for (let i = 0; i < limit; i += 1) expect((await sessionFrom(app, "203.0.113.7", `198.51.100.${i + 10}`)).status).toBe(201);
    // Rotating the header does not buy a fresh budget: the key is the socket address.
    expect((await sessionFrom(app, "203.0.113.7", "198.51.100.99")).status).toBe(429);
  });

  it("ignores the header entirely when the flag is off, and a malformed one when it is on", async () => {
    const off = setup();
    for (let i = 0; i < limit; i += 1) expect((await sessionFrom(off.app, "127.0.0.1", `198.51.100.${i + 10}`)).status).toBe(201);
    expect((await sessionFrom(off.app, "127.0.0.1", "198.51.100.99")).status).toBe(429);

    const on = setup({ TRUST_CF_CONNECTING_IP: "1" });
    for (let i = 0; i < limit; i += 1) expect((await sessionFrom(on.app, "127.0.0.1", `not-an-ip-${i}`)).status).toBe(201);
    expect((await sessionFrom(on.app, "127.0.0.1", "not-an-ip-x")).status).toBe(429);
  });
});

describe("merchant: config and redaction", () => {
  it("binds to loopback by default and refuses ambiguous proxy trust", () => {
    expect(loadConfig({ MERCHANT_API_KEY: KEY, PAYTO_BASE: PAY_TO }).host).toBe("127.0.0.1");
    expect(() => loadConfig({ MERCHANT_API_KEY: KEY, PAYTO_BASE: PAY_TO, TRUST_PROXY: "1", TRUST_CF_CONNECTING_IP: "1" })).toThrow(/only one/);
  });

  it("refuses a non-https web origin in production", () => {
    const prod = { NODE_ENV: "production", MERCHANT_API_KEY: KEY, PAYTO_BASE: PAY_TO, X402_NETWORKS: "base", PUBLIC_BASE_URL: "https://api.example" };
    expect(() => loadConfig({ ...prod, WEB_ORIGIN: "http://web.example" })).toThrow(/WEB_ORIGIN must be https/);
    expect(loadConfig({ ...prod, WEB_ORIGIN: "https://web.example" }).webOrigins).toEqual(["https://web.example"]);
  });

  it("refuses the local facilitator in production", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", MERCHANT_API_KEY: KEY, PAYTO_BASE: PAY_TO, X402_NETWORKS: "base", FACILITATOR_MODE: "local", PUBLIC_BASE_URL: "https://x.example" }),
    ).toThrow(/refused in production/);
  });

  it("refuses a short merchant key and an unpayable rail set", () => {
    expect(() => loadConfig({ MERCHANT_API_KEY: "short", PAYTO_BASE: PAY_TO })).toThrow();
    expect(() => loadConfig({ MERCHANT_API_KEY: KEY, X402_NETWORKS: "solana" })).toThrow(/no payable rail/);
  });

  it("redacts sensitive keys and truncates long values", () => {
    const out = redact({ apiKey: "abc", xPayment: "zzz", nested: { cardNumber: "4242" }, long: "x".repeat(500), ok: "fine" }) as Record<string, unknown>;
    expect(out.apiKey).toBe("[redacted]");
    expect(out.xPayment).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).cardNumber).toBe("[redacted]");
    expect(String(out.long).length).toBeLessThan(40);
    expect(out.ok).toBe("fine");
  });

  it("draws a fresh salt and commitment per session", async () => {
    const { app } = setup();
    const commitments = new Set<string>();
    for (let i = 0; i < 8; i += 1) commitments.add((await openSession(app)).commitment);
    expect(commitments.size).toBe(8);
  });
});
