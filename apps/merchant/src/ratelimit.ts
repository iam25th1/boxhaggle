// Fixed-window counters keyed by bucket name. In-memory, single instance.

export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Returns true when the call is allowed. */
  hit(key: string, limit: number, windowMs: number): boolean {
    const t = this.now();
    const current = this.windows.get(key);
    if (!current || t - current.start >= windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      this.sweep(windowMs);
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }

  private sweep(windowMs: number): void {
    if (this.windows.size < 20_000) return;
    const t = this.now();
    for (const [key, w] of this.windows) if (t - w.start >= windowMs) this.windows.delete(key);
  }
}

/** True for 127.0.0.0/8 and ::1, including the IPv4-mapped form Node reports on dual-stack sockets. */
export function isLoopback(address: string): boolean {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return v4 === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

export const LIMITS = {
  sessionPerIp: { limit: 12, windowMs: 60_000 },
  paidPerIp: { limit: 90, windowMs: 60_000 },
  paidPerSession: { limit: 40, windowMs: 60_000 },
  readPerIp: { limit: 240, windowMs: 60_000 },
  relayPerSession: { limit: 240, windowMs: 60_000 },
  mcpPerIp: { limit: 120, windowMs: 60_000 },
  streamsPerIp: 8,
  streamsPerSession: 25,
  streamsTotal: 500,
} as const;
