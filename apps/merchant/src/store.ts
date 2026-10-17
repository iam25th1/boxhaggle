import { randomBytes } from "node:crypto";
import {
  brokerLine,
  commit,
  drawFloor,
  formatUsd,
  openBroker,
  type BrokerState,
  type HaggleEvent,
  type Item,
  type StreamEvent,
} from "@boxhaggle/core";

// In-memory state for a single merchant instance. Railway runs one replica.
// Floor and salt live only here and leave the process only through /reveal
// after the session has ended.

export interface Session {
  id: string;
  channel: "sdk" | "plugin";
  item: Item;
  broker: BrokerState;
  salt: string;
  commitment: string;
  createdAt: number;
  expiresAt: number;
  fees: number[];
  checkoutPaid: boolean;
  receiptId: string | null;
  revealed: boolean;
  /** Set while a paid request for this session is being verified and settled. */
  busy: boolean;
  /** Plugin sessions bind to the first payer; later payments from anyone else are refused before settlement. */
  payer: string | null;
  events: StreamEvent[];
  seq: number;
  listeners: Set<(event: StreamEvent) => void>;
}

export interface LobbyEntry {
  sessionId: string;
  itemName: string;
  channel: "sdk" | "plugin";
  at: number;
}

const MAX_EVENTS = 600;
const MAX_SESSIONS = 5_000;

export function randomUnit(): number {
  // 48 random bits mapped to [0, 1).
  return randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private lobby: LobbyEntry[] = [];
  private lobbyListeners = new Set<(entry: LobbyEntry) => void>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  create(item: Item, channel: "sdk" | "plugin"): Session {
    this.sweep();
    if (this.sessions.size >= MAX_SESSIONS) throw new Error("session capacity reached");
    const id = randomBytes(16).toString("hex");
    const salt = randomBytes(32).toString("hex");
    const floor = drawFloor(item, randomUnit());
    const createdAt = this.now();
    const session: Session = {
      id,
      channel,
      item,
      broker: openBroker(item.listPrice, floor),
      salt,
      commitment: commit(floor, salt),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      fees: [],
      checkoutPaid: false,
      receiptId: null,
      revealed: false,
      busy: false,
      payer: null,
      events: [],
      seq: 0,
      listeners: new Set(),
    };
    this.sessions.set(id, session);
    const entry: LobbyEntry = { sessionId: id, itemName: item.name, channel, at: createdAt };
    // Plugin sessions are payment-gated, not key-gated, so their ids are never announced.
    if (channel === "sdk") {
      this.lobby = [entry, ...this.lobby].slice(0, 20);
      for (const listener of this.lobbyListeners) listener(entry);
    }
    return session;
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt < this.now() && session.broker.status === "open") {
      session.broker = { ...session.broker, status: "walked", mood: "insulted" };
    }
    return session;
  }

  /** Sessions are kept past expiry for one extra TTL so /reveal still works, then dropped. */
  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt < cutoff && session.listeners.size === 0) this.sessions.delete(id);
    }
  }

  publish(session: Session, event: HaggleEvent): StreamEvent {
    session.seq += 1;
    const stamped = { ...event, seq: session.seq } as StreamEvent;
    session.events.push(stamped);
    if (session.events.length > MAX_EVENTS) session.events.splice(0, session.events.length - MAX_EVENTS);
    for (const listener of session.listeners) listener(stamped);
    return stamped;
  }

  recentLobby(): LobbyEntry[] {
    return this.lobby.slice(0, 5);
  }

  onLobby(listener: (entry: LobbyEntry) => void): () => void {
    this.lobbyListeners.add(listener);
    return () => this.lobbyListeners.delete(listener);
  }

  get lobbyListenerCount(): number {
    return this.lobbyListeners.size;
  }
}

/** Opening line for a session, deterministic from its public commitment. */
export function openingLine(session: Session): string {
  return brokerLine(session.commitment, 0, "opening", {
    ask: formatUsd(session.broker.ask),
    offer: "",
    item: session.item.name,
  });
}

/** Single-use payment identifiers, kept until their payment window has passed. */
export class ReplayStore {
  private used = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Returns false when the id was already used. Marks it used either way. */
  claim(id: string, ttlMs: number): boolean {
    this.sweep();
    const until = this.used.get(id);
    if (until !== undefined && until > this.now()) return false;
    this.used.set(id, this.now() + ttlMs);
    return true;
  }

  has(id: string): boolean {
    const until = this.used.get(id);
    return until !== undefined && until > this.now();
  }

  private sweep(): void {
    if (this.used.size < 10_000) return;
    const t = this.now();
    for (const [id, until] of this.used) if (until <= t) this.used.delete(id);
  }
}
