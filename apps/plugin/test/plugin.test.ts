import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";
import { FRAME_DISPLAY_NOTE, FRAME_WIDTH, ITEMS, RAILS, displayWidth, parseAgentData } from "@boxhaggle/core";
import { createApp } from "../../merchant/src/app.js";
import { loadConfig } from "../../merchant/src/config.js";
import { createLogger } from "../../merchant/src/log.js";
import type { Facilitator } from "../../merchant/src/x402/facilitator.js";
import { LocalEvmFacilitator } from "../../merchant/src/x402/facilitator.js";
import { generatePrivateKeyToAccountPair, signExactEvm } from "../../merchant/test/sign.js";
import { listItems, openSession, proposeCheckout, proposeOffer, reveal, status, toolError, type ToolEnv } from "../src/tools.js";

const KEY = "plugin-test-merchant-key-0123456789abcdefg";
const BASE = "https://merchant.test";
const PROPOSAL = "io.paybox/transactionProposal";

function merchant() {
  const config = loadConfig({
    NODE_ENV: "test",
    MERCHANT_API_KEY: KEY,
    PAYTO_SOLANA: "H9737KMkzJ1QWU98HpNh3inrKqBhJqWjvTwtGPrXKLim",
    PAYTO_BASE: "0x1111111111111111111111111111111111111111",
    X402_NETWORKS: "solana,base",
    FACILITATOR_MODE: "local",
    PUBLIC_BASE_URL: BASE,
  });
  // Facilitator stub: only fee payer discovery matters for 402 shape tests.
  const facilitator: Facilitator = {
    mode: "local",
    verify: async () => ({ isValid: false, invalidReason: "stub" }),
    settle: async () => ({ success: false, transaction: "", network: "" }),
    feePayers: async () => ({ solana: "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww" }),
  };
  return createApp({ config, facilitator, log: createLogger("error", () => {}) });
}

/** Simulates PayBox: adds the brokered X-Merchant-Key header for the merchant host only. */
function brokeredFetch(app: ReturnType<typeof merchant>["app"]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    if (url.origin === BASE) headers.set("x-merchant-key", KEY);
    return app.request(url.pathname + url.search, { ...init, headers });
  }) as typeof fetch;
}

