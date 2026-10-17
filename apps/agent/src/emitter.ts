import { AgentEvent } from "@boxhaggle/core";

// Typed event emitter. Every event is validated against the core schema (which
// has no field that could carry a key, card, signature or payment header), then
// printed and relayed to the merchant SSE stream. Events before the session
// exists are buffered and flushed once it opens.

type Draft = AgentEvent extends infer E ? (E extends { at: number } ? Omit<E, "at"> & { at?: number } : never) : never;

export class Emitter {
  private buffer: AgentEvent[] = [];
  private target: { url: string; key: string } | null = null;
  private chain: Promise<void> = Promise.resolve();
  private warned = false;
  readonly history: AgentEvent[] = [];

  constructor(
    private readonly merchantUrl: string,
    private readonly relay: boolean,
    private readonly print: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  emit(draft: Draft): void {
    const parsed = AgentEvent.safeParse({ ...draft, at: draft.at ?? Date.now() });
    if (!parsed.success) {
      this.print(`[agent] dropped invalid ${String((draft as { t?: string }).t)} event: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      return;
    }
    const event = parsed.data;
    this.history.push(event);
    this.print(describe(event));
    if (!this.relay) return;
    if (this.target) this.enqueue([event]);
    else this.buffer.push(event);
  }

  attach(sessionId: string, merchantKey: string): void {
    this.target = { url: `${this.merchantUrl}/relay/${sessionId}`, key: merchantKey };
    const pending = this.buffer.splice(0);
    for (let i = 0; i < pending.length; i += 50) this.enqueue(pending.slice(i, i + 50));
  }

  async drain(): Promise<void> {
    await this.chain;
  }

  private enqueue(events: AgentEvent[]): void {
    const target = this.target;
    if (!target) return;
    this.chain = this.chain.then(async () => {
      try {
        const res = await fetch(target.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-merchant-key": target.key },
          body: JSON.stringify({ events }),
        });
        if (!res.ok && !this.warned) {
          this.warned = true;
          this.print(`[agent] relay refused events (${res.status}); continuing without the spectator stream`);
        }
      } catch {
        if (!this.warned) {
          this.warned = true;
          this.print("[agent] relay unreachable; continuing without the spectator stream");
        }
      }
    });
  }
}

function describe(event: AgentEvent): string {
  switch (event.t) {
    case "paybox.call":
      return `[paybox] -> ${event.tool}${event.note ? `  (${event.note})` : ""}`;
    case "paybox.envelope":
      return `[paybox] <- ${event.tool} ${event.status}${event.outputType ? ` ${event.outputType}` : ""}${event.approvalUrl ? `  approve: ${event.approvalUrl}` : ""}${event.message ? `  ${event.message}` : ""}`;
    case "agent.thought":
      return `[agent] ${event.text}`;
    case "account.change":
      return `[agent] needs access: ${event.note}\n        open: ${event.manageUrl}`;
    case "funds.buylink":
      return `[agent] fund the wallet: ${event.url}`;
    default:
      return `[agent] ${event.t}`;
  }
}
