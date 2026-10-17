import { animate, utils } from "animejs";
import { formatUsd } from "@boxhaggle/core";
import { motion } from "../app/motion";
import { h } from "../dom";
import { FlapBoard } from "./flap";

// The price board above the Broker: the item name on a small split-flap row
// and the ask on a large one. Every ask change flips per character.

export class PriceBoard {
  readonly el: HTMLElement;
  private readonly nameRow = new FlapBoard({ length: 20, className: "flap-sm", maxSteps: 2, stepMs: 120, staggerMs: 18 });
  private readonly priceRow = new FlapBoard({ length: 6, align: "right", className: "flap-lg", maxSteps: 3, stepMs: 170, staggerMs: 70, audible: true });
  private readonly delta: HTMLElement;
  private readonly list: HTMLElement;
  private readonly spoken: HTMLElement;
  private readonly soldTag: HTMLElement;
  private ask: number | null = null;

  constructor(mount: HTMLElement) {
    this.delta = h("p", { class: "pb-delta", "data-kind": "none" });
    this.list = h("p", { class: "pb-list" });
    this.spoken = h("p", { class: "sr-only" });
    this.soldTag = h("p", { class: "pb-sold", "aria-hidden": "true" }, "Sold");
    this.el = h(
      "section",
      { class: "priceboard", "aria-label": "Price board" },
      h("div", { class: "pb-frame" },
        h("div", { class: "pb-name" }, this.nameRow.el),
        h("div", { class: "pb-price" }, h("span", { class: "pb-label" }, "Ask"), this.priceRow.el, this.soldTag),
      ),
      h("div", { class: "pb-foot" }, this.list, this.delta),
      this.spoken,
    );
    mount.append(this.el);
    this.reset();
  }

  reset(): void {
    this.ask = null;
    void this.nameRow.set("THE BROKERS COUNTER", true);
    void this.priceRow.set("", true);
    this.list.textContent = "";
    this.delta.textContent = "";
    this.delta.dataset.kind = "none";
    this.spoken.textContent = "";
    utils.set(this.soldTag, { opacity: 0 });
  }

  open(itemName: string, listPrice: number, ask: number): void {
    void this.nameRow.set(itemName);
    this.list.textContent = `List ${formatUsd(listPrice)}`;
    this.setAsk(ask);
  }

  setAsk(ask: number, previous?: number): void {
    const text = formatUsd(ask);
    void this.priceRow.set(text);
    this.spoken.textContent = `Ask ${text}`;
    const before = previous ?? this.ask;
    this.ask = ask;
    if (before === null || before === undefined) return;
    const diff = before - ask;
    if (diff > 0) {
      this.delta.textContent = `Down ${formatUsd(diff)} from ${formatUsd(before)}`;
      this.delta.dataset.kind = "down";
    } else {
      this.delta.textContent = `Held at ${text}`;
      this.delta.dataset.kind = "held";
    }
    if (!motion.reduced) animate(this.delta, { opacity: [0, 1], translateY: [-6, 0], duration: 320, delay: 380, ease: "out(2)" });
  }

  sold(price: number): void {
    void this.priceRow.set(formatUsd(price));
    this.delta.textContent = `Sold at ${formatUsd(price)}`;
    this.delta.dataset.kind = "sold";
    if (motion.reduced) {
      utils.set(this.soldTag, { opacity: 1 });
      return;
    }
    animate(this.soldTag, { opacity: [0, 1], scale: [1.6, 1], rotate: [-14, -8], duration: 260, delay: 520, ease: "out(4)" });
  }
}
