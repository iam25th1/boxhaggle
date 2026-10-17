import type { Mood } from "@boxhaggle/core";

// The Broker's face, one entry per mood. Every mouth path shares one command
// structure (M, Q, Q, Z with the same point count) so anime.js can tween `d`
// directly between moods.

export interface Pose {
  x: number;
  y: number;
  r: number;
}

export interface Expression {
  browL: Pose;
  browR: Pose;
  /** Upper lid drop, 0 open to 1 shut. */
  lid: number;
  happyEyes: boolean;
  mouth: string;
  /** Opacity of the orange cheek layer. */
  cheekWarm: number;
  /** Opacity of the red cheek and ear layer. */
  cheekHot: number;
  headTilt: number;
  handL: Pose;
  handR: Pose;
  drum: boolean;
  /** Pupil offset, a small glance. */
  look: { x: number; y: number };
}

const mouth = (lx: number, ly: number, ux: number, uy: number, rx: number, ry: number, dx: number, dy: number): string =>
  `M${lx} ${ly} Q${ux} ${uy} ${rx} ${ry} Q${dx} ${dy} ${lx} ${ly} Z`;

const rest: Pose = { x: 0, y: 0, r: 0 };

export const EXPRESSIONS: Readonly<Record<Mood, Expression>> = {
  calm: {
    browL: { x: 0, y: 0, r: 0 },
    browR: { x: 0, y: 0, r: 0 },
    lid: 0.28,
    happyEyes: false,
    mouth: mouth(204, 247, 220, 243, 236, 247, 220, 253),
    cheekWarm: 0,
    cheekHot: 0,
    headTilt: 0,
    handL: rest,
    handR: rest,
    drum: false,
    look: { x: 0, y: 0 },
  },
  amused: {
    browL: { x: 0, y: -7, r: -4 },
    browR: { x: 0, y: -7, r: 4 },
    lid: 0.18,
    happyEyes: false,
    mouth: mouth(198, 243, 220, 247, 242, 243, 220, 263),
    cheekWarm: 0.55,
    cheekHot: 0,
    headTilt: 3,
    handL: rest,
    handR: { x: -10, y: -30, r: -12 },
    drum: false,
    look: { x: -2, y: 0 },
  },
  irritated: {
    browL: { x: 0, y: 4, r: 12 },
    browR: { x: 0, y: 4, r: -12 },
    lid: 0.46,
    happyEyes: false,
    mouth: mouth(204, 252, 220, 246, 236, 252, 220, 251),
    cheekWarm: 1,
    cheekHot: 0,
    headTilt: -1,
    handL: rest,
    handR: { x: 0, y: -4, r: 0 },
    drum: true,
    look: { x: -3, y: 1 },
  },
  insulted: {
    browL: { x: 2, y: 8, r: 22 },
    browR: { x: -2, y: 8, r: -22 },
    lid: 0.52,
    happyEyes: false,
    mouth: mouth(200, 257, 220, 240, 240, 257, 220, 266),
    cheekWarm: 0,
    cheekHot: 1,
    headTilt: -3,
    handL: { x: -8, y: 5, r: 0 },
    handR: { x: 8, y: 5, r: 0 },
    drum: false,
    look: { x: -4, y: 2 },
  },
  sold: {
    browL: { x: 0, y: -10, r: -6 },
    browR: { x: 0, y: -10, r: 6 },
    lid: 0,
    happyEyes: true,
    mouth: mouth(193, 241, 220, 245, 247, 241, 220, 270),
    cheekWarm: 0.7,
    cheekHot: 0,
    headTilt: 2,
    handL: rest,
    handR: { x: -54, y: -46, r: -22 },
    drum: false,
    look: { x: 0, y: 0 },
  },
};
