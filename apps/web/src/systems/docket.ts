import { animate, createTimeline, stagger, svg, utils, type JSAnimation } from "animejs";
import { formatUsd, type EnvelopeStatus, type PayboxTool } from "@boxhaggle/core";
import { motion } from "../app/motion";
import { h, s, shortRef } from "../dom";
import { sound } from "./audio";

// The PayBox docket. Every PayBox call tears a fresh sheet off the pad, and
// every envelope status gets its own treatment on that sheet. Stamps slam in
// on their own: only the stamp element moves, the sheet stays put.

export const STATUS_LABEL: Readonly<Record<EnvelopeStatus, string>> = {
  success: "Cleared",
  pending_approval: "Hold for passkey",
  pending_funding: "Needs funding",
  pending_signature: "Awaiting signature",
  pending_settlement: "Settling",
  pending_confirmation: "Confirming",
  denied: "Denied",
  error: "Error",
};

const OUTPUT_LABEL: Readonly<Record<string, string>> = {
  signature: "a signature",
  tx_hash: "a transaction hash",
  payment_token: "a one-time card token",
  secret_token: "a scoped secret token",
  raw_secret: "a raw secret, process memory only",
};

const TOOL_LABEL: Partial<Record<PayboxTool, string>> = {
  list_credentials: "List credentials",
  request_secret: "Request secret",
  pay_x402: "Pay x402",
  get_portfolio: "Check portfolio",
  get_buy_link: "Get buy link",
  discover_tokens: "Discover tokens",
  request_swap: "Request swap",
  list_requests: "List requests",
  request_account_change: "Account change",
  use_service: "Use service",
  verify_solana_balance: "Verify balance",
  request_payment: "Request payment",
  claim_payment_credentials: "Claim card",
  get_request: "Get request",
};

export interface EnvelopeView {
  tool: PayboxTool;
  status: EnvelopeStatus;
  requestId?: string | undefined;
  outputType?: string | undefined;
  approvalUrl?: string | undefined;
  message?: string | undefined;
}

export class Docket {
  readonly el: HTMLElement;
  private readonly pad: HTMLElement;
  private readonly log: HTMLOListElement;
  private readonly live: HTMLElement;
  private sheet: HTMLElement | null = null;
  private sheetTool: PayboxTool | null = null;
  private loops: JSAnimation[] = [];

  constructor(mount: HTMLElement) {
    this.pad = h("div", { class: "docket-pad" });
    this.log = h("ol", { class: "docket-log", "aria-label": "Earlier PayBox calls" });
    this.live = h("p", { class: "sr-only", "aria-live": "polite" });
    this.el = h(
      "section",
      { class: "docket panel-paper", "aria-labelledby": "docket-title" },
      h("div", { class: "docket-clip", "aria-hidden": "true" }),
      h("h2", { id: "docket-title", class: "panel-title" }, "PayBox docket"),
      this.pad,
      this.log,
      this.live,
    );
    mount.append(this.el);
    this.reset();
  }

  reset(): void {
    this.stopLoops();
    this.pad.replaceChildren();
    this.log.replaceChildren();
    this.sheet = null;
    this.sheetTool = null;
    const idle = h("article", { class: "sheet sheet-idle" }, h("p", { class: "sheet-note" }, "No PayBox calls yet."));
    this.pad.append(idle);
    this.sheet = idle;
  }

  private stopLoops(): void {
    for (const loop of this.loops) loop.revert();
    this.loops = [];
  }

  /** Tear the current sheet off and start a new one for `tool`. */
  call(tool: PayboxTool, note?: string): void {
    this.stopLoops();
    const old = this.sheet;
    if (old && !old.classList.contains("sheet-idle")) this.archive(old);
    const sheet = h(
      "article",
      { class: "sheet", "data-tool": tool },
      h("p", { class: "sheet-tool" }, h("span", { class: "sheet-tool-name" }, TOOL_LABEL[tool] ?? tool), h("code", {}, tool)),
      note ? h("p", { class: "sheet-note" }, note) : null,
      h("p", { class: "sheet-req" }),
      h("div", { class: "sheet-state" }),
    );
    this.pad.append(sheet);
    this.sheet = sheet;
    this.sheetTool = tool;
    this.live.textContent = `PayBox: ${TOOL_LABEL[tool] ?? tool}.`;

    if (old) {
      if (motion.reduced) {
        old.remove();
      } else {
        utils.set(old, { zIndex: 2 });
        animate(old, {
          translateY: -40,
          rotate: -5,
          opacity: 0,
          duration: 300,
          ease: "in(2)",
          onComplete: () => old.remove(),
        });
      }
    }
    if (!motion.reduced) animate(sheet, { opacity: [0, 1], duration: 200, ease: "linear" });
  }

