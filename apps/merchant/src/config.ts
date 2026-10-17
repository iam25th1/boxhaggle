import * as z from "zod";
import type { RailId } from "@boxhaggle/core";

// All configuration comes from environment variables. Secrets are never logged.

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Bind address. Loopback by default: when self-hosted the only public path is the local cloudflared. */
  HOST: z.string().min(1).default("127.0.0.1"),
  /** Public https origin of this service, used for x402 resource URLs. */
  PUBLIC_BASE_URL: z.url().default("http://localhost:8787"),
  /** Exact origin of the spectator web app (CORS allowlist). */
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  /** Merchant API key. The agent gets it from PayBox request_secret; the plugin gets it as a brokered header. */
  MERCHANT_API_KEY: z.string().min(32, "MERCHANT_API_KEY must be at least 32 characters"),
  /** Comma-separated rails, in preference order. */
  X402_NETWORKS: z.string().default("solana,base"),
  PAYTO_SOLANA: z.string().optional(),
  PAYTO_BASE: z.string().optional(),
  /** "http" uses a real x402 facilitator. "local" verifies EVM signatures in-process and never settles on chain (dev and tests only). */
  FACILITATOR_MODE: z.enum(["http", "local"]).default("http"),
  X402_FACILITATOR_URL: z.url().default("https://facilitator.payai.network"),
  /** Optional bearer for facilitators that need one. */
  X402_FACILITATOR_TOKEN: z.string().optional(),
  OFFER_FEE_ATOMIC: z.coerce.number().int().min(1).max(1_000_000).default(10_000),
  SESSION_TTL_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(60),
  PAYMENT_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  /** Set to 1 behind a trusted reverse proxy (Railway) so X-Forwarded-For is used for rate limits. */
  TRUST_PROXY: z.enum(["0", "1"]).default("0"),
  /** Set to 1 behind a local cloudflared so CF-Connecting-IP is used for rate limits, from loopback peers only. */
  TRUST_CF_CONNECTING_IP: z.enum(["0", "1"]).default("0"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface Config {
  env: "development" | "test" | "production";
  port: number;
  host: string;
  publicBaseUrl: string;
  webOrigins: string[];
  merchantApiKey: string;
  rails: RailId[];
  payTo: Partial<Record<RailId, string>>;
  facilitatorMode: "http" | "local";
  facilitatorUrl: string;
  facilitatorToken: string | undefined;
  offerFee: number;
  sessionTtlMs: number;
  paymentTimeoutSeconds: number;
  trustProxy: boolean;
  trustCfConnectingIp: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
}

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`invalid merchant configuration: ${fields}`);
  }
  const e = parsed.data;

  const rails = e.X402_NETWORKS.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const rail of rails) {
    if (rail !== "solana" && rail !== "base") throw new Error(`unknown rail in X402_NETWORKS: ${rail}`);
  }
  const payTo: Partial<Record<RailId, string>> = {};
  if (e.PAYTO_SOLANA) {
    if (!SOLANA_ADDRESS.test(e.PAYTO_SOLANA)) throw new Error("PAYTO_SOLANA is not a base58 Solana address");
    payTo.solana = e.PAYTO_SOLANA;
  }
  if (e.PAYTO_BASE) {
    if (!EVM_ADDRESS.test(e.PAYTO_BASE)) throw new Error("PAYTO_BASE is not a 0x address");
    payTo.base = e.PAYTO_BASE;
  }
  const active = (rails as RailId[]).filter((rail) => payTo[rail]);
  if (active.length === 0) throw new Error("no payable rail: set PAYTO_SOLANA and/or PAYTO_BASE for a rail in X402_NETWORKS");

  const webOrigins = e.WEB_ORIGIN.split(",").map((value) => value.trim().replace(/\/+$/, "")).filter(Boolean);
  if (e.TRUST_PROXY === "1" && e.TRUST_CF_CONNECTING_IP === "1") {
    throw new Error("set only one of TRUST_PROXY and TRUST_CF_CONNECTING_IP");
  }
  if (e.NODE_ENV === "production") {
    if (e.FACILITATOR_MODE !== "http") throw new Error("FACILITATOR_MODE=local is refused in production");
    if (!e.PUBLIC_BASE_URL.startsWith("https://")) throw new Error("PUBLIC_BASE_URL must be https in production");
    if (webOrigins.some((origin) => !origin.startsWith("https://"))) throw new Error("WEB_ORIGIN must be https in production");
  }

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ""),
    webOrigins,
    merchantApiKey: e.MERCHANT_API_KEY,
    rails: active,
    payTo,
    facilitatorMode: e.FACILITATOR_MODE,
    facilitatorUrl: e.X402_FACILITATOR_URL.replace(/\/+$/, ""),
    facilitatorToken: e.X402_FACILITATOR_TOKEN,
    offerFee: e.OFFER_FEE_ATOMIC,
    sessionTtlMs: e.SESSION_TTL_MINUTES * 60_000,
    paymentTimeoutSeconds: e.PAYMENT_TIMEOUT_SECONDS,
    trustProxy: e.TRUST_PROXY === "1",
    trustCfConnectingIp: e.TRUST_CF_CONNECTING_IP === "1",
    logLevel: e.LOG_LEVEL,
  };
}
