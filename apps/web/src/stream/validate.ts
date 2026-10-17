import { Channel, HaggleEvent, SessionId, type StreamEvent } from "@boxhaggle/core";

// Everything that arrives over the network is checked against the core zod
// schemas. The schemas are strict, so `seq` is split off before parsing and
// re-attached after. Anything invalid is dropped.

export function parseStreamEvent(data: string, lastEventId: string): StreamEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { seq, ...rest } = raw as Record<string, unknown>;
  const parsed = HaggleEvent.safeParse(rest);
  if (!parsed.success) return null;
  const fromId = Number.parseInt(lastEventId, 10);
  const n = typeof seq === "number" && Number.isSafeInteger(seq) ? seq : fromId;
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return { ...parsed.data, seq: n } as StreamEvent;
}

/** Validate a stored replay step's event, whatever shape it arrived in. */
export function parseEventObject(value: unknown, fallbackSeq: number): StreamEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { seq, ...rest } = value as Record<string, unknown>;
  const parsed = HaggleEvent.safeParse(rest);
  if (!parsed.success) return null;
  const n = typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? seq : fallbackSeq;
  return { ...parsed.data, seq: n } as StreamEvent;
}

export interface LobbySession {
  sessionId: string;
  itemName: string;
  channel: "sdk" | "plugin";
  at: number;
}

export function parseLobby(data: string): LobbySession | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = SessionId.safeParse(r.sessionId);
  const channel = Channel.safeParse(r.channel);
  if (!id.success || !channel.success) return null;
  if (typeof r.itemName !== "string" || r.itemName.length > 96) return null;
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
  return { sessionId: id.data, itemName: r.itemName, channel: channel.data, at: r.at };
}