  private archive(sheet: HTMLElement): void {
    const tool = sheet.dataset.tool ?? "";
    const status = sheet.dataset.status ?? "";
    const label = status ? (STATUS_LABEL[status as EnvelopeStatus] ?? status) : "Called";
    const row = h(
      "li",
      { class: "log-row" },
      h("code", { class: "log-tool" }, tool),
      h("span", { class: "log-status", "data-status": status || "called" }, label),
    );
    this.log.prepend(row);
    while (this.log.children.length > 5) this.log.lastElementChild?.remove();
  }

  private ensureSheet(tool: PayboxTool): HTMLElement {
    if (!this.sheet || this.sheetTool !== tool || this.sheet.classList.contains("sheet-idle")) this.call(tool);
    return this.sheet as HTMLElement;
  }

  envelope(env: EnvelopeView): void {
    const sheet = this.ensureSheet(env.tool);
    sheet.dataset.status = env.status;
    const req = sheet.querySelector(".sheet-req");
    if (req && env.requestId) req.textContent = `Request ${shortRef(env.requestId, 8, 4)}`;
    const state = sheet.querySelector<HTMLElement>(".sheet-state");
    if (!state) return;
    this.stopLoops();
    state.replaceChildren();
    state.dataset.status = env.status;
    this.live.textContent = `PayBox ${env.tool}: ${STATUS_LABEL[env.status]}.${env.message ? ` ${env.message}` : ""}`;

    switch (env.status) {
      case "pending_signature":
        this.signature(state);
        break;
      case "pending_confirmation":
        this.confirmation(state);
        break;
      case "pending_funding":
        this.funding(state, env.approvalUrl);
        break;
      case "pending_settlement":
        this.settlement(state);
        break;
      case "pending_approval":
        this.stamp(state, "Hold for passkey", "stamp-hold");
        if (env.approvalUrl) {
          state.append(
            h("p", { class: "sheet-link" }, "Owner approves at ",
              h("a", { href: env.approvalUrl, target: "_blank", rel: "noopener noreferrer" }, env.approvalUrl.replace(/^https:\/\//, ""))),
          );
        }
        break;
      case "success":
        this.stamp(state, "Cleared", "stamp-cleared");
        if (env.outputType) {
          state.append(h("p", { class: "sheet-output" }, `PayBox returned ${OUTPUT_LABEL[env.outputType] ?? env.outputType}.`));
        }
        break;
      case "denied":
        this.stamp(state, "Denied", "stamp-denied");
        break;
      case "error":
        state.append(h("p", { class: "tag-error" }, h("span", { class: "tag-error-word" }, "Error"), env.message ?? "PayBox returned an error."));
        if (!motion.reduced) animate(state.lastElementChild as HTMLElement, { opacity: [0, 1], duration: 240, ease: "linear" });
        break;
    }
    if (env.message && env.status !== "error" && !(env.status === "success" && env.outputType)) state.append(h("p", { class: "sheet-msg" }, env.message));
  }

  /** A plain note on the current sheet: funds checks, links, rejections. */
  note(text: string, kind: "ok" | "short" | "warn" | "info" = "info", link?: { href: string; label: string }): void {
    const sheet = this.sheet && !this.sheet.classList.contains("sheet-idle") ? this.sheet : null;
    const target = sheet?.querySelector<HTMLElement>(".sheet-state") ?? null;
    const line = h(
      "p",
      { class: `sheet-fact sheet-fact-${kind}` },
      text,
      link ? h("a", { href: link.href, target: "_blank", rel: "noopener noreferrer" }, link.label) : null,
    );
    if (target) target.append(line);
    else {
      this.call("get_request");
      this.sheet?.querySelector(".sheet-state")?.append(line);
    }
    this.live.textContent = text;
    if (kind === "short") this.funding(line.parentElement as HTMLElement, undefined, false);
  }

  private signature(state: HTMLElement): void {
    const squiggle = s("path", {
      d: "M8 30 C 18 6, 26 40, 36 22 S 52 8, 58 26 S 76 38, 84 18 S 104 12, 112 28",
      class: "sig-ink",
      fill: "none",
    });
    const art = s(
      "svg",
      { viewBox: "0 0 160 44", class: "sig-svg", "aria-hidden": "true" },
      s("path", { d: "M2 8 L12 18 M12 8 L2 18", class: "sig-x" }),
      s("line", { x1: 0, y1: 38, x2: 160, y2: 38, class: "sig-line" }),
      squiggle,
    );
    state.append(h("div", { class: "st-sign" }, art, h("p", { class: "st-caption" }, "Awaiting wallet signature inside PayBox")));
    if (motion.reduced) return;
    const [drawable] = svg.createDrawable(squiggle);
    if (!drawable) return;
    this.loops.push(
      animate(drawable, {
        draw: ["0 0", "0 1"],
        duration: 1100,
        ease: "inOut(2)",
        loop: true,
        loopDelay: 700,
      }),
    );
  }

  private confirmation(state: HTMLElement): void {
    const blocks = [0, 1, 2, 3, 4].map(() => h("span", { class: "blk" }));
    state.append(h("div", { class: "st-confirm" }, h("div", { class: "blk-row", "aria-hidden": "true" }, ...blocks), h("p", { class: "st-caption" }, "Confirming on chain")));
    if (motion.reduced) {
      for (const block of blocks.slice(0, 3)) block.classList.add("blk-on");
      return;
    }
    this.loops.push(
      animate(blocks, {
        backgroundColor: ["#F2EBDD", "#121212"],
        duration: 320,
        delay: stagger(260),
        loop: true,
        loopDelay: 900,
        ease: "linear",
      }),
    );
  }

  private funding(state: HTMLElement, link?: string, withCaption = true): void {
    const slot = h("span", { class: "fund-slot", "aria-hidden": "true" }, h("span", { class: "fund-coin" }));
    state.append(
      h("div", { class: "st-fund" }, slot,
        withCaption ? h("p", { class: "st-caption" }, "Needs funding") : null,
        link ? h("a", { href: link, target: "_blank", rel: "noopener noreferrer", class: "sheet-link" }, "Open the top-up link") : null),
    );
    if (motion.reduced) return;
    const coin = slot.firstElementChild as HTMLElement;
    this.loops.push(animate(coin, { translateY: [-14, 2], opacity: [0, 1], duration: 900, ease: "in(2)", loop: 2, loopDelay: 500 }));
  }

  private settlement(state: HTMLElement): void {
    const dot = h("span", { class: "bridge-dot" });
    state.append(
      h("div", { class: "st-bridge" },
        h("div", { class: "bridge-track", "aria-hidden": "true" }, h("span", { class: "bridge-end" }), dot, h("span", { class: "bridge-end" })),
        h("p", { class: "st-caption" }, "Bridging between chains. See the departures board.")),
    );
    if (motion.reduced) {
      utils.set(dot, { left: "60%" });
      return;
    }
    this.loops.push(animate(dot, { left: ["4%", "92%"], duration: 2400, ease: "inOut(2)", loop: true, loopDelay: 300 }));
  }

  private stamp(state: HTMLElement, word: string, cls: string): void {
    const stamp = h("p", { class: `stamp ${cls}`, role: "img", "aria-label": word }, h("span", {}, word));
    state.append(h("div", { class: "stamp-zone" }, stamp));
    if (motion.reduced) {
      utils.set(stamp, { rotate: -7 });
      animate(stamp, { opacity: [0, 1], duration: 180, ease: "linear" });
      return;
    }
    utils.set(stamp, { opacity: 0, scale: 2.1, rotate: -2 });
    const tl = createTimeline();
    tl.add(stamp, { opacity: [0, 1], scale: [2.1, 1], rotate: [-2, -7], duration: 230, ease: "in(3)" }, 0)
      .call(() => sound.stamp(), 220)
      .add(stamp, { scale: [1, 1.03, 1], duration: 160, ease: "out(2)" }, 230);
  }

  checkout(price: number, network: string, receiptId: string): void {
    this.note(`Paid ${formatUsd(price)} on ${network}. Receipt ${receiptId}.`, "ok");
  }
}
