import { animate, createTimeline, stagger, utils, type JSAnimation } from "animejs";
import type { Mood } from "@boxhaggle/core";
import { clock } from "../app/clock";
import { motion } from "../app/motion";
import { q, svgFrom } from "../dom";
import { EXPRESSIONS, type Expression } from "./expressions";

// The Broker: a layered SVG character. Brows, lids, pupils, mouth, cheeks,
// head and both hands are separate groups so anime.js can move each on its
// own. Anger reads through brows, lids, mouth, cheek colour and the drumming
// hand. Nothing ever shakes.

const INK = "#121212";
const PAPER = "#F2EBDD";
const WOOD = "#3A2A1E";
const ORANGE = "#FF5A1F";
const GREEN = "#1F7A4D";
const RED = "#C2362B";
const GREY = "#8A867E";

const LID_TRAVEL = 26;

const MARKUP = `
<svg class="broker-svg" viewBox="0 0 440 400" role="img" aria-labelledby="broker-title broker-desc" focusable="false">
  <title id="broker-title">The Broker</title>
  <desc id="broker-desc">A merchant in a green visor and bow tie, leaning on the counter.</desc>
  <defs>
    <clipPath id="b-eye-l"><circle cx="190" cy="184" r="13"/></clipPath>
    <clipPath id="b-eye-r"><circle cx="250" cy="184" r="13"/></clipPath>
    <pattern id="b-pinstripe" width="7" height="7" patternUnits="userSpaceOnUse">
      <line x1="3.5" y1="0" x2="3.5" y2="7" stroke="${GREY}" stroke-width="1" opacity="0.45"/>
    </pattern>
  </defs>
  <g class="b-upper">
  <g class="b-torso">
    <path d="M44 400 C52 336 100 300 170 288 L270 288 C340 300 388 336 396 400 Z" fill="${PAPER}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
    <path d="M200 238 L200 292 L240 292 L240 238 Z" fill="${PAPER}" stroke="${INK}" stroke-width="4"/>
    <path d="M84 400 C90 350 118 318 172 300 L214 372 L214 400 Z" fill="${WOOD}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
    <path d="M356 400 C350 350 322 318 268 300 L226 372 L226 400 Z" fill="${WOOD}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
    <path d="M84 400 C90 350 118 318 172 300 L214 372 L214 400 Z" fill="url(#b-pinstripe)"/>
    <path d="M356 400 C350 350 322 318 268 300 L226 372 L226 400 Z" fill="url(#b-pinstripe)"/>
    <circle cx="220" cy="330" r="3.2" fill="${INK}"/>
    <circle cx="220" cy="352" r="3.2" fill="${INK}"/>
    <circle cx="207" cy="388" r="3.4" fill="${GREY}" stroke="${INK}" stroke-width="1.5"/>
    <circle cx="233" cy="388" r="3.4" fill="${GREY}" stroke="${INK}" stroke-width="1.5"/>
    <path d="M118 356 Q150 376 190 352" fill="none" stroke="${GREY}" stroke-width="3" stroke-dasharray="2 4" stroke-linecap="round"/>
    <path d="M108 352 h26" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
    <path d="M196 282 L220 300 L186 308 Z" fill="${PAPER}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M244 282 L220 300 L254 308 Z" fill="${PAPER}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M220 301 L194 288 L194 316 Z" fill="${ORANGE}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M220 301 L246 288 L246 316 Z" fill="${ORANGE}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <rect x="213" y="294" width="14" height="14" rx="3" fill="${ORANGE}" stroke="${INK}" stroke-width="3"/>
  </g>
  <g class="b-head">
    <g transform="rotate(-24 300 150)">
      <rect x="296" y="112" width="9" height="52" fill="${ORANGE}" stroke="${INK}" stroke-width="2.5"/>
      <rect x="296" y="112" width="9" height="8" fill="${GREY}" stroke="${INK}" stroke-width="2.5"/>
      <path d="M296 164 L300.5 177 L305 164 Z" fill="${PAPER}" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>
    </g>
    <ellipse cx="144" cy="186" rx="14" ry="20" fill="${PAPER}" stroke="${INK}" stroke-width="4"/>
    <ellipse cx="296" cy="186" rx="14" ry="20" fill="${PAPER}" stroke="${INK}" stroke-width="4"/>
    <g class="b-ear-hot" opacity="0">
      <ellipse cx="144" cy="186" rx="14" ry="20" fill="${RED}" stroke="${INK}" stroke-width="4"/>
      <ellipse cx="296" cy="186" rx="14" ry="20" fill="${RED}" stroke="${INK}" stroke-width="4"/>
    </g>
    <ellipse cx="220" cy="174" rx="78" ry="90" fill="${PAPER}" stroke="${INK}" stroke-width="4"/>
    <path d="M150 136 C136 146 132 172 140 196 L152 190 C148 170 150 154 160 144 Z" fill="${INK}"/>
    <path d="M290 136 C304 146 308 172 300 196 L288 190 C292 170 290 154 280 144 Z" fill="${INK}"/>
    <path d="M148 112 C176 88 264 88 292 112" fill="none" stroke="${GREEN}" stroke-width="10" stroke-linecap="round"/>
    <path d="M128 124 C160 104 280 104 312 124 L302 140 C270 124 170 124 138 140 Z" fill="${GREEN}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M150 128 C190 116 250 116 290 128" fill="none" stroke="${INK}" stroke-width="1.5" stroke-dasharray="3 5" opacity="0.6"/>
    <g class="b-cheek-warm" opacity="0">
      <ellipse cx="174" cy="218" rx="16" ry="9" fill="${ORANGE}"/>
      <ellipse cx="266" cy="218" rx="16" ry="9" fill="${ORANGE}"/>
    </g>
    <g class="b-cheek-hot" opacity="0">
      <ellipse cx="174" cy="218" rx="17" ry="10" fill="${RED}"/>
      <ellipse cx="266" cy="218" rx="17" ry="10" fill="${RED}"/>
    </g>
    <g class="b-eyes">
      <circle cx="190" cy="184" r="13" fill="${PAPER}" stroke="${INK}" stroke-width="3"/>
      <circle cx="250" cy="184" r="13" fill="${PAPER}" stroke="${INK}" stroke-width="3"/>
      <g class="b-pupils">
        <circle cx="191" cy="186" r="6" fill="${INK}"/>
        <circle cx="251" cy="186" r="6" fill="${INK}"/>
        <circle cx="193" cy="183.5" r="1.8" fill="${PAPER}"/>
        <circle cx="253" cy="183.5" r="1.8" fill="${PAPER}"/>
      </g>
      <g clip-path="url(#b-eye-l)">
        <g class="b-lid">
          <rect x="174" y="143" width="32" height="28" fill="${PAPER}"/>
          <path d="M174 171 L206 171" stroke="${INK}" stroke-width="3.5"/>
        </g>
      </g>
      <g clip-path="url(#b-eye-r)">
        <g class="b-lid">
          <rect x="234" y="143" width="32" height="28" fill="${PAPER}"/>
          <path d="M234 171 L266 171" stroke="${INK}" stroke-width="3.5"/>
        </g>
      </g>
    </g>
    <g class="b-happy" opacity="0">
      <path d="M177 188 Q190 172 203 188" fill="none" stroke="${INK}" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M237 188 Q250 172 263 188" fill="none" stroke="${INK}" stroke-width="4.5" stroke-linecap="round"/>
    </g>
    <path class="b-brow b-brow-l" d="M168 162 Q190 150 212 160" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>
    <path class="b-brow b-brow-r" d="M228 160 Q250 150 272 162" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>
    <ellipse cx="220" cy="208" rx="14" ry="12" fill="${PAPER}" stroke="${INK}" stroke-width="3"/>
    <path class="b-mustache" d="M220 226 C206 216 182 216 166 234 C182 230 198 238 220 234 C242 238 258 230 274 234 C258 216 234 216 220 226 Z" fill="${INK}"/>
    <path class="b-mouth" d="M204 247 Q220 243 236 247 Q220 253 204 247 Z" fill="${INK}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>
  </g>
  </g>
  <g class="b-hand b-hand-l">
    <rect x="98" y="334" width="58" height="22" rx="6" fill="${PAPER}" stroke="${INK}" stroke-width="3"/>
    <rect x="99.5" y="341" width="55" height="6" fill="${ORANGE}"/>
    <path d="M100 356 h54 v20 q0 18 -18 18 h-18 q-18 0 -18 -18 z" fill="${PAPER}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M114 378 v13 M127 378 v15 M140 378 v13" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/>
  </g>
  <g class="b-hand b-hand-r">
    <rect x="284" y="334" width="58" height="22" rx="6" fill="${PAPER}" stroke="${INK}" stroke-width="3"/>
    <rect x="285.5" y="341" width="55" height="6" fill="${ORANGE}"/>
    <path d="M286 356 h54 v12 q0 10 -10 10 h-34 q-10 0 -10 -10 z" fill="${PAPER}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <rect class="b-finger" x="288" y="364" width="12" height="29" rx="6" fill="${PAPER}" stroke="${INK}" stroke-width="2.5"/>
    <rect class="b-finger" x="300.5" y="364" width="12" height="31" rx="6" fill="${PAPER}" stroke="${INK}" stroke-width="2.5"/>
    <rect class="b-finger" x="313" y="364" width="12" height="30" rx="6" fill="${PAPER}" stroke="${INK}" stroke-width="2.5"/>
    <rect class="b-finger" x="325.5" y="364" width="12" height="27" rx="6" fill="${PAPER}" stroke="${INK}" stroke-width="2.5"/>
  </g>
</svg>`;

