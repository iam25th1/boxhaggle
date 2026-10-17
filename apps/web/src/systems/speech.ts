import { animate, stagger } from "animejs";
import type { Mood } from "@boxhaggle/core";
import { motion } from "../app/motion";
import { h } from "../dom";

// The Broker's speech bubble. Words land one after another; the bubble takes
// the mood's colour. Every line is mirrored to an aria-live region.

export class Speech {
  readonly el: HTMLElement;
  private readonly text: HTMLElement;
  private readonly who: HTMLElement;
  private readonly live: HTMLElement;

  constructor(mount: HTMLElement, live: HTMLElement) {
    this.text = h("p", { class: "speech-text" });
    this.who = h("p", { class: "speech-who" }, "The Broker");
    this.el = h("figure", { class: "speech", "data-mood": "calm", "data-empty": "true" },
      h("blockquote", { class: "speech-quote" }, this.text),
      h("figcaption", {}, this.who),
      h("span", { class: "speech-tail", "aria-hidden": "true" }));
    this.live = live;
    mount.append(this.el);
  }

  reset(): void {
    this.text.replaceChildren();
    this.el.dataset.empty = "true";
    this.el.dataset.mood = "calm";
    this.live.textContent = "";
  }

  say(line: string, mood: Mood | "walk" = "calm"): void {
    this.el.dataset.mood = mood;
    this.el.dataset.empty = "false";
    this.live.textContent = `The Broker: ${line}`;
    const words = line.split(/\s+/).filter(Boolean);
    const spans = words.map((word) => h("span", { class: "w" }, word));
    this.text.replaceChildren();
    spans.forEach((span, i) => {
      this.text.append(span);
      if (i < spans.length - 1) this.text.append(" ");
    });
    if (motion.reduced) {
      animate(this.el, { opacity: [0.4, 1], duration: 160, ease: "linear" });
      return;
    }
    animate(this.el, { scale: [0.96, 1], duration: 260, ease: "out(3)" });
    animate(spans, {
      opacity: [0, 1],
      translateY: [5, 0],
      duration: 220,
      delay: stagger(55),
      ease: "out(2)",
    });
  }
}
