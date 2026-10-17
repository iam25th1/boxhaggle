import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/screens.css";
import "./styles/systems.css";
import "./styles/stage.css";

import { animate, createTimeline, stagger, utils } from "animejs";
import { formatUsd, ITEMS, type StreamEvent } from "@boxhaggle/core";
import { clock } from "./app/clock";
import { Director } from "./app/director";
import { motion } from "./app/motion";
import { byId, h } from "./dom";
import { Renderer, type RunState } from "./renderer";
import { replayFor } from "./replay";
import { LiveFeed, MERCHANT_URL, sessionFromQuery, type LinkState } from "./stream/live";
import type { LobbySession } from "./stream/validate";
import { sound } from "./systems/audio";
import { FlapBoard } from "./systems/flap";
import { itemSvg } from "./systems/itemArt";

type Mode = "replay" | "live";
type ScreenName = "load" | "title" | "select" | "stage";

const screens: Record<ScreenName, HTMLElement> = {
  load: byId("screen-load"),
  title: byId("screen-title"),
  select: byId("screen-select"),
  stage: byId("screen-stage"),
};

const ui = {
  modeBadge: byId("mode-badge"),
  counterMode: byId("counter-mode"),
  runMeta: byId("run-meta"),
  linkState: byId("link-state"),
  pause: byId<HTMLButtonElement>("btn-pause"),
  speed: byId<HTMLButtonElement>("btn-speed"),
  sound: byId<HTMLButtonElement>("btn-sound"),
  exit: byId<HTMLButtonElement>("btn-exit"),
  follow: byId<HTMLButtonElement>("btn-follow"),
  enter: byId<HTMLButtonElement>("btn-enter"),
  back: byId<HTMLButtonElement>("btn-back"),
  liveNote: byId("live-note"),
  liveRadio: byId<HTMLInputElement>("mode-live"),
  shelf: byId<HTMLUListElement>("shelf"),
  selectHeading: byId("select-heading"),
  selectSub: byId("select-sub"),
  lobbyState: byId("lobby-state"),
  stageHeading: byId("stage-heading"),
};

let mode: Mode = "replay";
let screen: ScreenName = "load";
let currentItem: string = ITEMS[0]?.id ?? "brass-compass";
let feed: LiveFeed | null = null;
let liveBuffer: StreamEvent[] = [];
let liveStageShown = false;
let newestLobby: LobbySession | null = null;
let followed: string | null = null;
let lobbyLink: LinkState = "idle";
let sessionLink: LinkState = "idle";

// ---- renderer and director ----

function describeMeta(state: RunState): string {
  if (!state.itemId) return "";
  const parts = [state.itemName];
  if (state.round > 0) parts.push(`Round ${state.round}`);
  if (state.finalPrice !== null) parts.push(`Sold at ${formatUsd(state.finalPrice)}`);
  else if (state.ask > 0) parts.push(`Ask ${formatUsd(state.ask)}`);
  return parts.join(", ");
}

const renderer = new Renderer({
  onMeta: (state) => {
    ui.runMeta.textContent = describeMeta(state);
  },
  onEnded: () => {
    renderer.scorecard.againButton.hidden = mode === "live";
    renderer.scorecard.pickButton.textContent = mode === "live" ? "Back to the lobby" : "Pick another item";
    document.documentElement.dataset.run = "ended";
  },
});
const director = new Director((event) => renderer.apply(event));

renderer.scorecard.againButton.addEventListener("click", () => startReplay(currentItem));
renderer.scorecard.pickButton.addEventListener("click", () => {
  if (mode === "live") {
    leaveLive();
    enterSelect();
  } else {
    director.stop();
    enterSelect();
  }
});

// ---- screens ----

function show(name: ScreenName, focus?: HTMLElement): void {
  screen = name;
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  document.documentElement.dataset.screen = name;
  const onStage = name === "stage";
  ui.pause.disabled = !onStage;
  ui.speed.disabled = !onStage || mode === "live";
  ui.exit.hidden = name === "load" || name === "title";
  if (!onStage) setPaused(false);
  if (focus) {
    if (!focus.hasAttribute("tabindex") && !(focus instanceof HTMLButtonElement)) focus.setAttribute("tabindex", "-1");
    focus.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0 });
}

function setMode(next: Mode): void {
  mode = next;
  ui.modeBadge.dataset.mode = next;
  ui.modeBadge.textContent = next === "replay" ? "Replay" : "Live";
  ui.counterMode.textContent = next === "replay" ? "Replay, generated from the real rules" : "Live from the merchant";
  ui.counterMode.dataset.mode = next;
  ui.linkState.hidden = next !== "live";
  document.documentElement.dataset.mode = next;
}

// ---- load and title ----

const titleBoard = new FlapBoard({ length: 9, className: "flap-title", maxSteps: 4, stepMs: 150, staggerMs: 90 });
byId("title-board").append(titleBoard.el);