interface Parts {
  upper: SVGGElement;
  head: SVGGElement;
  browL: SVGPathElement;
  browR: SVGPathElement;
  lids: SVGGElement[];
  pupils: SVGGElement;
  eyes: SVGGElement;
  happy: SVGGElement;
  mouth: SVGPathElement;
  mustache: SVGPathElement;
  cheekWarm: SVGGElement;
  cheekHot: SVGGElement;
  earHot: SVGGElement;
  handL: SVGGElement;
  handR: SVGGElement;
  fingers: SVGRectElement[];
}

export class Broker {
  readonly el: SVGSVGElement;
  private readonly parts: Parts;
  private mood: Mood = "calm";
  private expr: Expression = EXPRESSIONS.calm;
  private blinkTask: number | null = null;
  private glanceTask: number | null = null;
  private drum: JSAnimation | null = null;
  private breathe: JSAnimation | null = null;

  constructor(mount: HTMLElement) {
    this.el = svgFrom(MARKUP);
    mount.append(this.el);
    const root = this.el;
    this.parts = {
      upper: q<SVGGElement>(root, ".b-upper"),
      head: q<SVGGElement>(root, ".b-head"),
      browL: q<SVGPathElement>(root, ".b-brow-l"),
      browR: q<SVGPathElement>(root, ".b-brow-r"),
      lids: Array.from(root.querySelectorAll<SVGGElement>(".b-lid")),
      pupils: q<SVGGElement>(root, ".b-pupils"),
      eyes: q<SVGGElement>(root, ".b-eyes"),
      happy: q<SVGGElement>(root, ".b-happy"),
      mouth: q<SVGPathElement>(root, ".b-mouth"),
      mustache: q<SVGPathElement>(root, ".b-mustache"),
      cheekWarm: q<SVGGElement>(root, ".b-cheek-warm"),
      cheekHot: q<SVGGElement>(root, ".b-cheek-hot"),
      earHot: q<SVGGElement>(root, ".b-ear-hot"),
      handL: q<SVGGElement>(root, ".b-hand-l"),
      handR: q<SVGGElement>(root, ".b-hand-r"),
      fingers: Array.from(root.querySelectorAll<SVGRectElement>(".b-finger")),
    };
    this.apply(EXPRESSIONS.calm, true);
    this.startIdle();
    motion.onChange(() => this.startIdle());
  }

