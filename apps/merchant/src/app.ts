import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { getConnInfo } from "@hono/node-server/conninfo";
import {
  CheckoutBody,
  CreateSessionBody,
  ITEMS,
  OfferBody,
  RAILS,
  RelayBody,
  brokerLine,
  evaluateOffer,
  findItem,
  formatUsd,
  publicView,
  verifyReveal,
  type CheckoutReply,
  type OfferReply,
  type PublicSession,
  type RevealReply,
  type SessionCreated,
  type StreamEvent,
} from "@boxhaggle/core";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import { tag } from "./log.js";
import { mountMcp } from "./mcp.js";
import { LIMITS, RateLimiter, isLoopback } from "./ratelimit.js";
import { ReplayStore, SessionStore, openingLine, type Session } from "./store.js";
import type { Facilitator } from "./x402/facilitator.js";
import { collectPayment, paymentRequired, type PaywallDeps } from "./x402/paywall.js";
import { CHECKOUT_OUTPUT_SCHEMA, OFFER_OUTPUT_SCHEMA, resourceUrl, type Quote } from "./x402/requirements.js";

export interface AppDeps {
  config: Config;
  facilitator: Facilitator;
  log: Logger;
  sessions?: SessionStore;
  replay?: ReplayStore;
  limiter?: RateLimiter;
  /** Bundled in-chat counter UI served at ui://boxhaggle/counter. */
  counterHtmlPath?: string;
}

const KEY_HEADER = "x-merchant-key";

