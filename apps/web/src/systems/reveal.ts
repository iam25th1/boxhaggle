import { animate, createTimeline, stagger, utils } from "animejs";
import { formatUsd, verifyReveal } from "@boxhaggle/core";
import { motion } from "../app/motion";
import { h, s } from "../dom";
import { sound } from "./audio";

// The reveal. A sealed envelope carries the commitment published when the
// session opened. Its strip tears off, the floor card slides out, and this
// browser recomputes SHA-256(floor | salt) with the same core code the
// merchant uses. VERIFIED only on a real match; anything else is MISMATCH.

export interface RevealResult {
  verified: boolean;
  recomputed: string | null;
}

function groups(hex: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < hex.length; i += 16) out.push(hex.slice(i, i + 16));
  return out;
}

export class Reveal {
  readonly el: HTMLElement;
  private readonly front: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly card: HTMLElement;
  private readonly floor: HTMLElement;
  private readonly salt: HTMLElement;
  private readonly hash: HTMLElement;
  private readonly check: HTMLElement;
  private readonly checkHash: HTMLElement;
  private readonly verdict: HTMLElement;
  private readonly note: HTMLElement;
  private readonly live: HTMLElement;

  constructor(mount: HTMLElement) {
    this.hash = h("code", { class: "env-hash" });
    this.front = h("div", { class: "env-front" },
      h("p", { class: "env-label" }, "Sealed floor"),
      this.hash,
      h("span", { class: "env-seal", "aria-hidden": "true" }, "B"));
    const zig = s("svg", { class: "env-zig", viewBox: "0 0 200 10", preserveAspectRatio: "none", "aria-hidden": "true" },
      s("path", { d: "M0 0 H200 V4 L190 10 L180 4 L170 10 L160 4 L150 10 L140 4 L130 10 L120 4 L110 10 L100 4 L90 10 L80 4 L70 10 L60 4 L50 10 L40 4 L30 10 L20 4 L10 10 L0 4 Z" }));
    this.strip = h("div", { class: "env-strip" }, h("span", { class: "env-strip-text" }, "Tear here after the sale"), zig);
    this.floor = h("p", { class: "env-floor" });
    this.salt = h("p", { class: "env-salt" });
    this.card = h("div", { class: "env-card" }, h("p", { class: "env-card-label" }, "The Broker's floor"), this.floor, this.salt);
    this.checkHash = h("code", { class: "check-hash", "aria-hidden": "true" });
    this.verdict = h("p", { class: "stamp verdict", role: "img" }, h("span", {}, ""));
    this.note = h("p", { class: "check-note" });
    this.live = h("p", { class: "sr-only", "aria-live": "polite" });
    this.check = h("div", { class: "check" },
      h("p", { class: "check-title" }, "SHA-256 of floor and salt, computed in this browser"),
      this.checkHash,
      this.note,
      h("div", { class: "check-stamp" }, this.verdict));
    this.el = h(
      "section",
      { class: "reveal panel-ink", "aria-labelledby": "reveal-title" },
      h("h2", { id: "reveal-title", class: "panel-title panel-title-ink" }, "Commit and reveal"),
      h("div", { class: "env", role: "group", "aria-label": "Sealed envelope" },
        h("div", { class: "env-back", "aria-hidden": "true" }), this.card, this.front, this.strip),
      this.check,
      this.live,
    );
    mount.append(this.el);
    this.reset();
  }

  reset(): void {
    this.hash.textContent = "";
    this.floor.textContent = "";
    this.salt.textContent = "";
    this.checkHash.replaceChildren();
    this.note.textContent = "";
    this.verdict.dataset.result = "none";
    utils.set(this.verdict, { opacity: 0 });
    utils.set(this.strip, { opacity: 1, translateX: 0, translateY: 0, rotate: 0 });
    utils.set(this.card, { translateY: "0%" });
    utils.set(this.check, { opacity: 0 });
  }

  /** Show the sealed envelope with the commitment from session.opened. */
  seal(commitment: string): void {
    this.hash.replaceChildren(...groups(commitment).map((g) => h("span", {}, g)));
  }

  open(published: string | null, ev: { floor: number; salt: string; commitment: string }): RevealResult {
    const reference = published ?? ev.commitment;
    this.seal(reference);
    const check = verifyReveal(reference, ev.floor, ev.salt);
    const sameAsPublished = published === null || published === ev.commitment.toLowerCase();
    const verified = check.verified && sameAsPublished;
    const recomputed = check.recomputed ?? "".padEnd(64, "?");

    this.floor.textContent = formatUsd(ev.floor);
    this.salt.textContent = `salt ${ev.salt.slice(0, 12)}...${ev.salt.slice(-6)}`;
    const chars = Array.from(recomputed).map((c, i) => {
      const ok = reference[i] === c;
      return h("span", { class: "hc", "data-match": ok ? "yes" : "no" }, c);
    });
    const lines: HTMLElement[] = [];
    for (let i = 0; i < chars.length; i += 16) lines.push(h("span", { class: "hc-line" }, ...chars.slice(i, i + 16)));
    this.checkHash.replaceChildren(...lines);
    this.verdict.dataset.result = verified ? "verified" : "mismatch";
    const word = verified ? "Verified" : "Mismatch";
    (this.verdict.firstElementChild as HTMLElement).textContent = word;
    this.verdict.setAttribute("aria-label", word);
    this.note.textContent = verified
      ? "Every character matches the commitment published before the first offer. The floor never moved."
      : !sameAsPublished
        ? "The revealed commitment differs from the one published at the start."
        : `The recomputed hash does not match${check.reason ? `: ${check.reason}` : ""}.`;
    this.live.textContent = `Floor revealed: ${formatUsd(ev.floor)}. Hash check ${word.toLowerCase()}.`;

    if (motion.reduced) {
      utils.set(this.strip, { opacity: 0 });
      utils.set(this.card, { translateY: "-58%" });
      createTimeline()
        .add(this.check, { opacity: [0, 1], duration: 200, ease: "linear" }, 0)
        .add(this.verdict, { opacity: [0, 1], duration: 200, ease: "linear" }, 200);
      return { verified, recomputed: check.recomputed };
    }

    utils.set(chars, { opacity: 0 });
    const tl = createTimeline({ defaults: { ease: "out(3)" } });
    tl.add(this.strip, { translateY: [0, -26], translateX: [0, 60], rotate: [0, 9], duration: 620, ease: "in(2)" }, 400)
      .add(this.strip, { opacity: [1, 0], duration: 260, ease: "linear" }, 760)
      .add(this.card, { translateY: ["0%", "-58%"], duration: 900, ease: "inOut(3)" }, 1100)
      .add(this.check, { opacity: [0, 1], translateY: [10, 0], duration: 360 }, 1900)
      .add(chars, { opacity: [0, 1], duration: 90, delay: stagger(22), ease: "linear" }, 2100)
      .add(chars.filter((c) => c.dataset.match === "yes"), { color: ["#F2EBDD", "#FF5A1F", "#F2EBDD"], duration: 260, delay: stagger(10), ease: "linear" }, 2100 + 64 * 22 + 100)
      .add(this.verdict, { opacity: [0, 1], scale: [2, 1], rotate: [-2, -6], duration: 240, ease: "in(3)" }, 2100 + 64 * 22 + 900)
      .call(() => sound.stamp(), 2100 + 64 * 22 + 1130);
    return { verified, recomputed: check.recomputed };
  }
}