async function boot(): Promise<void> {
  setMode("replay");
  setupLiveToggle();
  buildShelf();
  syncSoundButton();
  const fonts = document.fonts?.ready ?? Promise.resolve();
  await Promise.race([fonts, clock.wait(2500)]);
  await clock.wait(500);
  const shutter = byId("shutter");
  if (motion.reduced) {
    await animate(shutter, { opacity: [1, 0], duration: 220, ease: "linear" }).then();
  } else {
    await createTimeline()
      .add(shutter, { translateY: [0, 10], duration: 160, ease: "out(2)" }, 0)
      .add(shutter, { translateY: [10, "-102%"], duration: 900, ease: "inOut(3)" }, 160)
      .then();
  }
  enterTitle();
}

function enterTitle(): void {
  show("title", byId<HTMLElement>("title-heading"));
  void titleBoard.set("", true);
  void titleBoard.set("BOXHAGGLE");
  if (!motion.reduced) {
    const parts = Array.from(document.querySelectorAll<HTMLElement>(".title-lede, .mode-pick, #btn-enter"));
    utils.set(parts, { opacity: 0 });
    animate(parts, { opacity: [0, 1], translateY: [10, 0], duration: 480, delay: stagger(110, { start: 700 }), ease: "out(3)" });
  }
}

function setupLiveToggle(): void {
  if (!MERCHANT_URL) {
    ui.liveRadio.disabled = true;
    ui.liveNote.hidden = false;
    ui.liveNote.textContent = "Live is off: this build has no VITE_MERCHANT_URL. Replay works offline.";
  } else {
    ui.liveNote.hidden = false;
    ui.liveNote.textContent = `Live follows ${new URL(MERCHANT_URL).host}.`;
    if (sessionFromQuery()) {
      ui.liveRadio.checked = true;
      setMode("live");
    }
  }
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
    radio.addEventListener("change", () => {
      if (radio.checked) setMode(radio.value === "live" ? "live" : "replay");
    });
  }
  ui.enter.addEventListener("click", () => enterSelect());
  ui.back.addEventListener("click", () => {
    leaveLive();
    enterTitle();
  });
}

// ---- item select ----

function buildShelf(): void {
  ui.shelf.replaceChildren(
    ...ITEMS.map((item) => {
      const card = h(
        "button",
        { type: "button", class: "item-card", "data-item": item.id },
        h("span", { class: "item-box", "aria-hidden": "true" }),
        h("span", { class: "item-tag" }, h("span", { class: "item-price" }, formatUsd(item.listPrice)), h("span", { class: "item-list" }, "list")),
        h("span", { class: "item-name" }, item.name),
        h("span", { class: "item-blurb" }, item.blurb),
      );
      const box = card.querySelector(".item-box");
      if (box) box.innerHTML = itemSvg(item.art, item.name);
      card.addEventListener("click", () => {
        if (mode === "replay") startReplay(item.id);
      });
      return h("li", { class: "shelf-slot" }, card);
    }),
  );
}

function enterSelect(): void {
  director.stop();
  for (const card of ui.shelf.querySelectorAll<HTMLButtonElement>(".item-card")) {
    card.dataset.state = "idle";
    card.disabled = mode === "live";
  }
  if (mode === "live") {
    ui.selectHeading.textContent = "Waiting for an agent at the counter";
    ui.selectSub.textContent = "When an agent opens a session, its item lights up here and the counter opens.";
    startLobby();
  } else {
    ui.selectHeading.textContent = "Pick what the agent haggles for";
    ui.selectSub.textContent = "The Broker draws a hidden floor for it and seals the number before the first offer.";
    ui.lobbyState.textContent = "";
  }
  show("select", ui.selectHeading);
  if (!motion.reduced) {
    animate(ui.shelf.querySelectorAll(".shelf-slot"), { opacity: [0, 1], translateY: [16, 0], duration: 420, delay: stagger(80), ease: "out(3)" });
  }
}

// ---- replay ----

function startReplay(itemId: string): void {
  currentItem = itemId;
  setMode("replay");
  leaveLive();
  director.stop();
  setPaused(false);
  document.documentElement.dataset.run = "running";
  renderer.reset("replay");
  show("stage", ui.stageHeading);
  const { script, source } = replayFor(itemId);
  ui.counterMode.textContent = source === "recorded" ? "Replay, recorded from a mock agent run" : "Replay, generated from the real rules";
  director.playScript(script.events);
}

// ---- live ----

function linkLabel(state: LinkState): string {
  return { idle: "idle", connecting: "connecting", open: "connected", retrying: "reconnecting", closed: "offline, retrying" }[state];
}

function syncLinkState(): void {
  const lobby = `Lobby ${linkLabel(lobbyLink)}`;
  const session = followed ? `, session ${followed.slice(0, 6)} ${linkLabel(sessionLink)}` : "";
  ui.linkState.textContent = `${lobby}${session}`;
  ui.linkState.dataset.state = sessionLink !== "idle" ? sessionLink : lobbyLink;
  if (screen === "select" && mode === "live") {
    ui.lobbyState.textContent = followed
      ? `Following session ${followed.slice(0, 8)}: ${linkLabel(sessionLink)}.`
      : `Lobby ${linkLabel(lobbyLink)}. No session yet.`;
  }
}