export function createApp(deps: AppDeps) {
  const { config, facilitator, log } = deps;
  const sessions = deps.sessions ?? new SessionStore(config.sessionTtlMs);
  const replay = deps.replay ?? new ReplayStore();
  const limiter = deps.limiter ?? new RateLimiter();
  const paywall: PaywallDeps = { config, facilitator, replay, log };
  const expectedKey = createHash("sha256").update(config.merchantApiKey).digest();
  const streams = { total: 0, perIp: new Map<string, number>() };

  const app = new Hono();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      crossOriginResourcePolicy: "cross-origin",
      referrerPolicy: "no-referrer",
    }),
  );
  app.use(
    "*",
    cors({
      origin: (origin) => (config.webOrigins.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Mcp-Protocol-Version"],
      maxAge: 600,
      credentials: false,
    }),
  );
  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    if (c.req.path !== "/healthz") {
      log.info("request", { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started });
    }
  });
  app.use("*", bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: "body_too_large" }, 413) }));

  app.onError((error, c) => {
    log.error("unhandled", { path: c.req.path, name: error.name });
    return c.json({ error: "internal" }, 500);
  });
  app.notFound((c) => c.json({ error: "not_found" }, 404));

  // ---- helpers ----

  const clientIp = (c: Context): string => {
    let peer: string | undefined;
    try {
      peer = getConnInfo(c).remote.address;
    } catch {
      peer = undefined;
    }
    // Behind the local cloudflared every request arrives from loopback, so the
    // real client is in CF-Connecting-IP. Only a loopback peer may supply it:
    // from any other peer the header is the client's own claim and is ignored.
    if (config.trustCfConnectingIp && peer && isLoopback(peer)) {
      const cf = c.req.header("cf-connecting-ip")?.trim();
      if (cf && isIP(cf)) return cf;
    }
    if (config.trustProxy) {
      const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (forwarded) return forwarded;
    }
    return peer ?? "unknown";
  };

  const limited = (c: Context, key: string, rule: { limit: number; windowMs: number }) =>
    limiter.hit(key, rule.limit, rule.windowMs) ? null : c.json({ error: "rate_limited" }, 429, { "Retry-After": "30" });

  const hasKey = (c: Context): boolean => {
    const given = c.req.header(KEY_HEADER);
    if (!given || given.length > 512) return false;
    return timingSafeEqual(createHash("sha256").update(given).digest(), expectedKey);
  };

  const readJson = async (c: Context): Promise<unknown> => {
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) return Symbol.for("bad");
    try {
      return await c.req.json();
    } catch {
      return Symbol.for("bad");
    }
  };

  const invalid = (c: Context, issues: { path: PropertyKey[]; message: string }[]) =>
    c.json({ error: "invalid_body", issues: issues.slice(0, 5).map((i) => ({ path: i.path.map(String).join("."), message: i.message })) }, 400);

  const view = (session: Session): PublicSession => ({
    sessionId: session.id,
    channel: session.channel,
    item: { id: session.item.id, name: session.item.name, blurb: session.item.blurb, art: session.item.art },
    currency: "USDC",
    ...publicView(session.broker),
    offerFee: config.offerFee,
    commitment: session.commitment,
    networks: config.rails.map((rail) => RAILS[rail].v2Network),
    checkoutPaid: session.checkoutPaid,
    expiresAt: new Date(session.expiresAt).toISOString(),
  });

  const queryMismatch = (c: Context, sessionId: string, round: number): boolean => {
    const qs = c.req.query("session");
    const qr = c.req.query("round");
    return (qs !== undefined && qs !== sessionId) || (qr !== undefined && qr !== String(round));
  };

  // ---- public metadata ----

  app.get("/healthz", (c) => c.json({ ok: true, rails: config.rails, facilitator: facilitator.mode }));

  app.get("/items", (c) =>
    c.json({
      items: ITEMS.map((item) => ({ id: item.id, name: item.name, blurb: item.blurb, art: item.art, listPrice: item.listPrice })),
      offerFee: config.offerFee,
      currency: "USDC",
    }),
  );

  app.get("/.well-known/x402", (c) =>
    c.json({
      name: "BOXHAGGLE: The Broker's Counter",
      description: "Haggle with The Broker. Each counter-offer is a paid x402 call; the deal settles with one exact x402 payment.",
      x402Versions: [1, 2],
      facilitator: facilitator.mode === "http" ? config.facilitatorUrl : "local",
      rails: config.rails.map((id) => ({ network: RAILS[id].v2Network, v1Network: RAILS[id].v1Network, asset: RAILS[id].usdc, payTo: config.payTo[id] })),
      resources: [
        {
          resource: `${config.publicBaseUrl}/offer`,
          method: "POST",
          price: { amount: String(config.offerFee), asset: "USDC", decimals: 6 },
          schema: OFFER_OUTPUT_SCHEMA,
          auth: "sdk sessions: X-Merchant-Key header; plugin sessions: payment only",
        },
        {
          resource: `${config.publicBaseUrl}/checkout`,
          method: "POST",
          price: { amount: "final agreed price", asset: "USDC", decimals: 6 },
          schema: CHECKOUT_OUTPUT_SCHEMA,
          auth: "sdk sessions: X-Merchant-Key header; plugin sessions: payment only",
        },
      ],
      free: [
        { resource: `${config.publicBaseUrl}/session`, method: "POST", auth: "X-Merchant-Key" },
        { resource: `${config.publicBaseUrl}/session/{sessionId}`, method: "GET" },
        { resource: `${config.publicBaseUrl}/reveal/{sessionId}`, method: "GET" },
        { resource: `${config.publicBaseUrl}/items`, method: "GET" },
      ],
    }),
  );

  // ---- session ----

  app.post("/session", async (c) => {
    const ip = clientIp(c);
    const blocked = limited(c, `session:${ip}`, LIMITS.sessionPerIp);
    if (blocked) return blocked;
    if (!hasKey(c)) return c.json({ error: "unauthorized", message: "X-Merchant-Key required" }, 401);
    const raw = await readJson(c);
    if (typeof raw === "symbol") return c.json({ error: "invalid_json" }, 400);
    const body = CreateSessionBody.safeParse(raw);
    if (!body.success) return invalid(c, body.error.issues);
    const item = findItem(body.data.itemId);
    if (!item) return c.json({ error: "unknown_item" }, 404);

    const session = sessions.create(item, body.data.channel);
    const line = openingLine(session);
    sessions.publish(session, {
      t: "session.opened",
      at: Date.now(),
      sessionId: session.id,
      itemId: item.id,
      itemName: item.name,
      art: item.art,
      listPrice: item.listPrice,
      ask: session.broker.ask,
      patience: session.broker.patience,
      commitment: session.commitment,
      offerFee: config.offerFee,
      networks: config.rails.map((rail) => RAILS[rail].v2Network),
      channel: session.channel,
      line,
    });
    log.info("session opened", { session: tag(session.id), item: item.id, channel: session.channel });
    const reply: SessionCreated = { ...view(session), line };
    return c.json(reply, 201);
  });

  app.get("/session/:id", (c) => {
    const blocked = limited(c, `read:${clientIp(c)}`, LIMITS.readPerIp);
    if (blocked) return blocked;
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "unknown_session" }, 404);
    return c.json(view(session));
  });

  // The same public events the SSE stream carries, as one JSON read, for
  // callers that cannot hold a stream (the hosted plugin, text frames).
  app.get("/session/:id/events", (c) => {
    const blocked = limited(c, `read:${clientIp(c)}`, LIMITS.readPerIp);
    if (blocked) return blocked;
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "unknown_session" }, 404);
    return c.json({ sessionId: session.id, seq: session.seq, events: session.events });
  });

  // ---- paid routes ----

  // sdk sessions are key-gated. Plugin sessions bind to their first payer.
  const normalizePayer = (payer: string) => (payer.startsWith("0x") ? payer.toLowerCase() : payer);
  const payerGate = (session: Session) =>
    session.channel === "plugin"
      ? (payer: string | undefined) => Boolean(payer) && (session.payer === null || session.payer === normalizePayer(payer ?? ""))
      : undefined;
  const bindPayer = (session: Session, payer: string | null) => {
    if (session.channel === "plugin" && session.payer === null && payer) session.payer = normalizePayer(payer);
  };

  const guardPaid = async (c: Context, sessionId: string): Promise<Session | Response> => {
    const ip = clientIp(c);
    const byIp = limited(c, `paid:${ip}`, LIMITS.paidPerIp);
    if (byIp) return byIp;
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "unknown_session" }, 404);
    if (session.channel === "sdk" && !hasKey(c)) {
      return c.json({ error: "unauthorized", message: "X-Merchant-Key required for sdk sessions" }, 401);
    }
    const bySession = limited(c, `paid-session:${session.id}`, LIMITS.paidPerSession);
    if (bySession) return bySession;
    return session;
  };

  app.post("/offer", async (c) => {
    const raw = await readJson(c);
    if (typeof raw === "symbol") return c.json({ error: "invalid_json" }, 400);
    const body = OfferBody.safeParse(raw);
    if (!body.success) return invalid(c, body.error.issues);
    const guarded = await guardPaid(c, body.data.sessionId);
    if (guarded instanceof Response) return guarded;
    const session = guarded;

    if (session.broker.status !== "open") return c.json({ error: "session_closed", status: session.broker.status }, 409);
    const offer = Number(body.data.amount);
    if (offer > session.broker.listPrice * 4) return c.json({ error: "offer_out_of_range" }, 400);
    const round = session.broker.round + 1;
    if (queryMismatch(c, session.id, round)) return c.json({ error: "stale_round", round }, 409);

    const quote: Quote = {
      kind: "offer",
      sessionId: session.id,
      round,
      amount: config.offerFee,
      resource: resourceUrl(config, "offer", session.id, round),
      description: `BOXHAGGLE counter-offer, round ${round}`,
    };
    const hasPayment = Boolean(c.req.header("payment-signature") ?? c.req.header("x-payment"));
    if (!hasPayment) return paymentRequired(c, paywall, quote, "payment_required");
    if (session.busy) return c.json({ error: "busy" }, 409, { "Retry-After": "1" });

    session.busy = true;
    let result;
    try {
      result = await collectPayment(c, paywall, quote, payerGate(session));
    } finally {
      session.busy = false;
    }
    if (!result.ok) {
      sessions.publish(session, { t: "payment.rejected", at: Date.now(), route: "offer", reason: rejectionReason(result.response) });
      return result.response;
    }

    bindPayer(session, result.receipt.payer);
    // The session lock held for the whole payment, so round and status are unchanged.
    const outcome = evaluateOffer(session.broker, offer);
    session.broker = outcome.state;
    session.fees.push(config.offerFee);
    const s = outcome.state;
    const ctx = { ask: formatUsd(s.ask), offer: formatUsd(offer), item: session.item.name };
    const line = s.status === "walked" ? brokerLine(session.commitment, round, "walk", ctx) : brokerLine(session.commitment, round, s.mood, ctx);
    const at = Date.now();
    sessions.publish(session, { t: "offer.paid", at, round, offer, fee: config.offerFee, txRef: result.receipt.txRef.slice(0, 96), network: result.receipt.network });
    sessions.publish(session, {
      t: "broker.reply",
      at,
      round,
      offer,
      previousAsk: outcome.previousAsk,
      ask: s.ask,
      patience: s.patience,
      mood: s.mood,
      status: s.status,
      line,
    });

    c.header(result.receipt.responseHeader.name, result.receipt.responseHeader.value);
    const reply: OfferReply = {
      sessionId: session.id,
      round,
      offer,
      previousAsk: outcome.previousAsk,
      ask: s.ask,
      patience: s.patience,
      mood: s.mood,
      status: s.status,
      finalPrice: s.finalPrice,
      line,
      fee: config.offerFee,
      payment: { network: result.receipt.network, txRef: result.receipt.txRef, payer: result.receipt.payer },
    };
    return c.json(reply);
  });

  app.post("/checkout", async (c) => {
    const raw = await readJson(c);
    if (typeof raw === "symbol") return c.json({ error: "invalid_json" }, 400);
    const body = CheckoutBody.safeParse(raw);
    if (!body.success) return invalid(c, body.error.issues);
    const guarded = await guardPaid(c, body.data.sessionId);
    if (guarded instanceof Response) return guarded;
    const session = guarded;

    if (session.broker.status !== "sold" || session.broker.finalPrice === null) {
      return c.json({ error: "no_deal", status: session.broker.status }, 409);
    }
    if (session.checkoutPaid) return c.json({ error: "already_paid", receiptId: session.receiptId }, 409);
    const round = session.broker.round;
    if (queryMismatch(c, session.id, round)) return c.json({ error: "stale_round", round }, 409);

    const quote: Quote = {
      kind: "checkout",
      sessionId: session.id,
      round,
      amount: session.broker.finalPrice,
      resource: resourceUrl(config, "checkout", session.id, round),
      description: `BOXHAGGLE checkout: ${session.item.name}`,
    };
    const hasPayment = Boolean(c.req.header("payment-signature") ?? c.req.header("x-payment"));
    if (!hasPayment) return paymentRequired(c, paywall, quote, "payment_required");
    if (session.busy) return c.json({ error: "busy" }, 409, { "Retry-After": "1" });

    session.busy = true;
    let result;
    try {
      result = await collectPayment(c, paywall, quote, payerGate(session));
    } finally {
      session.busy = false;
    }
    if (!result.ok) {
      sessions.publish(session, { t: "payment.rejected", at: Date.now(), route: "checkout", reason: rejectionReason(result.response) });
      return result.response;
    }

    bindPayer(session, result.receipt.payer);
    session.checkoutPaid = true;
    session.receiptId = `BH-${randomBytes(4).toString("hex").toUpperCase()}`;
    sessions.publish(session, {
      t: "checkout.paid",
      at: Date.now(),
      price: session.broker.finalPrice,
      txRef: result.receipt.txRef.slice(0, 96),
      network: result.receipt.network,
      receiptId: session.receiptId,
    });
    c.header(result.receipt.responseHeader.name, result.receipt.responseHeader.value);
    const reply: CheckoutReply = {
      sessionId: session.id,
      finalPrice: session.broker.finalPrice,
      receiptId: session.receiptId,
      payment: { network: result.receipt.network, txRef: result.receipt.txRef, payer: result.receipt.payer },
    };
    return c.json(reply);
  });

  // ---- reveal ----

  app.get("/reveal/:id", (c) => {
    const blocked = limited(c, `read:${clientIp(c)}`, LIMITS.readPerIp);
    if (blocked) return blocked;
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "unknown_session" }, 404);
    if (session.broker.status === "open") return c.json({ error: "session_open", message: "Floor is revealed after the session ends." }, 409);
    const check = verifyReveal(session.commitment, session.broker.floor, session.salt);
    if (!session.revealed) {
      session.revealed = true;
      sessions.publish(session, {
        t: "reveal",
        at: Date.now(),
        floor: session.broker.floor,
        salt: session.salt,
        commitment: session.commitment,
        verified: check.verified,
      });
    }
    const reply: RevealReply = {
      sessionId: session.id,
      floor: session.broker.floor,
      salt: session.salt,
      commitment: session.commitment,
      verified: check.verified,
    };
    return c.json(reply);
  });

  // ---- spectator streams ----

  const openStream = (ip: string): boolean => {
    const mine = streams.perIp.get(ip) ?? 0;
    if (streams.total >= LIMITS.streamsTotal || mine >= LIMITS.streamsPerIp) return false;
    streams.total += 1;
    streams.perIp.set(ip, mine + 1);
    return true;
  };
  const closeStream = (ip: string) => {
    streams.total = Math.max(0, streams.total - 1);
    const mine = (streams.perIp.get(ip) ?? 1) - 1;
    if (mine <= 0) streams.perIp.delete(ip);
    else streams.perIp.set(ip, mine);
  };

  app.get("/events/:id", (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "unknown_session" }, 404);
    const ip = clientIp(c);
    if (session.listeners.size >= LIMITS.streamsPerSession || !openStream(ip)) return c.json({ error: "too_many_streams" }, 429);
    const lastId = Number(c.req.header("last-event-id") ?? "0") || 0;
    c.header("Cache-Control", "no-store");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const send = (event: StreamEvent) =>
        stream.writeSSE({ event: "haggle", id: String(event.seq), data: JSON.stringify(event) }).catch(() => undefined);
      for (const event of session.events) if (event.seq > lastId) await send(event);
      const listener = (event: StreamEvent) => void send(event);
      session.listeners.add(listener);
      stream.onAbort(() => {
        session.listeners.delete(listener);
        closeStream(ip);
      });
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(15_000);
        await stream.write(": ping\n\n").catch(() => undefined);
      }
    });
  });

  app.get("/lobby", (c) => {
    const ip = clientIp(c);
    if (!openStream(ip)) return c.json({ error: "too_many_streams" }, 429);
    c.header("Cache-Control", "no-store");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const send = (entry: object) => stream.writeSSE({ event: "session", data: JSON.stringify(entry) }).catch(() => undefined);
      for (const entry of [...sessions.recentLobby()].reverse()) await send(entry);
      const off = sessions.onLobby((entry) => void send(entry));
      stream.onAbort(() => {
        off();
        closeStream(ip);
      });
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(15_000);
        await stream.write(": ping\n\n").catch(() => undefined);
      }
    });
  });

  // ---- agent relay ----

  app.post("/relay/:id", async (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "unknown_session" }, 404);
    if (!hasKey(c)) return c.json({ error: "unauthorized" }, 401);
    const blocked = limited(c, `relay:${session.id}`, LIMITS.relayPerSession);
    if (blocked) return blocked;
    const raw = await readJson(c);
    if (typeof raw === "symbol") return c.json({ error: "invalid_json" }, 400);
    const body = RelayBody.safeParse(raw);
    if (!body.success) return invalid(c, body.error.issues);
    const now = Date.now();
    for (const event of body.data.events) {
      if (event.at > now + 60_000 || event.at < session.createdAt - 30 * 60_000) return c.json({ error: "event_time_out_of_range" }, 400);
    }
    for (const event of body.data.events) sessions.publish(session, event);
    return c.json({ accepted: body.data.events.length, seq: session.seq });
  });

  mountMcp(app, { config, log, sessions, limiter, clientIp, counterHtmlPath: deps.counterHtmlPath });

  return { app, sessions, replay };
}

function rejectionReason(response: Response): string {
  // The paywall puts the reason in PAYMENT-REQUIRED; read it back without exposing payload data.
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) return `http_${response.status}`;
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error.slice(0, 96) : `http_${response.status}`;
  } catch {
    return `http_${response.status}`;
  }
}
