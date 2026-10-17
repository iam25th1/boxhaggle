import { animate, utils } from "animejs";
import { formatUsd, formatUsdPrecise, ITEMS, type Mood, type StreamEvent } from "@boxhaggle/core";
import { clock } from "./app/clock";
import { motion } from "./app/motion";
import { Broker } from "./broker/broker";
import { byId, shortRef } from "./dom";
import { CoinTray } from "./systems/coins";
import { Docket } from "./systems/docket";
import { DeparturesBoard, ExchangeBoard, chainName } from "./systems/exchange";
import { Fuse } from "./systems/fuse";
import { itemSvg } from "./systems/itemArt";
import { Ledger } from "./systems/ledger";
import { PriceBoard } from "./systems/priceBoard";
import { Printer } from "./systems/printer";
import { Reveal } from "./systems/reveal";
import { Scorecard } from "./systems/scorecard";
import { Speech } from "./systems/speech";
import { Statement } from "./systems/statement";
import { Vault, drawerFor } from "./systems/vault";

// The renderer. It consumes StreamEvents one at a time, identically for replay
// and live, and drives every visual system. It keeps only the state it needs
// to tell the story (current item, ask, fees, the published commitment).

export interface RunState {
  mode: "replay" | "live";
  itemId: string | null;
  itemName: string;
  listPrice: number;
  ask: number;
  patience: number;
  mood: Mood;
  round: number;
  fees: number[];
  commitment: string | null;
  finalPrice: number | null;
  floor: number | null;
  verified: boolean | null;
  ended: boolean;
  crossChain: boolean;
}

function freshState(mode: "replay" | "live"): RunState {
  return {
    mode,
    itemId: null,
    itemName: "",
    listPrice: 0,
    ask: 0,
    patience: 100,
    mood: "calm",
    round: 0,
    fees: [],
    commitment: null,
    finalPrice: null,
    floor: null,
    verified: null,
    ended: false,
    crossChain: false,
  };
}

export interface RendererHooks {
  onMeta(state: RunState): void;
  onEnded(state: RunState): void;
}

export class Renderer {
  readonly broker: Broker;
  readonly board: PriceBoard;
  readonly fuse: Fuse;
  readonly printer: Printer;
  readonly tray: CoinTray;
  readonly docket: Docket;
  readonly vault: Vault;
  readonly ledger: Ledger;
  readonly exchange: ExchangeBoard;
  readonly departures: DeparturesBoard;
  readonly speech: Speech;
  readonly reveal: Reveal;
  readonly statement: Statement;
  readonly scorecard: Scorecard;
  private readonly settle: HTMLElement;
  private readonly itemFrame: HTMLElement;
  private readonly sealTag: HTMLElement;
  private readonly railTag: HTMLElement;
  private readonly stage: HTMLElement;
  state: RunState = freshState("replay");

  constructor(private readonly hooks: RendererHooks) {
    this.stage = byId("stage");
    this.broker = new Broker(byId("broker-mount"));
    this.board = new PriceBoard(byId("board-mount"));
    this.speech = new Speech(byId("speech-mount"), byId("broker-live"));
    this.fuse = new Fuse(byId("fuse-mount"));
    this.tray = new CoinTray(byId("tray-mount"));
    this.printer = new Printer(byId("printer-mount"));
    this.vault = new Vault(byId("col-left"));
    this.docket = new Docket(byId("col-left"));
    this.ledger = new Ledger(byId("col-right"));
    this.exchange = new ExchangeBoard(byId("col-right"));
    this.departures = new DeparturesBoard(byId("col-right"));
    this.statement = new Statement(byId("stmt-mount"));
    this.reveal = new Reveal(byId("reveal-mount"));
    this.scorecard = new Scorecard(byId("score-mount"));
    this.settle = byId("settle");
    this.itemFrame = byId("item-frame");
    this.sealTag = byId("seal-tag");
    this.railTag = byId("rail-tag");
  }

