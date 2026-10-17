import { animate, createTimeline, stagger, utils } from "animejs";
import { formatUsd, formatUsdPrecise } from "@boxhaggle/core";
import { motion } from "../app/motion";
import { h } from "../dom";

// The final scorecard: price paid, fees, savings against list and the score
// S = P_final + sum of fees (lower is better). "Save PNG" redraws the card on
// a canvas by hand, after the web fonts are ready, and downloads it.

export interface ScoreView {
  itemName: string;
  listPrice: number;
  finalPrice: number | null;
  fees: number;
  rounds: number;
  score: number | null;
  savings: number | null;
  floor: number | null;
  verified: boolean | null;
  mode: "replay" | "live";
}

const C = {
  ink: "#121212",
  wood: "#3A2A1E",
  paper: "#F2EBDD",
  orange: "#FF5A1F",
  green: "#1F7A4D",
  red: "#C2362B",
  grey: "#8A867E",
};

const DISPLAY = '"Big Shoulders Display", "Arial Narrow", sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, monospace';

export class Scorecard {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly status: HTMLElement;
  private view: ScoreView | null = null;
  readonly saveButton: HTMLButtonElement;
  readonly againButton: HTMLButtonElement;
  readonly pickButton: HTMLButtonElement;

  constructor(mount: HTMLElement) {
    this.body = h("div", { class: "sc-body" });
    this.saveButton = h("button", { type: "button", class: "btn btn-ink" }, "Save PNG");
    this.againButton = h("button", { type: "button", class: "btn btn-signal" }, "Run it again");
    this.pickButton = h("button", { type: "button", class: "btn btn-ghost-ink" }, "Pick another item");
    this.status = h("p", { class: "sc-status", "aria-live": "polite" });
    this.actions = h("div", { class: "sc-actions" }, this.againButton, this.saveButton, this.pickButton);
    this.el = h(
      "section",
      { class: "scorecard panel-paper", "aria-labelledby": "sc-title" },
      h("h2", { id: "sc-title", class: "sc-title" }, "Scorecard"),
      this.body,
      this.actions,
      this.status,
    );
    mount.append(this.el);
    this.saveButton.addEventListener("click", () => void this.savePng());
  }

  reset(): void {
    this.body.replaceChildren();
    this.status.textContent = "";
    this.view = null;
  }

  show(view: ScoreView): void {
    this.view = view;
    const deal = view.finalPrice !== null && view.score !== null;
    const big = h("p", { class: "sc-score" }, deal ? formatUsd(0) : "No deal");
    const rows: Array<[string, string, string?]> = [
      ["List price", formatUsd(view.listPrice)],
      ["Price paid", deal ? formatUsd(view.finalPrice ?? 0) : "None"],
      [`Fees, ${view.rounds} round${view.rounds === 1 ? "" : "s"}`, formatUsdPrecise(view.fees)],
    ];
    if (deal) {
      const savings = view.savings ?? 0;
      rows.push(["Saved against list", formatUsd(savings), savings >= 0 ? "good" : "bad"]);
    }
    if (view.floor !== null) rows.push(["Broker's floor", formatUsd(view.floor)]);
    const rowEls = rows.map(([k, v, tone]) => h("div", { class: "sc-row", "data-tone": tone ?? "" }, h("dt", {}, k), h("dd", {}, v)));
    this.body.replaceChildren(
      h("p", { class: "sc-item" }, view.itemName),
      h("div", { class: "sc-hero" },
        h("p", { class: "sc-hero-label" }, "Score"),
        big,
        h("p", { class: "sc-formula" }, "S = price paid + every fee. Lower wins.")),
      h("dl", { class: "sc-rows" }, ...rowEls),
    );
    if (view.verified !== null) {
      this.body.append(
        h("p", { class: `sc-verify sc-verify-${view.verified ? "ok" : "bad"}` }, view.verified ? "Floor verified in this browser" : "Floor check failed"),
      );
    }

    if (!deal) {
      big.textContent = "No deal";
    } else if (motion.reduced) {
      big.textContent = formatUsd(view.score ?? 0);
    } else {
      const counter = { v: 0 };
      animate(counter, {
        v: view.score ?? 0,
        duration: 1200,
        delay: 500,
        ease: "out(3)",
        onUpdate: () => {
          big.textContent = formatUsd(Math.round(counter.v));
        },
      });
    }

    if (motion.reduced) {
      animate(this.el, { opacity: [0, 1], duration: 200, ease: "linear" });
      return;
    }
    utils.set(rowEls, { opacity: 0 });
    createTimeline({ defaults: { ease: "out(3)" } })
      .add(this.el, { opacity: [0, 1], translateY: [40, 0], rotate: [3, -1], duration: 620 }, 0)
      .add(rowEls, { opacity: [0, 1], translateX: [-10, 0], duration: 320, delay: stagger(90) }, 380)
      .add(this.actions, { opacity: [0, 1], duration: 300 }, 900);
  }

