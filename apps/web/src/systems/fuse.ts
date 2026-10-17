import { animate, svg, utils, type JSAnimation } from "animejs";
import { clock } from "../app/clock";
import { motion } from "../app/motion";
import { h, s } from "../dom";

// Patience fuse along the counter edge. The unburnt cord is an anime.js
// drawable (draw "0 p"), the lit tip rides on top, and small sparks drift up
// from it. The tip glow breathes at well under 1 Hz: no flashing.

const W = 1000;
const Y = 14;

export class Fuse {
  readonly el: HTMLElement;
  private readonly cord: SVGLineElement & { setAttribute(name: string, value: string): void };
  private readonly twist: SVGLineElement;
  private readonly tip: HTMLElement;
  private readonly glow: HTMLElement;
  private readonly sparks: HTMLElement;
  private readonly value: HTMLElement;
  private readonly meter: HTMLElement;
  private patience = 100;
  private emitter: number | null = null;
  private glowAnim: JSAnimation | null = null;
  private alive = 0;

  constructor(mount: HTMLElement) {
    const burnt = s("line", { x1: 0, y1: Y, x2: W, y2: Y, class: "fuse-ash" });
    const cord = s("line", { x1: 0, y1: Y, x2: W, y2: Y, class: "fuse-cord" });
    const twist = s("line", { x1: 0, y1: Y, x2: W, y2: Y, class: "fuse-twist" });
    const art = s("svg", { class: "fuse-svg", viewBox: `0 0 ${W} 28`, preserveAspectRatio: "none", "aria-hidden": "true" }, burnt, cord, twist);
    this.glow = h("span", { class: "fuse-glow" });
    this.tip = h("span", { class: "fuse-tip", "aria-hidden": "true" }, this.glow, h("span", { class: "fuse-core" }));
    this.sparks = h("span", { class: "fuse-sparks", "aria-hidden": "true" });
    this.value = h("span", { class: "fuse-value" }, "100");
    this.meter = h(
      "div",
      { class: "fuse-meter", role: "meter", "aria-label": "Broker patience", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": 100 },
      h("span", { class: "fuse-label" }, "Patience"),
      this.value,
    );
    const track = h("div", { class: "fuse-track" }, art, this.sparks, this.tip);
    this.el = h("div", { class: "fuse" }, this.meter, h("span", { class: "fuse-end", "aria-hidden": "true" }, "Walks at 0"), track);
    mount.append(this.el);

    const [drawCord, drawTwist] = svg.createDrawable([cord, twist], 0, 1);
    this.cord = drawCord as unknown as SVGLineElement & { setAttribute(name: string, value: string): void };
    this.twist = (drawTwist ?? twist) as unknown as SVGLineElement;
    this.place(100, true);
    motion.onChange(() => this.syncIdle());
  }

  private place(p: number, instant: boolean): void {
    const frac = Math.max(0, Math.min(100, p)) / 100;
    if (instant || motion.reduced) {
      utils.set([this.cord, this.twist], { draw: `0 ${frac}` });
      utils.set(this.tip, { left: `${frac * 100}%` });
      return;
    }
    animate([this.cord, this.twist], { draw: `0 ${frac}`, duration: 1100, ease: "inOut(2)" });
    animate(this.tip, { left: `${frac * 100}%`, duration: 1100, ease: "inOut(2)" });
  }

  set(patience: number, instant = false): void {
    const prev = this.patience;
    this.patience = patience;
    this.place(patience, instant);
    this.meter.setAttribute("aria-valuenow", String(patience));
    this.el.dataset.level = patience < 25 ? "low" : patience < 50 ? "mid" : "high";
    if (instant || motion.reduced) {
      this.value.textContent = String(patience);
    } else {
      const counter = { v: prev };
      animate(counter, {
        v: patience,
        duration: 1100,
        ease: "inOut(2)",
        modifier: utils.round(0),
        onUpdate: () => {
          this.value.textContent = String(counter.v);
        },
      });
    }
    if (patience <= 0) this.extinguish();
  }

  /** Light the fuse: the glow breathes and sparks start to drift. */
  light(): void {
    this.el.dataset.lit = "true";
    this.syncIdle();
  }

  extinguish(): void {
    this.el.dataset.lit = "false";
    this.syncIdle();
  }

  reset(): void {
    this.extinguish();
    this.patience = 100;
    this.set(100, true);
  }

  private syncIdle(): void {
    clock.cancel(this.emitter);
    this.emitter = null;
    this.glowAnim?.revert();
    this.glowAnim = null;
    if (this.el.dataset.lit !== "true" || motion.reduced) return;
    this.glowAnim = animate(this.glow, {
      scale: [0.85, 1.15],
      opacity: [0.75, 1],
      duration: 1400,
      ease: "inOut(2)",
      loop: true,
      alternate: true,
    });
    this.emitter = clock.every(140, () => this.spark());
  }

  private spark(): void {
    if (this.alive > 14) return;
    const dot = h("span", { class: Math.random() < 0.35 ? "fuse-spark fuse-spark-paper" : "fuse-spark" });
    const left = this.tip.style.left || "100%";
    dot.style.left = left;
    this.sparks.append(dot);
    this.alive += 1;
    const angle = (-90 + (Math.random() * 110 - 55)) * (Math.PI / 180);
    const dist = 14 + Math.random() * 22;
    animate(dot, {
      translateX: [0, Math.cos(angle) * dist],
      translateY: [0, Math.sin(angle) * dist],
      opacity: [1, 0],
      scale: [1, 0.4],
      duration: 620 + Math.random() * 360,
      ease: "out(2)",
      onComplete: () => {
        dot.remove();
        this.alive -= 1;
      },
    });
  }
}