describe("plugin tools against the merchant", () => {
  const m = merchant();
  const env: ToolEnv = { merchantUrl: BASE, fetch: brokeredFetch(m.app) };

  it("lists items without any network", () => {
    const out = listItems();
    expect(out.structuredContent.items).toHaveLength(4);
    expect(JSON.stringify(out)).not.toMatch(/floorMin|floorMax|"floor"/);
  });

  it("opens a plugin session through the brokered header and reports status", async () => {
    const opened = await openSession(env, { itemId: "tin-robot" });
    expect(opened.structuredContent.status).toBe("open");
    expect(opened.structuredContent.commitment).toMatch(/^[a-f0-9]{64}$/);
    const read = await status(env, { sessionId: opened.structuredContent.sessionId });
    expect(read.structuredContent.askUsd).toBe("$2.40");
  });

  it("fails without the brokered key (PayBox not configured)", async () => {
    const bare: ToolEnv = { merchantUrl: BASE, fetch: ((i: RequestInfo | URL, init?: RequestInit) => m.app.request(String(i).replace(BASE, ""), init)) as typeof fetch };
    const out = await openSession(bare, { itemId: "tin-robot" }).catch(toolError);
    expect("isError" in out && out.isError).toBe(true);
  });

  it("each offer proposal matches the live 402 PayBox will fetch (asset and amount)", async () => {
    const { structuredContent: s } = await openSession(env, { itemId: "brass-compass" });
    for (const chain of ["solana:mainnet", "eip155:8453"] as const) {
      const out = await proposeOffer(env, { sessionId: s.sessionId, offerUsd: "1.20", chain });
      const proposal = out.structuredContent[PROPOSAL];
      expect(proposal.kind).toBe("x402");
      expect(proposal.request).toEqual({ url: `${BASE}/offer`, method: "POST", body: { sessionId: s.sessionId, amount: "1200000" } });
      // What PayBox does: send the unpaid request and compare the challenge.
      const res = await m.app.request("/offer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(proposal.request.body) });
      expect(res.status).toBe(402);
      const challenge = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString("utf8"));
      const rail = chain === "solana:mainnet" ? RAILS.solana : RAILS.base;
      const accept = challenge.accepts.find((a: { network: string }) => a.network === rail.v2Network);
      expect(accept.asset.toLowerCase()).toBe(proposal.payment.asset.toLowerCase());
      expect(BigInt(accept.amount)).toBeLessThanOrEqual(BigInt(proposal.payment.maxAmount));
      expect(Date.parse(proposal.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
    }
  });

  it("refuses checkout before a deal and validates input", async () => {
    const { structuredContent: s } = await openSession(env, { itemId: "box-camera" });
    const out = await proposeCheckout(env, { sessionId: s.sessionId, chain: "solana:mainnet" }).catch(toolError);
    expect("isError" in out && out.isError).toBe(true);
    const tooBig = await proposeOffer(env, { sessionId: s.sessionId, offerUsd: "99999", chain: "solana:mainnet" }).catch(toolError);
    expect("isError" in tooBig && tooBig.isError).toBe(true);
  });

  it("reveal refuses while open", async () => {
    const { structuredContent: s } = await openSession(env, { itemId: "rotary-phone" });
    const out = await reveal(env, { sessionId: s.sessionId }).catch(toolError);
    expect("isError" in out && out.isError).toBe(true);
  });

  it("every result opens with an aligned frame and tells the agent to show it as is", async () => {
    const frameOf = (text: string) => {
      const match = /^```text\n([\s\S]*?)\n```\n\n(.+)\n\n/.exec(text);
      expect(match, text.slice(0, 120)).not.toBeNull();
      expect(match![2]).toBe(FRAME_DISPLAY_NOTE);
      const lines = match![1]!.split("\n");
      for (const line of lines) expect(displayWidth(line), line).toBe(FRAME_WIDTH);
      return match![1]!;
    };
    const items = listItems();
    frameOf(items.content[0]!.text);
    expect(items.structuredContent.frame).toBe(`\`\`\`text\n${frameOf(items.content[0]!.text)}\n\`\`\``);

    const opened = await openSession(env, { itemId: "brass-compass" });
    const sessionId = opened.structuredContent.sessionId;
    expect(frameOf(opened.content[0]!.text)).toContain("(－‿－)");
    expect(opened.structuredContent.display).toBe(FRAME_DISPLAY_NOTE);
    expect(opened.structuredContent.frame).not.toMatch(/floor|salt/i);

    const read = await status(env, { sessionId });
    expect(frameOf(read.content[0]!.text)).toContain("ROUND 00");

    const offer = await proposeOffer(env, { sessionId, offerUsd: "1.20", chain: "solana:mainnet" });
    expect(frameOf(offer.content[0]!.text)).toContain(" 01  $1.20     $0.01    awaiting payment");
    expect(Object.keys(offer.structuredContent)).toEqual([PROPOSAL]);
  });

  it("rejects a non-https or decorated merchant URL", async () => {
    for (const merchantUrl of ["http://merchant.test", "https://user:pw@merchant.test", "https://merchant.test/?x=1", undefined]) {
      const out = await status({ merchantUrl, fetch: env.fetch }, { sessionId: "a".repeat(32) }).catch(toolError);
      expect("isError" in out && out.isError).toBe(true);
    }
  });
});

// ---- bundle smoke test (the official conformance runs in CI on Linux, Node 24) ----

const ROOT = resolve(__dirname, "..");
const ARTIFACT = resolve(ROOT, "dist/plugin.mjs");
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "boxhaggle-smoke", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function operation(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [ARTIFACT], { env: { PATH: process.env.PATH ?? "", NODE_ENV: "production" } });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timeout"));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const line = out.split("\n").find((l) => l.includes('"id":2'));
      if (line) {
        clearTimeout(timer);
        child.kill();
        resolvePromise(JSON.parse(line) as Record<string, unknown>);
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method, params: { ...params, _meta: META } })}\n`);
  });
}

describe("plugin bundle", () => {
  beforeAll(() => {
    expect(readFileSync(ARTIFACT).length).toBeGreaterThan(0);
  });

  it("lists six tools whose schemas compile as JSON Schema 2020-12", async () => {
    const res = await operation("tools/list", {});
    const result = res.result as { tools: Array<{ name: string; inputSchema: object; outputSchema?: object }>; resultType: string };
    expect(result.resultType).toBe("complete");
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      "boxhaggle_items",
      "boxhaggle_open_session",
      "boxhaggle_propose_checkout",
      "boxhaggle_propose_offer",
      "boxhaggle_reveal",
      "boxhaggle_status",
    ]);
    const ajv = new Ajv2020({ strict: false, validateFormats: false, logger: false });
    for (const tool of result.tools) {
      expect(JSON.stringify(tool)).not.toContain("x-mcp-header");
      ajv.compile(tool.inputSchema);
      if (tool.outputSchema) ajv.compile(tool.outputSchema);
    }
  });

  it("runs the configured sample call and its output matches the declared schema", async () => {
    const sample = JSON.parse(readFileSync(resolve(ROOT, "paybox-plugin.json"), "utf8")) as { tool: string; arguments: object };
    const list = (await operation("tools/list", {})).result as { tools: Array<{ name: string; outputSchema: object }> };
    const tool = list.tools.find((t) => t.name === sample.tool)!;
    const res = await operation("tools/call", { name: sample.tool, arguments: sample.arguments });
    const result = res.result as { resultType: string; isError?: boolean; structuredContent: unknown };
    expect(result.resultType).toBe("complete");
    expect(result.isError).not.toBe(true);
    const validate = new Ajv2020({ strict: false, validateFormats: false, logger: false }).compile(tool.outputSchema);
    expect(validate(result.structuredContent)).toBe(true);
  });

  it("carries no secrets and stays well under the 10 MiB limit", () => {
    const bytes = readFileSync(ARTIFACT);
    expect(bytes.length).toBeLessThan(10 * 1024 * 1024);
    const text = bytes.toString("utf8");
    expect(text).not.toMatch(/pbx_live_[A-Za-z0-9]|pbxk1\.[A-Za-z0-9]{8}/);
    expect(createHash("sha256").update(bytes).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("plugin text for agents that never see structuredContent", () => {
  it("carries the session id, the state, the proposal and the next step in AGENT DATA on every tool", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      MERCHANT_API_KEY: KEY,
      PAYTO_BASE: "0x1111111111111111111111111111111111111111",
      X402_NETWORKS: "base",
      FACILITATOR_MODE: "local",
      PUBLIC_BASE_URL: BASE,
    });
    const m = createApp({ config, facilitator: new LocalEvmFacilitator(), log: createLogger("error", () => {}) });
    const env: ToolEnv = { merchantUrl: BASE, fetch: brokeredFetch(m.app) };
    const payer = generatePrivateKeyToAccountPair();
    const texts: string[] = [];
    const dataOf = (out: { content: Array<{ text: string }> }) => {
      const text = out.content[0]!.text;
      texts.push(text);
      const data = parseAgentData(text);
      expect(data, text.slice(-300)).not.toBeNull();
      return data as Record<string, any>;
    };
    // PayBox's side of an x402 proposal: send the request, read the live 402, pay, retry.
    const settle = async (proposal: { request: { url: string; body: unknown } }) => {
      const path = new URL(proposal.request.url).pathname;
      const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(proposal.request.body) };
      const challenge = await m.app.request(path, init);
      expect(challenge.status).toBe(402);
      const required = JSON.parse(Buffer.from(challenge.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString("utf8"));
      const accept = required.accepts[0];
      const signed = await signExactEvm(payer, { to: accept.payTo, value: Number(accept.amount), version: 2, network: accept.network, resource: required.resource.url });
      const paid = await m.app.request(path, { ...init, headers: { ...init.headers, [signed.name]: signed.value } });
      expect(paid.status).toBe(200);
    };

    const items = dataOf(listItems());
    expect(items.items.map((i: { itemId: string }) => i.itemId)).toEqual(ITEMS.map((i) => i.id));
    expect(items.nextStep).toContain("boxhaggle_open_session");

    const opened = await openSession(env, { itemId: items.items[0].itemId });
    let state = dataOf(opened);
    expect(state).toMatchObject({ sessionId: opened.structuredContent.sessionId, status: "open", round: 0, askUsd: "$1.80", patience: 100, mood: "calm" });
    expect(state.nextStep).toContain("boxhaggle_propose_offer");

    let offerUsd = "1.40";
    for (let i = 0; i < 8 && state.status === "open"; i += 1) {
      const out = await proposeOffer(env, { sessionId: state.sessionId, offerUsd, chain: "eip155:8453" });
      expect(Object.keys(out.structuredContent)).toEqual([PROPOSAL]);
      const d = dataOf(out);
      expect(d.proposal).toEqual(out.structuredContent[PROPOSAL]);
      expect(d).toMatchObject({ sessionId: state.sessionId, round: state.round, offerUsd, amountUsd: "$0.01" });
      expect(d.nextStep).toContain("boxhaggle_status");
      await settle(d.proposal);
      state = dataOf(await status(env, { sessionId: d.sessionId }));
      offerUsd = String(state.askUsd).slice(1);
    }
    expect(state.status).toBe("sold");
    expect(state.nextStep).toContain("boxhaggle_propose_checkout");

    const checkout = await proposeCheckout(env, { sessionId: state.sessionId, chain: "eip155:8453" });
    expect(Object.keys(checkout.structuredContent)).toEqual([PROPOSAL]);
    const c = dataOf(checkout);
    expect(c.proposal).toEqual(checkout.structuredContent[PROPOSAL]);
    expect(c.amountUsd).toBe(state.finalPriceUsd);
    expect(c.nextStep).toContain("boxhaggle_reveal");
    await settle(c.proposal);

    const revealed = dataOf(await reveal(env, { sessionId: c.sessionId }));
    expect(revealed).toMatchObject({ sessionId: c.sessionId, verifiedByBroker: true, verifiedHere: true });
    expect(revealed.salt).toMatch(/^[a-f0-9]{64}$/);

    for (const text of texts.slice(1)) expect(text).toContain(c.sessionId);
    for (const text of texts.slice(0, -1)) {
      expect(text).not.toContain(revealed.salt);
      expect(Object.keys(parseAgentData(text)!).filter((k) => /floor|salt/i.test(k))).toEqual([]);
    }
    expect(texts.join("\n")).not.toContain(KEY);
  });
});
