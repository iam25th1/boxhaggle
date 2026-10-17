// Optional sound, off by default. Everything is synthesized with WebAudio:
// no files, no network. The mute choice persists in localStorage when allowed.

const STORAGE_KEY = "boxhaggle.sound";

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function writeStored(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Storage blocked: the toggle still works for this visit.
  }
}

class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  enabled = readStored();

  setEnabled(on: boolean): void {
    this.enabled = on;
    writeStored(on);
    if (on) this.ensure();
  }

  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext;
        if (!Ctor) return null;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.22;
        this.master.connect(this.ctx.destination);
        const length = Math.floor(this.ctx.sampleRate * 0.4);
        this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
        const data = this.noise.getChannelData(0);
        for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }

  private burst(ctx: AudioContext, at: number, duration: number, freq: number, q: number, gain: number): void {
    if (!this.noise || !this.master) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = freq;
    filter.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(gain, at + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    src.connect(filter).connect(env).connect(this.master);
    src.start(at);
    src.stop(at + duration + 0.02);
  }

  private tone(ctx: AudioContext, at: number, from: number, to: number, duration: number, gain: number, type: OscillatorType = "sine"): void {
    if (!this.master) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(to, at + duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(gain, at + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(env).connect(this.master);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  /** Soft dot-matrix clack: a few short filtered noise ticks. */
  printer(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 5; i += 1) this.burst(ctx, t + i * 0.07, 0.035, 2400 + (i % 2) * 500, 6, 0.35);
  }

  /** Coin into the tray: two bright partials with a quick decay. */
  coin(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(ctx, t, 2100, 1900, 0.28, 0.18);
    this.tone(ctx, t + 0.01, 3150, 2950, 0.18, 0.08);
    this.burst(ctx, t, 0.03, 5000, 3, 0.12);
  }

  /** Rubber stamp: a low thud with a little paper slap. */
  stamp(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(ctx, t, 140, 55, 0.22, 0.5);
    this.burst(ctx, t, 0.06, 900, 1.2, 0.3);
  }

  /** Split-flap rattle, very quiet. */
  flap(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 4; i += 1) this.burst(ctx, t + i * 0.045, 0.02, 3800, 8, 0.12);
  }
}

export const sound = new Sound();
