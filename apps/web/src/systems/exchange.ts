import { animate, createTimeline, stagger, utils } from "animejs";
import type { EnvelopeStatus } from "@boxhaggle/core";
import { motion } from "../app/motion";
import { h } from "../dom";
import { FlapBoard } from "./flap";

// Two boards for the swap. The exchange board shows the token pair on tiles
// that rotate from the source token to the destination token when the swap
// clears. The departures board tracks a cross-chain bridge: a split-flap
// status column and a marker crossing from one chain to the other.

export function chainName(chain: string): string {
  if (chain.startsWith("solana")) return "Solana";
  if (chain === "eip155:8453" || chain === "base") return "Base";
  const named: Record<string, string> = { "eip155:1": "Ethereum", "eip155:137": "Polygon", "eip155:42161": "Arbitrum", "eip155:10": "Optimism" };
  if (named[chain]) return named[chain];
  if (chain.startsWith("eip155:")) return `Chain ${chain.slice(7)}`;
  return chain;
}

const DECIMALS: Record<string, number> = { USDC: 6, SOL: 9, ETH: 18 };

/** Raw smallest-unit integers from the agent become readable amounts; preformatted strings pass through. */
export function formatAmount(amount: string, symbol: string): string {
  const decimals = DECIMALS[symbol.toUpperCase()];
  if (!/^[0-9]+$/.test(amount) || decimals === undefined) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "").slice(0, 4);
  return `${whole}${fraction ? `.${fraction}` : ""} ${symbol}`;
}

class TileRow {
  readonly el: HTMLElement;
  private readonly inners: HTMLElement[] = [];
  private readonly fronts: HTMLElement[] = [];
  private readonly backs: HTMLElement[] = [];

  constructor(private readonly length: number) {
    this.el = h("span", { class: "tiles", "aria-hidden": "true" });
    for (let i = 0; i < length; i += 1) {
      const front = h("span", { class: "tile-face tile-front" });
      const back = h("span", { class: "tile-face tile-back" });
      const inner = h("span", { class: "tile-inner" }, front, back);
      this.inners.push(inner);
      this.fronts.push(front);
      this.backs.push(back);
      this.el.append(h("span", { class: "tile" }, inner));
    }
  }

  private fit(text: string): string {
    return text.toUpperCase().slice(0, this.length).padEnd(this.length, " ");
  }

  show(text: string): void {
    const t = this.fit(text);
    this.fronts.forEach((face, i) => (face.textContent = t[i] === " " ? " " : (t[i] ?? "")));
    utils.set(this.inners, { rotateY: 0 });
  }

  /** Rotate every tile a half turn to reveal `text` on the back faces. */
  rotateTo(text: string, delay = 0): Promise<void> {
    const t = this.fit(text);
    this.backs.forEach((face, i) => (face.textContent = t[i] === " " ? " " : (t[i] ?? "")));
    if (motion.reduced) {
      this.show(text);
      return Promise.resolve();
    }
    const tl = createTimeline();
    tl.add(this.inners, { rotateY: [0, 180], duration: 520, delay: stagger(70, { start: delay }), ease: "inOut(3)" }, 0);
    return tl.then(() => this.show(text));
  }
}

export class ExchangeBoard {
  readonly el: HTMLElement;
  private readonly symbol = new TileRow(5);
  private readonly chain = new TileRow(8);
  private readonly amount: HTMLElement;
  private readonly status: HTMLElement;
  private readonly pair: HTMLElement;
  private to: { symbol: string; chain: string } | null = null;

  constructor(mount: HTMLElement) {
    this.amount = h("p", { class: "ex-amount" });
    this.status = h("p", { class: "ex-status", "aria-live": "polite" });
    this.pair = h("p", { class: "sr-only" });
    this.el = h(
      "section",
      { class: "exchange panel-ink", "aria-labelledby": "ex-title", hidden: true },
      h("h2", { id: "ex-title", class: "panel-title panel-title-ink" }, "Exchange"),
      h("div", { class: "ex-board" },
        h("div", { class: "ex-row" }, h("span", { class: "ex-cap" }, "Token"), this.symbol.el),
        h("div", { class: "ex-row" }, h("span", { class: "ex-cap" }, "Chain"), this.chain.el),
      ),
      h("div", { class: "ex-foot" }, this.amount, this.status),
      this.pair,
    );
    mount.append(this.el);
  }

  reset(): void {
    this.el.hidden = true;
    this.to = null;
  }

  quote(fromSymbol: string, fromChain: string, toSymbol: string, toChain: string, amountIn: string): void {
    this.el.hidden = false;
    this.symbol.show(fromSymbol);
    this.chain.show(chainName(fromChain));
    this.to = { symbol: toSymbol, chain: chainName(toChain) };
    this.amount.textContent = `${formatAmount(amountIn, fromSymbol)} in, for ${toSymbol} on ${chainName(toChain)}`;
    this.status.textContent = "Quoted";
    this.status.dataset.status = "quoted";
    this.pair.textContent = `Swap ${fromSymbol} on ${chainName(fromChain)} to ${toSymbol} on ${chainName(toChain)}.`;
    if (!motion.reduced) animate(this.el, { opacity: [0, 1], translateY: [12, 0], duration: 380, ease: "out(3)" });
  }

