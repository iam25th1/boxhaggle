import { animate, createTimeline } from "animejs";
import { motion } from "../app/motion";
import { h } from "../dom";

// The agent's ledger: its reasoning, one ruled line per thought, newest on
// top. Each entry rules its line first, then writes.

export class Ledger {
  readonly el: HTMLElement;
  private readonly list: HTMLOListElement;
  private readonly empty: HTMLElement;
  private count = 0;

  constructor(mount: HTMLElement) {
    this.list = h("ol", { class: "ledger-list", reversed: true });
    this.empty = h("p", { class: "ledger-empty" }, "The agent has not written anything yet.");
    this.el = h(
      "section",
      { class: "ledger panel-paper", "aria-labelledby": "ledger-title" },
      h("h2", { id: "ledger-title", class: "panel-title" }, "Agent's ledger"),
      this.empty,
      this.list,
    );
    mount.append(this.el);
  }

  reset(): void {
    this.count = 0;
    this.list.replaceChildren();
    this.empty.hidden = false;
  }

  write(text: string, tag: string): void {
    this.count += 1;
    this.empty.hidden = true;
    const rule = h("span", { class: "ledger-rule", "aria-hidden": "true" });
    const body = h("span", { class: "ledger-text" }, text);
    const item = h("li", { class: "ledger-entry" }, h("span", { class: "ledger-tag" }, tag), body, rule);
    this.list.prepend(item);
    while (this.list.children.length > 14) this.list.lastElementChild?.remove();
    if (motion.reduced) {
      animate(item, { opacity: [0, 1], duration: 160, ease: "linear" });
      return;
    }
    const tl = createTimeline({ defaults: { ease: "out(3)" } });
    tl.add(item, { opacity: [0, 1], duration: 120, ease: "linear" }, 0)
      .add(rule, { scaleX: [0, 1], duration: 420 }, 0)
      .add(body, { opacity: [0, 1], translateX: [-6, 0], duration: 360 }, 200);
  }
}