  reset(mode: "replay" | "live"): void {
    this.state = freshState(mode);
    this.broker.reset();
    this.board.reset();
    this.fuse.reset();
    this.printer.reset();
    this.tray.reset();
    this.docket.reset();
    this.vault.reset();
    this.ledger.reset();
    this.exchange.reset();
    this.departures.reset();
    this.speech.reset();
    this.reveal.reset();
    this.statement.reset();
    this.scorecard.reset();
    this.settle.hidden = true;
    delete this.settle.dataset.reveal;
    delete this.settle.dataset.statement;
    delete this.settle.dataset.score;
    this.itemFrame.replaceChildren();
    this.sealTag.textContent = "Floor not sealed yet";
    this.railTag.textContent = "Rails: waiting";
    this.stage.dataset.mood = "calm";
    this.hooks.onMeta(this.state);
  }

  private setMood(mood: Mood): void {
    this.state.mood = mood;
    this.stage.dataset.mood = mood;
    this.broker.setMood(mood);
  }

  apply(ev: StreamEvent): void {
    const st = this.state;
    switch (ev.t) {
      case "run.started":
        this.ledger.write(`Run started. Strategy ${ev.strategy}, spend cap $${ev.capUsd.toFixed(2)}.`, "Start");
        break;

      case "paybox.call":
        this.docket.call(ev.tool, ev.note);
        break;

      case "paybox.envelope":
        this.docket.envelope(ev);
        if (ev.status === "success" && ev.outputType) this.vault.open(drawerFor(ev.outputType), ev.outputType);
        if (ev.tool === "request_swap" && this.departures.visible) this.departures.status(ev.status, ev.requestId);
        if (ev.status === "pending_settlement" && !this.departures.visible) {
          this.departures.schedule(ev.at, "solana:mainnet", "eip155:8453");
          this.departures.status("pending_settlement", ev.requestId);
        }
        if (ev.tool === "pay_x402" && ev.status === "pending_signature") this.broker.glance(-4, 3, 900);
        break;

      case "credentials.listed":
        this.vault.setCredentials(ev);
        break;

      case "vault.opened":
        this.vault.open(ev.drawer, ev.outputType, ev.note);
        break;

      case "account.change":
        this.docket.note(ev.note, "warn", { href: ev.manageUrl, label: "Manage in PayBox" });
        break;

      case "agent.thought":
        this.ledger.write(ev.text, st.finalPrice !== null ? "Deal" : st.itemId ? `R${String(st.round + 1).padStart(2, "0")}` : "Prep");
        break;

      case "funds.checked": {
        const have = ev.have === null ? "unknown" : formatUsd(ev.have);
        const text = `Need ${formatUsd(ev.need)} ${ev.asset} on ${chainName(ev.network)}, have ${have}. ${ev.ok ? "Covered." : "Short."}`;
        this.docket.note(text, ev.ok ? "ok" : "short");
        break;
      }

      case "funds.buylink":
        this.docket.note(`Top-up link for a human, ${ev.currency} on ${chainName(ev.network)}.`, "info", { href: ev.url, label: "Open MoonPay" });
        break;

      case "swap.quote":
        st.crossChain = ev.fromChain !== ev.toChain;
        this.exchange.quote(ev.fromSymbol, ev.fromChain, ev.toSymbol, ev.toChain, ev.amountIn);
        if (st.crossChain) this.departures.schedule(ev.at, ev.fromChain, ev.toChain);
        break;

      case "swap.status":
        this.exchange.update(ev.status);
        if (this.departures.visible) this.departures.status(ev.status, ev.requestId);
        break;

      case "session.opened": {
        st.itemId = ev.itemId;
        st.itemName = ev.itemName;
        st.listPrice = ev.listPrice;
        st.ask = ev.ask;
        st.patience = ev.patience;
        st.commitment = ev.commitment;
        this.board.open(ev.itemName, ev.listPrice, ev.ask);
        this.fuse.set(ev.patience, true);
        this.fuse.light();
        this.setMood("calm");
        this.speech.say(ev.line, "calm");
        this.broker.nod();
        const item = ITEMS.find((it) => it.id === ev.itemId);
        this.itemFrame.innerHTML = itemSvg(item?.art ?? ev.art, ev.itemName);
        this.sealTag.textContent = `Floor sealed: ${shortRef(ev.commitment, 10, 6)}`;
        this.railTag.textContent = `Fee ${formatUsdPrecise(ev.offerFee)} a round on ${ev.networks.map((n) => chainName(n)).join(" or ")}`;
        this.reveal.seal(ev.commitment);
        if (!motion.reduced) animate(this.itemFrame, { opacity: [0, 1], translateY: [-10, 0], duration: 500, ease: "out(3)" });
        break;
      }

      case "offer.paid":
        st.round = ev.round;
        st.fees.push(ev.fee);
        this.printer.print(ev);
        this.tray.drop(ev.fee);
        this.broker.glance(-3, 4, 700);
        break;

      case "broker.reply": {
        const prev = st.ask;
        st.ask = ev.ask;
        st.patience = ev.patience;
        st.round = ev.round;
        this.fuse.set(ev.patience);
        if (ev.status === "sold") {
          st.finalPrice = ev.ask;
          this.board.sold(ev.ask);
          this.fuse.extinguish();
          this.setMood("sold");
          this.speech.say(ev.line, "sold");
        } else if (ev.status === "walked") {
          this.board.setAsk(ev.ask, prev);
          this.fuse.extinguish();
          this.setMood("insulted");
          this.speech.say(ev.line, "walk");
        } else {
          this.board.setAsk(ev.ask, prev);
          this.setMood(ev.mood);
          this.speech.say(ev.line, ev.mood);
          clock.after(300, () => this.broker.glance(0, -5, 600));
        }
        this.broker.nod();
        break;
      }

      case "checkout.paid":
        st.finalPrice = ev.price;
        this.docket.checkout(ev.price, chainName(ev.network), ev.receiptId);
        break;

      case "payment.rejected":
        this.docket.note(`The merchant rejected the ${ev.route} payment: ${ev.reason}.`, "warn");
        this.ledger.write(`Payment rejected on ${ev.route}: ${ev.reason}.`, "Note");
        break;

      case "reveal": {
        this.openSettle("reveal");
        const result = this.reveal.open(st.commitment, ev);
        st.floor = ev.floor;
        st.verified = result.verified;
        break;
      }

      case "receipt":
        this.openSettle("statement");
        this.statement.print(ev.rows);
        break;

      case "score":
        this.openSettle("score");
        this.scorecard.show({
          itemName: st.itemName || "The Broker's item",
          listPrice: ev.listPrice,
          finalPrice: ev.finalPrice,
          fees: ev.fees,
          rounds: ev.rounds,
          score: ev.score,
          savings: ev.savings,
          floor: st.floor,
          verified: st.verified,
          mode: st.mode,
        });
        break;

      case "run.ended":
        st.ended = true;
        this.fuse.extinguish();
        if (ev.outcome !== "deal") this.ledger.write(ev.reason ?? `Run ended: ${ev.outcome}.`, "End");
        this.hooks.onEnded(st);
        break;
    }
    this.hooks.onMeta(st);
  }

  private openSettle(step: "reveal" | "statement" | "score"): void {
    this.settle.dataset[step] = "on";
    if (!this.settle.hidden) return;
    this.settle.hidden = false;
    const scrim = this.settle.querySelector<HTMLElement>(".settle-scrim");
    if (scrim) {
      if (motion.reduced) utils.set(scrim, { opacity: 1 });
      else animate(scrim, { opacity: [0, 1], duration: 600, ease: "linear" });
    }
    const panel = this.settle.querySelector<HTMLElement>(".settle-grid");
    if (panel && !motion.reduced) animate(panel, { opacity: [0, 1], translateY: [24, 0], duration: 600, ease: "out(3)" });
    const first = this.settle.querySelector<HTMLElement>("#reveal-title");
    first?.setAttribute("tabindex", "-1");
  }

  hideSettle(): void {
    this.settle.hidden = true;
  }
}
