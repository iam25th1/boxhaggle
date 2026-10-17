import { FRAME_DISPLAY_NOTE } from "./frame.js";

// Plain data for agents that read only a tool result's text. Hosts with MCP
// Apps (Claude among them) hand structuredContent to the app view, not to the
// model, so every value the agent needs for its next call is repeated at the
// end of the text as one fenced JSON block. Floor and salt fields are refused
// unless the caller says the session has been revealed.

export const AGENT_DATA_LABEL = "AGENT DATA (exact values for your next tool call; no need to show them to the user):";

const SEALED = new Set(["floor", "floorusd", "flooratomic", "salt"]);

function assertSealed(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSealed(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, inner] of Object.entries(value)) {
    if (SEALED.has(key.toLowerCase())) throw new Error(`agent data must not carry ${key} before the reveal`);
    assertSealed(inner);
  }
}

/** The labelled, fenced JSON block. Backticks are escaped so the fence cannot break. */
export function agentDataBlock(data: Record<string, unknown>, opts: { revealed?: boolean } = {}): string {
  if (!opts.revealed) assertSealed(data);
  const json = JSON.stringify(data).replace(/`/g, "\\u0060");
  return `${AGENT_DATA_LABEL}\n\`\`\`json\n${json}\n\`\`\``;
}

/** A tool result's text: the fenced frame, the display note, the summary, then the agent data. */
export function agentText(frame: string, summary: string, data: Record<string, unknown>, opts: { revealed?: boolean } = {}): string {
  return [frame, frame ? FRAME_DISPLAY_NOTE : "", summary, agentDataBlock(data, opts)].filter(Boolean).join("\n\n");
}

/** Reads the block back out of a result's text, as a text-only agent would. */
export function parseAgentData(text: string): Record<string, unknown> | null {
  const at = text.lastIndexOf(AGENT_DATA_LABEL);
  if (at < 0) return null;
  const match = /^\n```json\n(.*)\n```$/s.exec(text.slice(at + AGENT_DATA_LABEL.length));
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[1]!);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
