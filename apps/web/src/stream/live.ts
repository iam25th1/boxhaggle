import type { StreamEvent } from "@boxhaggle/core";
import { parseLobby, parseStreamEvent, type LobbySession } from "./validate";

// Live mode: two Server-Sent Event streams from the merchant.
//   GET {merchant}/lobby               event "session": a new session opened
//   GET {merchant}/events/{sessionId}  event "haggle": one StreamEvent, id = seq
// The session stream replays history first, then goes live. Reconnects can
// replay history again, so events are de-duplicated by seq.

export type LinkState = "idle" | "connecting" | "open" | "retrying" | "closed";

export interface LiveHandlers {
  onLobbyState(state: LinkState): void;
  onSessionState(state: LinkState): void;
  onLobbySession(session: LobbySession): void;
  onEvent(event: StreamEvent): void;
  onDropped?(count: number): void;
}

function readMerchantUrl(): string | null {
  const raw: unknown = import.meta.env.VITE_MERCHANT_URL;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export const MERCHANT_URL = readMerchantUrl();

export function sessionFromQuery(): string | null {
  try {
    const id = new URLSearchParams(window.location.search).get("session");
    return id && /^[a-f0-9]{32}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export class LiveFeed {
  private lobby: EventSource | null = null;
  private session: EventSource | null = null;
  private lastSeq = -1;
  private dropped = 0;
  private lobbyRetry: number | null = null;
  private sessionRetry: number | null = null;
  private lobbyBackoff = 1500;
  private sessionBackoff = 1500;
  sessionId: string | null = null;

  constructor(private readonly base: string, private readonly handlers: LiveHandlers) {}

  connectLobby(): void {
    this.closeLobby();
    this.handlers.onLobbyState("connecting");
    const es = new EventSource(`${this.base}/lobby`);
    this.lobby = es;
    es.addEventListener("open", () => {
      this.lobbyBackoff = 1500;
      this.handlers.onLobbyState("open");
    });
    es.addEventListener("session", (msg) => {
      const parsed = parseLobby((msg as MessageEvent<string>).data);
      if (parsed) this.handlers.onLobbySession(parsed);
    });
    es.addEventListener("error", () => {
      if (es.readyState === EventSource.CLOSED) {
        this.handlers.onLobbyState("closed");
        this.lobbyRetry = window.setTimeout(() => this.connectLobby(), this.lobbyBackoff);
        this.lobbyBackoff = Math.min(this.lobbyBackoff * 2, 15_000);
      } else {
        this.handlers.onLobbyState("retrying");
      }
    });
  }

  follow(sessionId: string): void {
    if (this.sessionId !== sessionId) this.lastSeq = -1;
    this.closeSession();
    this.sessionId = sessionId;
    this.handlers.onSessionState("connecting");
    const es = new EventSource(`${this.base}/events/${encodeURIComponent(sessionId)}`);
    this.session = es;
    es.addEventListener("open", () => {
      this.sessionBackoff = 1500;
      this.handlers.onSessionState("open");
    });
    es.addEventListener("haggle", (msg) => {
      const m = msg as MessageEvent<string>;
      const event = parseStreamEvent(m.data, m.lastEventId);
      if (!event) {
        this.dropped += 1;
        this.handlers.onDropped?.(this.dropped);
        return;
      }
      if (event.seq <= this.lastSeq) return;
      this.lastSeq = event.seq;
      this.handlers.onEvent(event);
    });
    es.addEventListener("error", () => {
      if (es.readyState === EventSource.CLOSED) {
        this.handlers.onSessionState("closed");
        this.sessionRetry = window.setTimeout(() => this.follow(sessionId), this.sessionBackoff);
        this.sessionBackoff = Math.min(this.sessionBackoff * 2, 15_000);
      } else {
        this.handlers.onSessionState("retrying");
      }
    });
  }

  private closeLobby(): void {
    if (this.lobbyRetry !== null) window.clearTimeout(this.lobbyRetry);
    this.lobbyRetry = null;
    this.lobby?.close();
    this.lobby = null;
  }

  private closeSession(): void {
    if (this.sessionRetry !== null) window.clearTimeout(this.sessionRetry);
    this.sessionRetry = null;
    this.session?.close();
    this.session = null;
  }

  close(): void {
    this.closeLobby();
    this.closeSession();
    this.sessionId = null;
    this.handlers.onLobbyState("idle");
    this.handlers.onSessionState("idle");
  }
}
