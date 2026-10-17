import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import type { Mood } from "./engine.js";

// Hand-written Broker lines. Selection is deterministic: the same session seed,
// round and mood always produce the same line, so a replay reads identically.
// Placeholders: {ask} current ask, {offer} the offer, {item} the item name.

export const LINES: Readonly<Record<Mood, readonly string[]>> = {
  calm: [
    "I hear {offer}. The {item} hears {ask}.",
    "Reasonable people can disagree. I say {ask}.",
    "Pull up a stool. {ask} is where we stand.",
    "That is an offer. Not my favourite offer, but an offer. {ask}.",
    "The night is long and so is my patience. For now. {ask}.",
    "I have sold to tougher customers. {ask}, friend.",
    "Interesting. Let me write that down. And cross it out. {ask}.",
    "We are closer than you think. {ask}.",
    "The ledger says {ask}. The ledger is rarely wrong.",
    "I will meet you a little of the way. {ask}.",
    "Steady hands make steady deals. {ask}.",
    "You are not the first to try {offer}. {ask} still stands.",
    "Coffee is free. The {item} is {ask}.",
  ],
  amused: [
    "Ha. Now we are talking. {ask}.",
    "You almost made me smile. Almost. {ask}.",
    "Close enough to smell the brass. {ask}.",
    "I like you. Do not let it go to your head. {ask}.",
    "That is a real number. I respect a real number. {ask}.",
    "Oh, very nearly. Very nearly. {ask}.",
    "You have done this before. {ask}.",
    "A worthy counter. I shave a little. {ask}.",
    "The stamp is warming up. {ask}.",
    "So close I can hear the till. {ask}.",
    "Clever. I will give you that and not much else. {ask}.",
    "My grandmother would have taken {offer}. I am not my grandmother. {ask}.",
    "Keep this up and we both go home happy. {ask}.",
  ],
  irritated: [
    "I am losing the thread here. {ask}.",
    "Every round costs you and bores me. {ask}.",
    "Do you see a discount sign? I do not. {ask}.",
    "My fuse is not infinite. {ask}.",
    "I have other customers. Imaginary ones, but still. {ask}.",
    "You keep circling. The {item} keeps waiting. {ask}.",
    "That number again. Bold of you. {ask}.",
    "I will hold at {ask}. Barely.",
    "Tick, tick. {ask}.",
    "Let us not make this a long night. {ask}.",
    "I am counting the rounds, you know. {ask}.",
    "The coffee is getting cold and so am I. {ask}.",
    "One more like that and we are done. {ask}.",
  ],
  insulted: [
    "{offer}? For the {item}? I have been insulted by better.",
    "Did you lose a digit on the way in? {ask}.",
    "I will pretend I did not hear that. {ask}.",
    "That offer belongs in the bin out back. {ask}.",
    "Careful. The door is right behind you. {ask}.",
    "You wound me. Professionally. {ask}.",
    "Is this a prank? Where is the camera? {ask}.",
    "I do not haggle with jokes. {ask}.",
    "My patience just left the building. Almost. {ask}.",
    "That number is a rumour, not an offer. {ask}.",
    "Lower than the floor of my basement. {ask}.",
    "I have sold rust for more than {offer}. {ask}.",
    "Try that again and I close the shutter. {ask}.",
  ],
  sold: [
    "Sold. Shake on it at {ask}.",
    "Done. The {item} is yours for {ask}.",
    "Stamp it. {ask}, and not a cent less.",
    "A deal at {ask}. Do not tell the others.",
    "Fine. {ask}. You drive a hard bargain.",
    "Sold to the patient one at {ask}.",
    "{ask}. Wrap it up, it is yours.",
    "We have a deal at {ask}. Pay at the window.",
    "The hammer falls at {ask}.",
    "Agreed at {ask}. Pleasure doing business.",
    "{ask}. I will miss this one.",
    "Sold. {ask}. Now get it out of my shop.",
    "Deal. {ask}. My accountant will cry.",
  ],
};

/** Lines the Broker says when the fuse runs out and the Broker walks away. */
export const WALK_LINES: readonly string[] = [
  "That is it. Shutter is down. No deal tonight.",
  "I am done. Come back when you are serious.",
  "Fuse is out. So am I. Goodnight.",
  "No sale. The {item} stays on my shelf.",
  "We are closed. To you, anyway.",
  "I have heard enough. Off you go.",
  "The counter is closed. Your fees are not refundable.",
  "Not tonight. Not for {offer}. Not ever.",
  "Walk away money? I just used mine.",
  "Shop is shut. The {item} thanks you for the entertainment.",
  "I have lost all interest. Good luck elsewhere.",
  "Patience gone. Deal gone. Goodnight.",
];

/** Opening greeting when the session starts, before any offer. */
export const OPENING_LINES: readonly string[] = [
  "Evening. The {item} is {ask}. Make me an offer.",
  "You have a good eye. {ask} for the {item}.",
  "Late shift, best prices. {ask}.",
  "Step up to the counter. {ask} and not a whisper less.",
  "The {item}? A classic. {ask}.",
  "Every round costs you a little. The {item} is {ask}.",
  "I am listening. {ask} is the number.",
  "Welcome to the counter. {ask}.",
  "Nobody leaves here without haggling. {ask}.",
  "Name your price. Mine is {ask}.",
  "Fresh off the shelf. {ask}.",
  "Mind the fuse. The {item} is {ask}.",
];

export interface LineContext {
  ask: string;
  offer: string;
  item: string;
}

/** Deterministic index into a pool from a seed string. */
export function pickIndex(seed: string, poolSize: number): number {
  if (poolSize <= 0) throw new Error("empty pool");
  const digest = sha256(utf8ToBytes(seed));
  const n = ((digest[0] ?? 0) << 24) | ((digest[1] ?? 0) << 16) | ((digest[2] ?? 0) << 8) | (digest[3] ?? 0);
  return (n >>> 0) % poolSize;
}

export function fillLine(template: string, ctx: LineContext): string {
  return template.replaceAll("{ask}", ctx.ask).replaceAll("{offer}", ctx.offer).replaceAll("{item}", ctx.item);
}

export function brokerLine(
  seed: string,
  round: number,
  pool: Mood | "walk" | "opening",
  ctx: LineContext,
): string {
  const lines = pool === "walk" ? WALK_LINES : pool === "opening" ? OPENING_LINES : LINES[pool];
  const template = lines[pickIndex(`${seed}|${round}|${pool}`, lines.length)] ?? "";
  return fillLine(template, ctx);
}
