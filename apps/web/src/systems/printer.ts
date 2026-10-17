import { animate, createTimeline, steps, utils } from "animejs";
import { formatUsd, formatUsdPrecise } from "@boxhaggle/core";
import { motion } from "../app/motion";
import { h, shortRef } from "../dom";
import { sound } from "./audio";

// Receipt printer on the counter. Each paid offer prints a ticket: it feeds
// out of the slot in steps (like a dot-matrix head advancing), then lifts,
// curls and drops onto the pile beside the printer. The pile keeps growing.

export interface TicketData {
  round: number;
  offer: number;
  fee: number;
  txRef: string;
  network: string;
}

const PILE_MAX = 9;

export class Printer {
  readonly el: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly pile: HTMLElement;
  private readonly count: HTMLElement;
  private readonly led: HTMLElement;
  private printed = 0;

  constructor(mount: HTMLElement) {
    this.feed = h("div", { class: "printer-feed" });
    this.led = h("span", { class: "printer-led", "aria-hidden": "true" });
    this.count = h("p", { class: "pile-count" }, "No tickets yet");
    this.pile = h("div", { class: "pile", role: "list", "aria-label": "Printed offer tickets" });
    this.el = h(
      "div",
      { class: "printer-station" },
      h("div", { class: "printer" },
        this.feed,
        h("div", { class: "printer-body", "aria-hidden": "true" },
          h("span", { class: "printer-slot" }),
          h("span", { class: "printer-brand" }, "Offer printer"),
          this.led,
        ),
      ),
      h("div", { class: "pile-wrap" }, this.pile, this.count),
    );
    mount.append(this.el);
  }

  reset(): void {
    this.printed = 0;
    this.feed.replaceChildren();
    this.pile.replaceChildren();
    this.count.textContent = "No tickets yet";
  }

  private ticket(data: TicketData): HTMLElement {
    const round = String(data.round).padStart(2, "0");
    return h(
      "article",
      { class: "ticket", role: "listitem", "aria-label": `Round ${data.round} ticket: offer ${formatUsd(data.offer)}, fee ${formatUsdPrecise(data.fee)}` },
      h("p", { class: "ticket-head" }, h("span", {}, "Offer"), h("span", {}, `R${round}`)),
      h("p", { class: "ticket-amount" }, formatUsd(data.offer)),
      h("p", { class: "ticket-row" }, h("span", {}, "Fee"), h("span", {}, formatUsdPrecise(data.fee))),
      h("p", { class: "ticket-row" }, h("span", {}, "Rail"), h("span", {}, data.network)),
      h("p", { class: "ticket-tx" }, `tx ${shortRef(data.txRef, 5, 5)}`),
      h("span", { class: "ticket-curl", "aria-hidden": "true" }),
    );
  }

  print(data: TicketData): void {
    this.printed += 1;
    const ticket = this.ticket(data);
    const n = this.printed;
    this.count.textContent = `${n} ticket${n === 1 ? "" : "s"}, ${formatUsdPrecise(n * data.fee)} in fees`;
    const tilt = ((n * 37) % 15) - 7;
    const stackOffset = Math.min(n - 1, PILE_MAX - 1);

    const land = (): void => {
      ticket.classList.add("ticket-piled");
      ticket.style.setProperty("--stack", String(stackOffset));
      this.pile.append(ticket);
      while (this.pile.children.length > PILE_MAX) this.pile.firstElementChild?.remove();
    };

    if (motion.reduced) {
      land();
      utils.set(ticket, { rotate: tilt, opacity: 0 });
      animate(ticket, { opacity: 1, duration: 180, ease: "linear" });
      return;
    }

    sound.printer();
    this.feed.append(ticket);
    utils.set(ticket, { translateY: "100%" });
    const tl = createTimeline();
    tl.add(this.led, { opacity: [0.3, 1], duration: 120, ease: "linear" }, 0)
      .add(ticket, { translateY: ["100%", "0%"], duration: 760, ease: steps(9) }, 0)
      .add(this.led, { opacity: 0.3, duration: 200, ease: "linear" }, 780)
      .call(() => {
        // Measure the ticket in the feed, move it to the pile, then play the
        // fall from where it was (FLIP) so it lands on the stack.
        const from = ticket.getBoundingClientRect();
        land();
        utils.set(ticket, { translateX: 0, translateY: 0, rotate: 0 });
        const to = ticket.getBoundingClientRect();
        const dx = from.left - to.left;
        const dy = from.top - to.top;
        utils.set(ticket, { translateX: dx, translateY: dy });
        animate(ticket, {
          translateX: [dx, 0],
          translateY: [{ to: dy - 18, duration: 220, ease: "out(2)" }, { to: 0, duration: 520, ease: "in(2)" }],
          rotate: [{ to: tilt * 2.2, duration: 360, ease: "inOut(2)" }, { to: tilt, duration: 380, ease: "out(3)" }],
          skewY: [{ to: -6, duration: 300, ease: "out(2)" }, { to: 0, duration: 440, ease: "out(2)" }],
          duration: 740,
        });
      }, 1050);
  }
}
