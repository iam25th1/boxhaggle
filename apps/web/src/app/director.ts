import type { StreamEvent } from "@boxhaggle/core";
import { clock } from "./clock";

// One queue feeds the renderer in both modes. Replay steps carry their own
// delay; live events are paced so a burst (history on connect) still reads as
// a sequence. Waiting uses the scene clock, so Space pauses the queue too.

interface Item {
  event: StreamEvent;
  delayMs: number | null;
}

/** Minimum gap after an event before the next one renders, in live mode. */
const LIVE_GAP: Partial<Record<StreamEvent["t"], number>> = {
  "session.opened": 1600,
  "agent.thought": 1200,
  "paybox.call": 600,
  "paybox.envelope": 800,
  "offer.paid": 900,
  "broker.reply": 1600,
  "credentials.listed": 900,
  "swap.quote": 900,
  "swap.status": 500,
  "checkout.paid": 1000,
  reveal: 5200,
  receipt: 1400,
  score: 1600,
};

export class Director {
  private queue: Item[] = [];
  private token = 0;
  private lastRenderAt = -Infinity;
  private lastType: StreamEvent["t"] | null = null;
  private wake: (() => void) | null = null;
  private live = false;

  constructor(private readonly render: (event: StreamEvent) => void) {}

  get pending(): number {
    return this.queue.length;
  }

  /** Replace the queue with a scripted replay and start it. */
  playScript(steps: Array<{ delayMs: number; event: StreamEvent }>): void {
    this.stop();
    this.live = false;
    this.queue = steps.map((step) => ({ event: step.event, delayMs: step.delayMs }));
    this.start();
  }

  /** Live mode: start an empty queue that events are pushed into. */
  startLive(): void {
    this.stop();
    this.live = true;
    this.start();
  }

  push(event: StreamEvent): void {
    this.queue.push({ event, delayMs: null });
    this.wake?.();
  }

  /** Look ahead without consuming, used by the live item screen. */
  peek(predicate: (event: StreamEvent) => boolean): StreamEvent | undefined {
    return this.queue.find((item) => predicate(item.event))?.event;
  }

  stop(): void {
    this.token += 1;
    this.queue = [];
    this.wake?.();
    this.wake = null;
    this.lastRenderAt = -Infinity;
    this.lastType = null;
  }

  private start(): void {
    const token = ++this.token;
    void this.loop(token);
  }

  private livePace(): number {
    if (!this.lastType) return 0;
    let gap = LIVE_GAP[this.lastType] ?? 450;
    if (this.queue.length > 12) gap = Math.min(gap, 220);
    else if (this.queue.length > 4) gap *= 0.5;
    return Math.max(0, gap - (clock.now() - this.lastRenderAt));
  }

  private async loop(token: number): Promise<void> {
    while (token === this.token) {
      const next = this.queue[0];
      if (!next) {
        if (!this.live) return;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = null;
        continue;
      }
      const delay = next.delayMs ?? this.livePace();
      if (delay > 0) await clock.wait(delay);
      if (token !== this.token) return;
      this.queue.shift();
      this.lastRenderAt = clock.now();
      this.lastType = next.event.t;
      try {
        this.render(next.event);
      } catch (error) {
        console.error("render failed", next.event.t, error);
      }
    }
  }
}
