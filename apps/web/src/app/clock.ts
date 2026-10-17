import { engine } from "animejs";

// Scene clock: one pausable, speed-scaled time base for everything that is not
// an anime.js tween (event pacing, blink timers, spark emitters). Pausing it
// also pauses the anime.js engine, so a paused frame is truly frozen.

interface ScheduledTask {
  id: number;
  at: number;
  fn: () => void;
  every: number | null;
}

type Listener = (state: { paused: boolean; speed: number }) => void;

export class SceneClock {
  private time = 0;
  private last = performance.now();
  private tasks: ScheduledTask[] = [];
  private nextId = 1;
  private listeners = new Set<Listener>();
  private _paused = false;
  private _speed = 1;

  constructor() {
    const tick = (now: number): void => {
      const dt = Math.min(Math.max(now - this.last, 0), 100);
      this.last = now;
      if (!this._paused) {
        this.time += dt * this._speed;
        this.runDue();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  get paused(): boolean {
    return this._paused;
  }

  get speed(): number {
    return this._speed;
  }

  now(): number {
    return this.time;
  }

  setPaused(paused: boolean): void {
    if (paused === this._paused) return;
    this._paused = paused;
    if (paused) engine.pause();
    else engine.resume();
    this.emit();
  }

  setSpeed(speed: number): void {
    if (speed === this._speed) return;
    this._speed = speed;
    engine.speed = speed;
    this.emit();
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  after(ms: number, fn: () => void): number {
    const id = this.nextId++;
    this.tasks.push({ id, at: this.time + Math.max(0, ms), fn, every: null });
    return id;
  }

  every(ms: number, fn: () => void): number {
    const id = this.nextId++;
    const period = Math.max(16, ms);
    this.tasks.push({ id, at: this.time + period, fn, every: period });
    return id;
  }

  cancel(id: number | null | undefined): void {
    if (id === null || id === undefined) return;
    this.tasks = this.tasks.filter((task) => task.id !== id);
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.after(ms, resolve);
    });
  }

  /** Drop every pending task. Used when a run is torn down. */
  reset(): void {
    this.tasks = [];
  }

  private runDue(): void {
    if (this.tasks.length === 0) return;
    const due = this.tasks.filter((task) => task.at <= this.time).sort((a, b) => a.at - b.at);
    if (due.length === 0) return;
    for (const task of due) {
      if (task.every !== null) task.at = this.time + task.every;
      else this.tasks = this.tasks.filter((other) => other.id !== task.id);
      try {
        task.fn();
      } catch (error) {
        console.error(error);
      }
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener({ paused: this._paused, speed: this._speed });
  }
}

export const clock = new SceneClock();
