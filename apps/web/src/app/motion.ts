// prefers-reduced-motion: read once at start and kept current on change.
// Systems check `motion.reduced` before building a timeline and fall back to
// short fades and instant value changes.

type Listener = (reduced: boolean) => void;

const query = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
const listeners = new Set<Listener>();

export const motion = {
  reduced: query?.matches ?? false,
  onChange(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

function sync(reduced: boolean): void {
  motion.reduced = reduced;
  document.documentElement.classList.toggle("reduced-motion", reduced);
  for (const listener of listeners) listener(reduced);
}

query?.addEventListener("change", (event) => sync(event.matches));
if (typeof document !== "undefined") document.documentElement.classList.toggle("reduced-motion", motion.reduced);

/** Duration for a fade used in place of a motion timeline. */
export const FADE_MS = 180;
