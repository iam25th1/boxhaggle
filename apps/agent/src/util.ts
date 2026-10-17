export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Shorten an id for display: first 6 and last 4 characters. */
export function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 6)}..${id.slice(-4)}`;
}

/**
 * Pull the payment header out of pay_x402's output.value.x_payment.
 * Docs say it carries "the header name and value"; the exact keys are not typed
 * in the SDK (RECON U2), so accept every reasonable shape and nothing else.
 */
export function extractPaymentHeader(value: unknown): { name: string; value: string } {
  const outer = asRecord(value);
  const x = outer && "x_payment" in outer ? outer.x_payment : value;
  if (typeof x === "string" && x.length > 0) return { name: "X-PAYMENT", value: x };
  const record = asRecord(x);
  if (record) {
    const headerValue = asString(record.value);
    const headerName = asString(record.header) ?? asString(record.name) ?? asString(record.header_name);
    if (headerValue) return { name: headerName ?? "X-PAYMENT", value: headerValue };
    for (const key of ["X-PAYMENT", "x-payment", "PAYMENT-SIGNATURE", "payment-signature"]) {
      const v = asString(record[key]);
      if (v) return { name: key.toUpperCase(), value: v };
    }
  }
  throw new Error("pay_x402 succeeded but no payment header was found in output.value.x_payment");
}

/** Pull a secret string out of a request_secret output without ever logging it. */
export function extractSecretValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["value", "secret", "raw", "plaintext", "token", "secret_token"]) {
    const v = record[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** Best-effort raw balance read from get_portfolio (shape typed as unknown in the SDK, RECON U6). */
export function readRawBalance(portfolio: unknown, token: string): bigint | null {
  const record = asRecord(portfolio);
  if (!record) return null;
  if (record.matched === false) return 0n;
  const items = Array.isArray(record.items) ? record.items : Array.isArray(record.holdings) ? record.holdings : [];
  const want = token.toLowerCase();
  const matches = items
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .filter((item) => {
      const address = (asString(item.token) ?? asString(item.address) ?? asString(item.tokenAddress) ?? asString(item.mint) ?? "").toLowerCase();
      return address === want || items.length === 1;
    });
  if (matches.length !== 1) return matches.length === 0 && items.length === 0 ? 0n : null;
  const balance = matches[0]?.balance;
  if (typeof balance === "string" && /^[0-9]+$/.test(balance)) return BigInt(balance);
  if (typeof balance === "number" && Number.isSafeInteger(balance)) return BigInt(balance);
  return null;
}

/** Best-effort USD price for a token row from discover_tokens. */
export function readPriceUsd(result: unknown, symbol: string): number | null {
  const record = asRecord(result);
  const rows = Array.isArray(result) ? result : Array.isArray(record?.tokens) ? record.tokens : Array.isArray(record?.results) ? record.results : record ? [record] : [];
  for (const row of rows) {
    const r = asRecord(row);
    if (!r) continue;
    if ((asString(r.symbol) ?? "").toUpperCase() !== symbol.toUpperCase()) continue;
    for (const key of ["priceUsd", "price_usd", "price", "usdPrice"]) {
      const v = r[key];
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}