  private async savePng(): Promise<void> {
    const view = this.view;
    if (!view) return;
    this.status.textContent = "Drawing the card...";
    try {
      await Promise.all([
        document.fonts.load(`900 120px ${DISPLAY}`),
        document.fonts.load(`700 40px ${DISPLAY}`),
        document.fonts.load(`400 22px ${MONO}`),
        document.fonts.load(`600 22px ${MONO}`),
      ]).catch(() => undefined);
      await document.fonts.ready;
      const blob = await renderCard(view);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `boxhaggle-${view.itemName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`;
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      this.status.textContent = "Saved the scorecard as a PNG.";
    } catch {
      this.status.textContent = "Could not draw the PNG in this browser.";
    }
  }
}

function renderCard(view: ScoreView): Promise<Blob> {
  const W = 1200;
  const H = 675;
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("no 2d context"));
  ctx.scale(scale, scale);

  // Ink wall, wood counter, paper card.
  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.wood;
  ctx.fillRect(0, H - 120, W, 120);
  ctx.fillStyle = C.ink;
  for (let y = H - 110; y < H; y += 9) ctx.fillRect(0, y, W, 1);
  ctx.fillStyle = C.orange;
  ctx.fillRect(0, H - 124, W, 4);

  ctx.save();
  ctx.translate(90, 70);
  ctx.rotate((-1.2 * Math.PI) / 180);
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, 640, 520);
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, 640, 520);

  ctx.fillStyle = C.ink;
  ctx.textBaseline = "alphabetic";
  ctx.font = `900 34px ${DISPLAY}`;
  ctx.fillText("BOXHAGGLE SCORECARD", 36, 58);
  ctx.font = `500 20px ${MONO}`;
  ctx.fillText(view.itemName, 36, 92);
  ctx.fillRect(36, 110, 568, 3);

  const deal = view.finalPrice !== null && view.score !== null;
  ctx.font = `600 18px ${MONO}`;
  ctx.fillText("SCORE", 36, 150);
  ctx.font = `900 120px ${DISPLAY}`;
  ctx.fillText(deal ? formatUsd(view.score ?? 0) : "NO DEAL", 30, 284);
  ctx.font = `400 17px ${MONO}`;
  ctx.fillText("S = price paid + every fee. Lower wins.", 36, 316);

  const rows: Array<[string, string]> = [
    ["List price", formatUsd(view.listPrice)],
    ["Price paid", deal ? formatUsd(view.finalPrice ?? 0) : "None"],
    [`Fees (${view.rounds} rounds)`, formatUsdPrecise(view.fees)],
  ];
  if (deal) rows.push(["Saved against list", formatUsd(view.savings ?? 0)]);
  let y = 362;
  for (const [k, v] of rows) {
    ctx.font = `400 20px ${MONO}`;
    ctx.fillStyle = C.ink;
    ctx.fillText(k, 36, y);
    ctx.font = `600 20px ${MONO}`;
    const w = ctx.measureText(v).width;
    ctx.fillText(v, 604 - w, y);
    ctx.fillStyle = C.grey;
    ctx.fillRect(36, y + 10, 568, 1);
    y += 36;
  }
  ctx.restore();

  // Right side: verdict stamp and floor.
  ctx.save();
  ctx.translate(800, 150);
  ctx.rotate((-7 * Math.PI) / 180);
  const verified = view.verified === true;
  const stampColour = view.verified === null ? C.grey : verified ? C.green : C.red;
  ctx.strokeStyle = stampColour;
  ctx.lineWidth = 6;
  ctx.strokeRect(0, 0, 320, 110);
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, 300, 90);
  ctx.fillStyle = stampColour;
  ctx.font = `900 64px ${DISPLAY}`;
  const word = view.verified === null ? "UNSEALED" : verified ? "VERIFIED" : "MISMATCH";
  const ww = ctx.measureText(word).width;
  ctx.fillText(word, 160 - ww / 2, 78);
  ctx.restore();

  ctx.fillStyle = C.paper;
  ctx.font = `600 18px ${MONO}`;
  ctx.fillText("FLOOR, REVEALED", 812, 340);
  ctx.font = `900 72px ${DISPLAY}`;
  ctx.fillText(view.floor !== null ? formatUsd(view.floor) : "SEALED", 806, 410);
  ctx.font = `400 16px ${MONO}`;
  ctx.fillStyle = C.paper;
  ctx.fillText("Commitment checked with SHA-256", 812, 444);
  ctx.fillText("in the spectator's browser.", 812, 466);

  ctx.fillStyle = C.paper;
  ctx.font = `700 26px ${DISPLAY}`;
  ctx.fillText("x402 rounds, settled through PayBox", 90, H - 52);
  ctx.fillStyle = C.orange;
  ctx.fillRect(W - 230, H - 86, 150, 44);
  ctx.fillStyle = C.ink;
  ctx.font = `900 28px ${DISPLAY}`;
  const tag = view.mode === "replay" ? "REPLAY" : "LIVE";
  const tw = ctx.measureText(tag).width;
  ctx.fillText(tag, W - 155 - tw / 2, H - 54);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png");
  });
}
