import { CheckoutReply, OfferReply, RevealReply, SessionCreated } from "@boxhaggle/core";
import type * as z from "zod";

// Thin client for The Broker. The merchant key is passed per call and only ever
// placed in the X-Merchant-Key request header.

export class MerchantClient {
  constructor(private readonly baseUrl: string) {}

  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    if (!url.startsWith(this.baseUrl)) throw new Error("refusing to send the merchant key to another origin");
    return fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  }

  async createSession(itemId: string, key: string): Promise<SessionCreated> {
    const res = await this.request("/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-merchant-key": key },
      body: JSON.stringify({ itemId, channel: "sdk" }),
    });
    return parse(res, SessionCreated, "POST /session");
  }

  /** POST a paid route. Returns the raw response so the caller can handle 402. */
  post(pathOrUrl: string, body: unknown, key: string, payment?: { name: string; value: string }): Promise<Response> {
    return this.request(pathOrUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-merchant-key": key,
        ...(payment ? { [payment.name]: payment.value } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async reveal(sessionId: string): Promise<RevealReply> {
    return parse(await this.request(`/reveal/${sessionId}`, { method: "GET" }), RevealReply, "GET /reveal");
  }

  parseOffer(res: Response) {
    return parse(res, OfferReply, "POST /offer");
  }

  parseCheckout(res: Response) {
    return parse(res, CheckoutReply, "POST /checkout");
  }
}

async function parse<T extends z.ZodType>(res: Response, schema: T, label: string): Promise<z.infer<T>> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} failed (${res.status}): ${text.slice(0, 200)}`);
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${label} returned an unexpected shape`);
  return parsed.data;
}
