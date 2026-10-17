// JSON-lines logger with redaction. Never pass raw headers to it; even so, any
// field whose name looks sensitive is replaced, and long strings are truncated
// so a payment header or token can never land in the log in full.

const SENSITIVE = /(key|secret|token|authorization|password|payment|signature|x-payment|card|pan|cvv|cvc|salt|floor)/i;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 12)}...[${value.length}]` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE.test(key) ? "[redacted]" : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: Level = "info", sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const min = LEVELS[level];
  const write = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    sink(JSON.stringify({ t: new Date().toISOString(), lvl, msg, ...(fields ? (redact(fields) as object) : {}) }));
  };
  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  };
}

/** Short, non-reversible tag for an id so logs can correlate without exposing it. */
export function tag(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 6)}..`;
}
