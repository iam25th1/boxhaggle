import { createTimeline, utils, type Timeline } from "animejs";
import { motion } from "../app/motion";
import { h } from "../dom";
import { sound } from "./audio";

// Split-flap display. Each cell is four layers: static top and bottom halves,
// plus two leaves that fold over the hinge. A change runs one anime.js
// timeline: per cell, per step, the top leaf folds down (rotateX 0 to -90)
// and the bottom leaf lands (90 to 0). Steps are capped so a cell flips at
// most a few times, slower than 7 flips a second, and cells stagger left to right.

export const FLAP_CHARSET = " $0123456789.,:-ABCDEFGHIJKLMNOPQRSTUVWXYZ";

class FlapCell {
  readonly el: HTMLSpanElement;
  private readonly top: HTMLSpanElement;
  private readonly bottom: HTMLSpanElement;
  readonly leafTop: HTMLSpanElement;
  readonly leafBottom: HTMLSpanElement;
  /** The character this cell shows, or is flipping toward. */
  target = " ";

  constructor() {
    const ch = (): HTMLSpanElement => h("span", { class: "flap-ch" }, " ");
    this.top = h("span", { class: "flap-half flap-top" }, ch());
    this.bottom = h("span", { class: "flap-half flap-bottom" }, ch());
    this.leafTop = h("span", { class: "flap-half flap-leaf flap-top" }, ch());
    this.leafBottom = h("span", { class: "flap-half flap-leaf flap-bottom" }, ch());
    this.el = h("span", { class: "flap" }, this.top, this.bottom, this.leafTop, this.leafBottom);
    utils.set([this.leafTop, this.leafBottom], { opacity: 0 });
  }

  private write(half: HTMLSpanElement, char: string): void {
    const inner = half.firstElementChild;
    if (inner) inner.textContent = char === " " ? " " : char;
  }

  /** Show `char` everywhere at once and park the leaves. */
  settle(char: string): void {
    this.write(this.top, char);
    this.write(this.bottom, char);
    this.write(this.leafTop, char);
    this.write(this.leafBottom, char);
    utils.set([this.leafTop, this.leafBottom], { opacity: 0, rotateX: 0 });
    this.el.dataset.blank = char === " " ? "true" : "false";
  }

  /** Before a step: the new char waits behind, the old one sits on the top leaf. */
  prepare(from: string, to: string): void {
    this.write(this.top, to);
    this.write(this.bottom, from);
    this.write(this.leafTop, from);
    this.write(this.leafBottom, to);
    utils.set(this.leafTop, { opacity: 1, rotateX: 0 });
    utils.set(this.leafBottom, { opacity: 1, rotateX: 90 });
    this.el.dataset.blank = "false";
  }
}

export interface FlapBoardOptions {
  length: number;
  charset?: string;
  align?: "left" | "right";
  className?: string;
  /** Most flips a cell makes for one change. */
  maxSteps?: number;
  stepMs?: number;
  staggerMs?: number;
  /** Rattle sound on change. */
  audible?: boolean;
}

export class FlapBoard {
  readonly el: HTMLDivElement;
  private readonly cells: FlapCell[] = [];
  private readonly charset: string;
  private readonly opts: Required<Omit<FlapBoardOptions, "className" | "charset">>;
  private running: Timeline | null = null;
  text = "";

  constructor(options: FlapBoardOptions) {
    this.charset = options.charset ?? FLAP_CHARSET;
    this.opts = {
      length: options.length,
      align: options.align ?? "left",
      maxSteps: options.maxSteps ?? 3,
      stepMs: options.stepMs ?? 150,
      staggerMs: options.staggerMs ?? 55,
      audible: options.audible ?? false,
    };
    this.el = h("div", { class: `flapboard ${options.className ?? ""}`.trim(), "aria-hidden": "true" });
    for (let i = 0; i < options.length; i += 1) {
      const cell = new FlapCell();
      cell.settle(" ");
      this.cells.push(cell);
      this.el.append(cell.el);
    }
  }

  private fit(text: string): string {
    const upper = text.toUpperCase().slice(0, this.opts.length);
    return this.opts.align === "right" ? upper.padStart(this.opts.length, " ") : upper.padEnd(this.opts.length, " ");
  }

  private steps(from: string, to: string): string[] {
    if (from === to) return [];
    const n = this.charset.length;
    const a = Math.max(0, this.charset.indexOf(from));
    const b = this.charset.indexOf(to);
    if (b < 0) return [to];
    const distance = (b - a + n) % n;
    const count = Math.min(distance, this.opts.maxSteps);
    const out: string[] = [];
    for (let i = count - 1; i >= 0; i -= 1) out.push(this.charset[(b - i + n) % n] ?? to);
    return out;
  }

  /** Change the board. Resolves when every cell has landed. */
  set(text: string, instant = false): Promise<void> {
    const next = this.fit(text);
    this.text = next;
    if (this.running) {
      this.running.pause();
      this.running = null;
      for (const cell of this.cells) cell.settle(cell.target);
    }

    const plans = this.cells.map((cell, index) => {
      const from = cell.target;
      const to = next[index] ?? " ";
      cell.target = to;
      return { cell, from, path: this.steps(from, to) };
    });

    if (instant || motion.reduced) {
      for (const { cell } of plans) cell.settle(cell.target);
      return Promise.resolve();
    }
    if (plans.every((plan) => plan.path.length === 0)) return Promise.resolve();
    if (this.opts.audible) sound.flap();

    const { stepMs, staggerMs } = this.opts;
    const half = stepMs / 2;
    const tl = createTimeline({ autoplay: true });
    let order = 0;
    for (const { cell, from, path } of plans) {
      if (path.length === 0) continue;
      const start = order * staggerMs;
      order += 1;
      let prev = from;
      path.forEach((char, step) => {
        const t0 = start + step * stepMs;
        const was = prev;
        tl.call(() => cell.prepare(was, char), t0);
        tl.add(cell.leafTop, { rotateX: [0, -90], duration: half, ease: "in(2)" }, t0);
        tl.add(cell.leafBottom, { rotateX: [90, 0], duration: half, ease: "out(2)" }, t0 + half);
        prev = char;
      });
      tl.call(() => cell.settle(cell.target), start + path.length * stepMs);
    }
    this.running = tl;
    return tl.then(() => {
      if (this.running === tl) this.running = null;
    });
  }
}
