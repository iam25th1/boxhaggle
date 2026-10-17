import { animate, utils } from "animejs";
import { formatUsdPrecise } from "@boxhaggle/core";
import { clock } from "../app/clock";
import { motion } from "../app/motion";
import { h } from "../dom";
import { sound } from "./audio";

// Coin tray. Every haggling fee drops in as a coin and stacks; stacks fill
// left to right, eight coins high.

const PER_STACK = 8;
const STACKS = 4;

export class CoinTray {
  readonly el: HTMLElement;
  private readonly stacks: HTMLElement[] = [];
  private readonly total: HTMLElement;
  private coins = 0;
  private sum = 0;

  constructor(mount: HTMLElement) {
    this.total = h("p", { class: "tray-total" }, "$0.00");
    const bed = h("div", { class: "tray-bed", "aria-hidden": "true" });
    for (let i = 0; i < STACKS; i += 1) {
      const stack = h("div", { class: "tray-stack" });
      this.stacks.push(stack);
      bed.append(stack);
    }
    this.el = h(
      "div",
      { class: "tray", role: "group", "aria-label": "Fee tray" },
      h("p", { class: "tray-label" }, "Fees paid"),
      this.total,
      h("div", { class: "tray-box" }, bed, h("span", { class: "tray-lip", "aria-hidden": "true" })),
    );
    mount.append(this.el);
  }

  reset(): void {
    this.coins = 0;
    this.sum = 0;
    for (const stack of this.stacks) stack.replaceChildren();
    this.total.textContent = "$0.00";
  }

  drop(fee: number): void {
    const index = this.coins;
    this.coins += 1;
    this.sum += fee;
    this.total.textContent = formatUsdPrecise(this.sum);
    const stack = this.stacks[Math.floor(index / PER_STACK) % STACKS];
    if (!stack) return;
    if (index >= PER_STACK * STACKS) return;
    const coin = h("span", { class: "coin" }, h("span", { class: "coin-face" }));
    stack.append(coin);

    if (motion.reduced) {
      utils.set(coin, { opacity: 0 });
      animate(coin, { opacity: 1, duration: 180, ease: "linear" });
      return;
    }
    const tilt = (index % 2 === 0 ? 1 : -1) * (2 + (index % 3));
    utils.set(coin, { opacity: 0 });
    animate(coin, {
      translateY: [-150, 0],
      rotate: [tilt * 6, 0],
      opacity: { to: 1, duration: 80, ease: "linear" },
      duration: 640,
      ease: "outBounce",
    });
    clock.after(300, () => sound.coin());
  }
}
