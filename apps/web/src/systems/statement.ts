import { createTimeline, stagger, utils } from "animejs";
import { motion } from "../app/motion";
import { h, shortRef } from "../dom";
import { sound } from "./audio";

// The PayBox statement: the rows from list_requests printed as one long
// receipt. It feeds down line by line.

export interface StatementRow {
  requestId: string;
  kind: string;
  status: string;
}

export class Statement {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly foot: HTMLElement;

  constructor(mount: HTMLElement) {
    this.list = h("ol", { class: "stmt-rows" });
    this.foot = h("p", { class: "stmt-foot" });
    this.el = h(
      "section",
      { class: "statement", "aria-labelledby": "stmt-title" },
      h("div", { class: "stmt-paper" },
        h("h2", { id: "stmt-title", class: "stmt-title" }, "PayBox statement"),
        h("p", { class: "stmt-sub" }, "Every request this run made, from list_requests."),
        this.list,
        this.foot,
        h("span", { class: "stmt-tear", "aria-hidden": "true" })),
    );
    mount.append(this.el);
  }

  reset(): void {
    this.list.replaceChildren();
    this.foot.textContent = "";
    this.el.hidden = true;
  }

  print(rows: StatementRow[]): void {
    this.el.hidden = false;
    const items = rows.map((row) =>
      h("li", { class: "stmt-row" },
        h("span", { class: "stmt-kind" }, row.kind),
        h("span", { class: "stmt-status" }, row.status),
        h("code", { class: "stmt-req" }, shortRef(row.requestId, 8, 4))),
    );
    this.list.replaceChildren(...items);
    const keys = new Set(rows.map((r) => r.status));
    this.foot.textContent = `${rows.length} request${rows.length === 1 ? "" : "s"}. ${[...keys].join(", ")}. No raw keys or card numbers on this page.`;
    if (motion.reduced) return;
    sound.printer();
    utils.set(items, { opacity: 0 });
    createTimeline({ defaults: { ease: "out(2)" } })
      .add(this.el, { opacity: [0, 1], translateY: [-24, 0], duration: 400 }, 0)
      .add(items, { opacity: [0, 1], translateY: [-6, 0], duration: 200, delay: stagger(80) }, 200);
  }
}
