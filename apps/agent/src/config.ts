import * as z from "zod";

// Agent configuration. PayBox credentials come from env (never flags, never files
// in the repo). The merchant key is NOT configured here: the agent gets it from
// PayBox request_secret at run time.

const Env = z.object({
  PAYBOX_API_URL: z.url().default("https://api.paybox.sh"),
  PAYBOX_API_KEY: z.string().regex(/^pbx_live_/, "PAYBOX_API_KEY must be a pbx_live_ key").optional(),
  PAYBOX_SIGNING_KEY: z.string().regex(/^pbxk1\./, "PAYBOX_SIGNING_KEY must be a pbxk1. key").optional(),
  MERCHANT_URL: z.url().default("http://localhost:8787"),
  ITEM_ID: z.string().default("brass-compass"),
  SPEND_CAP_USD: z.coerce.number().min(0).max(100).default(3),
  WALLET_CREDENTIAL_ID: z.string().optional(),
  SECRET_CREDENTIAL_ID: z.string().optional(),
  /** token-then-raw: ask for a one-time secret_token first (shown in the UI), then raw for actual egress. */
  SECRET_MODE: z.enum(["token-then-raw", "raw"]).default("token-then-raw"),
  CARD_PATH: z.enum(["off", "on"]).default("off"),
  /** Optional pin: refuse x402 requirements that pay anyone else. */
  EXPECT_PAYTO_SOLANA: z.string().optional(),
  EXPECT_PAYTO_BASE: z.string().optional(),
  BUY_TX_SIGNATURE: z.string().optional(),
  APPROVAL_WAIT_SECONDS: z.coerce.number().int().min(10).max(1800).default(600),
  FUNDING_WAIT_SECONDS: z.coerce.number().int().min(0).max(3600).default(900),
  ACCOUNT_WAIT_SECONDS: z.coerce.number().int().min(0).max(1800).default(300),
  RELAY: z.enum(["on", "off"]).default("on"),
  /** Mock mode only: the merchant key held by the mock vault. */
  MOCK_MERCHANT_KEY: z.string().optional(),
  MOCK_PACE_MS: z.coerce.number().int().min(0).max(5000).default(700),
});

export interface AgentConfig {
  mock: boolean;
  payboxApiUrl: string;
  payboxApiKey: string | undefined;
  payboxSigningKey: string | undefined;
  merchantUrl: string;
  itemId: string;
  spendCapAtomic: number;
  walletCredentialId: string | undefined;
  secretCredentialId: string | undefined;
  secretMode: "token-then-raw" | "raw";
  cardPath: boolean;
  expectPayTo: { solana?: string; base?: string };
  buyTxSignature: string | undefined;
  approvalWaitMs: number;
  fundingWaitMs: number;
  accountWaitMs: number;
  relay: boolean;
  mockMerchantKey: string | undefined;
  mockPaceMs: number;
}

export function loadConfig(argv: string[] = process.argv.slice(2), source: Record<string, string | undefined> = process.env): AgentConfig {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid agent configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const e = parsed.data;
  const mock = argv.includes("--mock");
  const itemFlag = argv.indexOf("--item");
  const itemId = itemFlag >= 0 && argv[itemFlag + 1] ? String(argv[itemFlag + 1]) : e.ITEM_ID;
  if (!mock && !e.PAYBOX_API_KEY) throw new Error("PAYBOX_API_KEY is required for a live run (or pass --mock)");
  if (mock && !e.MOCK_MERCHANT_KEY) throw new Error("MOCK_MERCHANT_KEY is required for --mock (same value as the local merchant's MERCHANT_API_KEY)");
  return {
    mock,
    payboxApiUrl: e.PAYBOX_API_URL.replace(/\/+$/, ""),
    payboxApiKey: e.PAYBOX_API_KEY,
    payboxSigningKey: e.PAYBOX_SIGNING_KEY,
    merchantUrl: e.MERCHANT_URL.replace(/\/+$/, ""),
    itemId,
    spendCapAtomic: Math.round(e.SPEND_CAP_USD * 1_000_000),
    walletCredentialId: e.WALLET_CREDENTIAL_ID,
    secretCredentialId: e.SECRET_CREDENTIAL_ID,
    secretMode: e.SECRET_MODE,
    cardPath: e.CARD_PATH === "on",
    expectPayTo: { solana: e.EXPECT_PAYTO_SOLANA, base: e.EXPECT_PAYTO_BASE },
    buyTxSignature: e.BUY_TX_SIGNATURE,
    approvalWaitMs: e.APPROVAL_WAIT_SECONDS * 1000,
    fundingWaitMs: e.FUNDING_WAIT_SECONDS * 1000,
    accountWaitMs: e.ACCOUNT_WAIT_SECONDS * 1000,
    relay: e.RELAY === "on",
    mockMerchantKey: e.MOCK_MERCHANT_KEY,
    mockPaceMs: e.MOCK_PACE_MS,
  };
}
