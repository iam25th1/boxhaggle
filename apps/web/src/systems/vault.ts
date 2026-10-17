import { createTimeline, utils } from "animejs";
import { clock } from "../app/clock";
import { motion } from "../app/motion";
import { h } from "../dom";

// The credential vault: three drawers (wallet, card, secret). A drawer slides
// open only when PayBox hands the agent a scoped output from it, and the tray
// shows the output type. Raw values never reach this page, so none are drawn.

export type Drawer = "wallet" | "card" | "secret";

export interface CredentialView {
  wallet: { present: boolean; chain?: string | undefined; address?: string | undefined };
  card: { present: boolean; brand?: string | undefined };
  secret: { present: boolean; name?: string | undefined };
}

const OUTPUT_COPY: Readonly<Record<string, { title: string; body: string; raw?: boolean }>> = {
  signature: { title: "Signature", body: "Signed inside PayBox. The key stays put." },
  tx_hash: { title: "Transaction hash", body: "Broadcast by PayBox. Only the hash comes back." },
  payment_token: { title: "One-time card", body: "Single-use card token, scoped to this purchase." },
  secret_token: { title: "Secret token", body: "A scoped stand-in. The real key never leaves PayBox." },
  raw_secret: { title: "Raw, process memory only", body: "Held by the agent process. Never logged, never shown here.", raw: true },
};

export function drawerFor(outputType: string): Drawer {
  if (outputType === "payment_token") return "card";
  if (outputType === "secret_token" || outputType === "raw_secret") return "secret";
  return "wallet";
}

interface DrawerParts {
  root: HTMLElement;
  plate: HTMLElement;
  sub: HTMLElement;
  tray: HTMLElement;
  trayInner: HTMLElement;
  front: HTMLElement;
  closeTask: number | null;
}

const TRAY_OPEN = 76;

export class Vault {
  readonly el: HTMLElement;
  private readonly drawers: Record<Drawer, DrawerParts>;
  private readonly live: HTMLElement;

  constructor(mount: HTMLElement) {
    this.live = h("p", { class: "sr-only", "aria-live": "polite" });
    const make = (kind: Drawer, label: string): DrawerParts => {
      const plate = h("span", { class: "drawer-plate" }, label);
      const sub = h("span", { class: "drawer-sub" }, "Not checked yet");
      const trayInner = h("div", { class: "drawer-tray-inner" });
      const tray = h("div", { class: "drawer-tray" }, trayInner);
      const front = h(
        "div",
        { class: "drawer-front" },
        h("span", { class: "drawer-card" }, plate, sub),
        h("span", { class: "drawer-handle", "aria-hidden": "true" }),
      );
      const root = h("div", { class: "drawer", "data-drawer": kind, "data-state": "closed", role: "group", "aria-label": `${label} drawer` }, tray, front);
      return { root, plate, sub, tray, trayInner, front, closeTask: null };
    };
    this.drawers = {
      wallet: make("wallet", "Wallet"),
      card: make("card", "Card"),
      secret: make("secret", "Secret"),
    };
    this.el = h(
      "section",
      { class: "vault", "aria-labelledby": "vault-title" },
      h("h2", { id: "vault-title", class: "panel-title panel-title-ink" }, "PayBox vault"),
      h("div", { class: "vault-cabinet" }, this.drawers.wallet.root, this.drawers.card.root, this.drawers.secret.root),
      this.live,
    );
    mount.append(this.el);
    this.reset();
  }

  reset(): void {
    for (const kind of ["wallet", "card", "secret"] as const) {
      const d = this.drawers[kind];
      clock.cancel(d.closeTask);
      d.root.dataset.state = "closed";
      d.root.dataset.present = "unknown";
      d.sub.textContent = "Not checked yet";
      d.trayInner.replaceChildren();
      utils.set(d.tray, { height: 0 });
      utils.set(d.front, { translateY: 0 });
    }
  }

  setCredentials(view: CredentialView): void {
    const { wallet, card, secret } = this.drawers;
    wallet.root.dataset.present = String(view.wallet.present);
    wallet.sub.textContent = view.wallet.present
      ? [view.wallet.chain ? cap(view.wallet.chain) : "Wallet", view.wallet.address].filter(Boolean).join(", ")
      : "No wallet granted";
    card.root.dataset.present = String(view.card.present);
    card.sub.textContent = view.card.present ? (view.card.brand ? `${view.card.brand} card` : "Card granted") : "No card granted";
    secret.root.dataset.present = String(view.secret.present);
    secret.sub.textContent = view.secret.present ? (view.secret.name ?? "Secret granted") : "No secret granted";
    this.live.textContent = `Credentials: wallet ${view.wallet.present ? "present" : "absent"}, card ${view.card.present ? "present" : "absent"}, secret ${view.secret.present ? "present" : "absent"}.`;
  }

  /** Slide a drawer open to show the scoped output type, then close it. */
  open(kind: Drawer, outputType: string, note?: string, holdMs = 3200): void {
    const d = this.drawers[kind];
    const copy = OUTPUT_COPY[outputType] ?? { title: outputType, body: "Scoped output." };
    clock.cancel(d.closeTask);
    d.trayInner.replaceChildren(
      h("p", { class: `tray-chip${copy.raw ? " tray-chip-raw" : ""}` }, copy.title),
      h("p", { class: "tray-body" }, note ?? copy.body),
    );
    d.root.dataset.state = "open";
    d.root.dataset.output = outputType;
    this.live.textContent = `${cap(kind)} drawer opened: ${copy.title}.`;

    if (motion.reduced) {
      utils.set(d.tray, { height: TRAY_OPEN });
      utils.set(d.trayInner, { opacity: 0 });
      createTimeline().add(d.trayInner, { opacity: 1, duration: 180, ease: "linear" });
    } else {
      const tl = createTimeline({ defaults: { ease: "out(3)" } });
      tl.add(d.front, { translateY: [0, 6], duration: 160, ease: "out(2)" }, 0)
        .add(d.tray, { height: [0, TRAY_OPEN], duration: 460 }, 60)
        .add(d.trayInner, { opacity: [0, 1], translateY: [8, 0], duration: 260 }, 240);
    }
    d.closeTask = clock.after(holdMs, () => this.close(kind));
  }

  close(kind: Drawer): void {
    const d = this.drawers[kind];
    d.root.dataset.state = "closed";
    if (motion.reduced) {
      utils.set(d.tray, { height: 0 });
      return;
    }
    const tl = createTimeline({ defaults: { ease: "inOut(2)" } });
    tl.add(d.trayInner, { opacity: 0, duration: 160 }, 0)
      .add(d.tray, { height: 0, duration: 380 }, 80)
      .add(d.front, { translateY: 0, duration: 200 }, 300);
  }
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