function ensureFeed(): LiveFeed | null {
  if (!MERCHANT_URL) return null;
  if (!feed) {
    feed = new LiveFeed(MERCHANT_URL, {
      onLobbyState: (state) => {
        lobbyLink = state;
        syncLinkState();
      },
      onSessionState: (state) => {
        sessionLink = state;
        syncLinkState();
      },
      onLobbySession: (session) => onLobbySession(session),
      onEvent: (event) => onLiveEvent(event),
    });
  }
  return feed;
}

function startLobby(): void {
  const f = ensureFeed();
  if (!f) return;
  // Live plays at real pace: the speed toggle is for replays only.
  setSpeed(1);
  liveBuffer = [];
  liveStageShown = false;
  followed = null;
  const pinned = sessionFromQuery();
  if (pinned) {
    follow(pinned);
  } else {
    f.connectLobby();
  }
  syncLinkState();
}

function onLobbySession(session: LobbySession): void {
  if (newestLobby && session.at < newestLobby.at) return;
  newestLobby = session;
  if (sessionFromQuery()) return;
  if (!followed) {
    follow(session.sessionId);
  } else if (session.sessionId !== followed) {
    ui.follow.hidden = false;
    ui.follow.textContent = `Watch newest session: ${session.itemName}`;
  }
}

function follow(sessionId: string): void {
  const f = ensureFeed();
  if (!f) return;
  followed = sessionId;
  liveBuffer = [];
  liveStageShown = false;
  ui.follow.hidden = true;
  director.stop();
  renderer.reset("live");
  f.follow(sessionId);
  syncLinkState();
}

ui.follow.addEventListener("click", () => {
  if (!newestLobby) return;
  enterSelect();
  follow(newestLobby.sessionId);
});

function onLiveEvent(event: StreamEvent): void {
  if (liveStageShown) {
    director.push(event);
    return;
  }
  liveBuffer.push(event);
  if (event.t === "session.opened") highlightAndOpen(event.itemId);
}

function highlightAndOpen(itemId: string): void {
  const card = ui.shelf.querySelector<HTMLButtonElement>(`.item-card[data-item="${itemId}"]`);
  ui.lobbyState.textContent = "An agent stepped up. Opening the counter.";
  if (card) {
    card.dataset.state = "chosen";
    if (!motion.reduced) animate(card, { translateY: [0, -12, 0], duration: 600, ease: "inOut(2)" });
  }
  clock.after(1600, () => {
    if (mode !== "live" || liveStageShown) return;
    liveStageShown = true;
    document.documentElement.dataset.run = "running";
    show("stage", ui.stageHeading);
    director.startLive();
    for (const ev of liveBuffer) director.push(ev);
    liveBuffer = [];
  });
}

function leaveLive(): void {
  feed?.close();
  followed = null;
  newestLobby = null;
  liveBuffer = [];
  liveStageShown = false;
  ui.follow.hidden = true;
  lobbyLink = "idle";
  sessionLink = "idle";
}

// ---- controls ----

function setPaused(paused: boolean): void {
  clock.setPaused(paused);
  ui.pause.setAttribute("aria-pressed", String(paused));
  const label = ui.pause.querySelector(".ctl-label");
  if (label) label.textContent = paused ? "Resume" : "Pause";
  document.documentElement.dataset.paused = String(paused);
}

ui.pause.addEventListener("click", () => setPaused(!clock.paused));
function setSpeed(next: 1 | 2): void {
  clock.setSpeed(next);
  ui.speed.textContent = `Speed ${next}x`;
  ui.speed.setAttribute("aria-pressed", String(next === 2));
}

ui.speed.addEventListener("click", () => setSpeed(clock.speed === 1 ? 2 : 1));
ui.exit.addEventListener("click", () => {
  director.stop();
  leaveLive();
  setPaused(false);
  renderer.hideSettle();
  enterTitle();
});

function syncSoundButton(): void {
  ui.sound.textContent = sound.enabled ? "Sound on" : "Sound off";
  ui.sound.setAttribute("aria-pressed", String(sound.enabled));
}
ui.sound.addEventListener("click", () => {
  sound.setEnabled(!sound.enabled);
  syncSoundButton();
  if (sound.enabled) sound.coin();
});

document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" && event.key !== " ") return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("button, a, input, select, textarea, [contenteditable='true']")) return;
  if (screen !== "stage") return;
  event.preventDefault();
  setPaused(!clock.paused);
});

// Debug and test hook: lets automated checks read run progress. No secrets here.
Object.defineProperty(window, "__boxhaggle", {
  value: {
    state: () => ({ ...renderer.state, pending: director.pending, screen, mode }),
  },
});

// The top bar wraps on narrow screens; the settlement overlay sits below it.
const topbar = byId("topbar");
const syncTopbar = (): void => {
  document.documentElement.style.setProperty("--settle-top", `${Math.ceil(topbar.getBoundingClientRect().height)}px`);
};
new ResizeObserver(syncTopbar).observe(topbar);
syncTopbar();

void boot();