  get currentMood(): Mood {
    return this.mood;
  }

  /** Move every feature to the pose for `mood` in one timeline. */
  setMood(mood: Mood, instant = false): void {
    this.mood = mood;
    this.apply(EXPRESSIONS[mood], instant);
    this.el.dataset.mood = mood;
  }

  private apply(expr: Expression, instant: boolean): void {
    this.expr = expr;
    const p = this.parts;
    const lidY = expr.lid * LID_TRAVEL;
    const values = {
      browL: { translateX: expr.browL.x, translateY: expr.browL.y, rotate: expr.browL.r },
      browR: { translateX: expr.browR.x, translateY: expr.browR.y, rotate: expr.browR.r },
      lid: { translateY: lidY },
      handL: { translateX: expr.handL.x, translateY: expr.handL.y, rotate: expr.handL.r },
      handR: { translateX: expr.handR.x, translateY: expr.handR.y, rotate: expr.handR.r },
      head: { rotate: expr.headTilt },
      pupils: { translateX: expr.look.x, translateY: expr.look.y },
    };

    if (instant || motion.reduced) {
      utils.set(p.browL, values.browL);
      utils.set(p.browR, values.browR);
      utils.set(p.lids, values.lid);
      utils.set(p.handL, values.handL);
      utils.set(p.handR, values.handR);
      utils.set(p.head, values.head);
      utils.set(p.pupils, values.pupils);
      p.mouth.setAttribute("d", expr.mouth);
      utils.set(p.cheekWarm, { opacity: expr.cheekWarm });
      utils.set(p.cheekHot, { opacity: expr.cheekHot });
      utils.set(p.earHot, { opacity: expr.cheekHot });
      utils.set(p.happy, { opacity: expr.happyEyes ? 1 : 0 });
      utils.set(p.eyes, { opacity: expr.happyEyes ? 0 : 1 });
      this.setDrum(expr.drum);
      return;
    }

    const tl = createTimeline({ defaults: { duration: 420, ease: "out(3)" } });
    tl.add(p.browL, values.browL, 0)
      .add(p.browR, values.browR, 30)
      .add(p.lids, values.lid, 0)
      .add(p.mouth, { d: expr.mouth, duration: 360 }, 60)
      .add(p.mustache, { translateY: [0, expr.happyEyes ? -3 : 2, 0], duration: 360, ease: "inOut(2)" }, 60)
      .add(p.head, { ...values.head, duration: 600, ease: "inOut(2)" }, 0)
      .add(p.pupils, { ...values.pupils, duration: 260 }, 0)
      .add(p.cheekWarm, { opacity: expr.cheekWarm, duration: 500, ease: "linear" }, 100)
      .add(p.cheekHot, { opacity: expr.cheekHot, duration: 500, ease: "linear" }, 100)
      .add(p.earHot, { opacity: expr.cheekHot, duration: 500, ease: "linear" }, 140)
      .add(p.happy, { opacity: expr.happyEyes ? 1 : 0, duration: 200, ease: "linear" }, 80)
      .add(p.eyes, { opacity: expr.happyEyes ? 0 : 1, duration: 200, ease: "linear" }, 80)
      .add(p.handL, { ...values.handL, duration: 520, ease: "inOut(3)" }, 80)
      .add(p.handR, { ...values.handR, duration: 520, ease: "inOut(3)" }, 120)
      .call(() => this.setDrum(expr.drum), 600);
  }