  update(status: EnvelopeStatus): void {
    const labels: Partial<Record<EnvelopeStatus, string>> = {
      pending_signature: "Signing",
      pending_settlement: "Bridging",
      pending_confirmation: "Confirming",
      pending_approval: "Waiting for approval",
      pending_funding: "Needs funding",
      success: "Swapped",
      denied: "Denied",
      error: "Failed",
    };
    this.status.textContent = labels[status] ?? status;
    this.status.dataset.status = status;
    if (status === "success" && this.to) {
      void this.symbol.rotateTo(this.to.symbol);
      void this.chain.rotateTo(this.to.chain, 180);
    }
  }
}

const DEPARTURE_STATUS: Partial<Record<EnvelopeStatus | "quoted", string>> = {
  quoted: "CHECK IN",
  pending_signature: "BOARDING",
  pending_approval: "HELD",
  pending_settlement: "IN TRANSIT",
  pending_confirmation: "LANDING",
  success: "ARRIVED",
  denied: "CANCELLED",
  error: "CANCELLED",
};

const MARKER_AT: Partial<Record<EnvelopeStatus | "quoted", number>> = {
  quoted: 0,
  pending_signature: 6,
  pending_settlement: 64,
  pending_confirmation: 88,
  success: 100,
};

export class DeparturesBoard {
  readonly el: HTMLElement;
  private readonly statusFlap = new FlapBoard({ length: 10, className: "flap-xs", maxSteps: 3, stepMs: 130, staggerMs: 30 });
  private readonly time: HTMLElement;
  private readonly from: HTMLElement;
  private readonly to: HTMLElement;
  private readonly req: HTMLElement;
  private readonly marker: HTMLElement;
  private readonly spoken: HTMLElement;

  constructor(mount: HTMLElement) {
    this.time = h("span", { class: "dep-cell" });
    this.from = h("span", { class: "dep-cell" });
    this.to = h("span", { class: "dep-cell" });
    this.req = h("span", { class: "dep-cell dep-req" });
    this.marker = h("span", { class: "dep-marker" });
    this.spoken = h("p", { class: "sr-only", "aria-live": "polite" });
    this.el = h(
      "section",
      { class: "departures panel-ink", "aria-labelledby": "dep-title", hidden: true },
      h("h2", { id: "dep-title", class: "panel-title panel-title-ink" }, "Bridge departures"),
      h("div", { class: "dep-table", role: "table", "aria-label": "Bridge transfer" },
        h("div", { class: "dep-head", role: "row" },
          h("span", { role: "columnheader" }, "Time"),
          h("span", { role: "columnheader" }, "From"),
          h("span", { role: "columnheader" }, "To")),
        h("div", { class: "dep-row", role: "row" },
          h("span", { role: "cell" }, this.time),
          h("span", { role: "cell" }, this.from),
          h("span", { role: "cell" }, this.to)),
        h("div", { class: "dep-status-row", role: "row" },
          h("span", { role: "rowheader", class: "dep-status-cap" }, "Status"),
          h("span", { role: "cell", class: "dep-status" }, this.statusFlap.el)),
      ),
      h("div", { class: "dep-track", "aria-hidden": "true" },
        h("span", { class: "dep-node dep-node-a" }),
        h("span", { class: "dep-line" }),
        this.marker,
        h("span", { class: "dep-node dep-node-b" })),
      h("p", { class: "dep-foot" }, this.req),
      this.spoken,
    );
    mount.append(this.el);
  }

  reset(): void {
    this.el.hidden = true;
    void this.statusFlap.set("", true);
    utils.set(this.marker, { left: "0%" });
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  schedule(at: number, fromChain: string, toChain: string): void {
    const t = new Date(at);
    this.time.textContent = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    this.from.textContent = chainName(fromChain);
    this.to.textContent = chainName(toChain);
    this.el.hidden = false;
    this.status("quoted");
    if (!motion.reduced) animate(this.el, { opacity: [0, 1], translateY: [12, 0], duration: 380, ease: "out(3)" });
  }

  status(status: EnvelopeStatus | "quoted", requestId?: string): void {
    const word = DEPARTURE_STATUS[status] ?? status.toUpperCase();
    void this.statusFlap.set(word);
    this.el.dataset.status = status;
    if (requestId) this.req.textContent = `Request ${requestId}`;
    this.spoken.textContent = `Bridge: ${word.toLowerCase()}.`;
    const pos = MARKER_AT[status];
    if (pos === undefined) return;
    if (motion.reduced) {
      utils.set(this.marker, { left: `${pos}%` });
      return;
    }
    const duration = status === "pending_settlement" ? 3200 : 700;
    animate(this.marker, { left: `${pos}%`, duration, ease: status === "pending_settlement" ? "inOut(2)" : "out(3)" });
  }
}