  private setDrum(on: boolean): void {
    if (on && !motion.reduced) {
      if (this.drum) return;
      this.drum = animate(this.parts.fingers, {
        translateY: [0, -6, 0],
        duration: 420,
        delay: stagger(80, { from: "last" }),
        loop: true,
        loopDelay: 900,
        ease: "inOut(2)",
      });
    } else if (this.drum) {
      this.drum.revert();
      this.drum = null;
    }
  }

  /** A quick look somewhere, then back to the mood's resting gaze. */
  glance(x: number, y: number, holdMs = 700): void {
    if (motion.reduced) return;
    const p = this.parts;
    animate(p.pupils, { translateX: x, translateY: y, duration: 180, ease: "out(2)" });
    clock.cancel(this.glanceTask);
    this.glanceTask = clock.after(holdMs, () => {
      animate(p.pupils, { translateX: this.expr.look.x, translateY: this.expr.look.y, duration: 260, ease: "inOut(2)" });
    });
  }

  /** A small nod while he speaks: the head dips and returns. */
  nod(): void {
    if (motion.reduced) return;
    animate(this.parts.head, {
      translateY: [0, 4, 0],
      duration: 520,
      ease: "inOut(2)",
    });
  }

  private blink(): void {
    if (motion.reduced || this.expr.happyEyes || clock.paused) return;
    const rest = this.expr.lid * LID_TRAVEL;
    animate(this.parts.lids, {
      translateY: [
        { to: LID_TRAVEL, duration: 70, ease: "in(2)" },
        { to: rest, duration: 130, ease: "out(2)" },
      ],
    });
  }

  private scheduleBlink(): void {
    clock.cancel(this.blinkTask);
    this.blinkTask = clock.after(2600 + Math.random() * 2800, () => {
      this.blink();
      if (Math.random() < 0.18) clock.after(260, () => this.blink());
      this.scheduleBlink();
    });
  }

  private startIdle(): void {
    clock.cancel(this.blinkTask);
    this.breathe?.revert();
    this.breathe = null;
    if (motion.reduced) {
      this.setDrum(false);
      return;
    }
    this.scheduleBlink();
    this.breathe = animate(this.parts.upper, {
      translateY: [0, 1.6],
      duration: 2400,
      ease: "inOut(2)",
      loop: true,
      alternate: true,
    });
    if (this.expr.drum) this.setDrum(true);
  }

  reset(): void {
    this.setMood("calm", true);
  }
}
