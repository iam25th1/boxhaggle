// Minimal MCP client for the two PayBox tools the SDK does not wrap
// (discover_tokens, list_requests). It mirrors the SDK's own transport in
// @paybox-sh/sdk 2.2.0 (src/mcp.ts): streamable HTTP at <api>/mcp, protocol
// 2025-06-18, the same bearer (a pbx_live_ key works per docs.paybox.sh/api-reference).

const PROTOCOL_VERSION = "2025-06-18";

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export class McpTools {
  private nextId = 0;
  private ready: Promise<void> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly bearer: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call(name: "discover_tokens" | "list_requests", args: Record<string, unknown>): Promise<unknown> {
    await this.initialize();
    const result = (await this.rpc("tools/call", { name, arguments: args })) as ToolResult;
    const text = result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text;
    if (result.isError) throw new Error(`paybox ${name} failed: ${(text ?? "").slice(0, 200)}`);
    if (result.structuredContent !== undefined) return result.structuredContent;
    if (typeof text !== "string") throw new Error(`paybox ${name} returned no content`);
    return JSON.parse(text) as unknown;
  }

  private initialize(): Promise<void> {
    this.ready ??= (async () => {
      await this.rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "boxhaggle-agent", version: "0.1.0" },
      });
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    })().catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    this.nextId += 1;
    const text = await this.post({ jsonrpc: "2.0", id: this.nextId, method, params });
    const body = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    const json = JSON.parse(body.length ? body.join("") : text) as { result?: unknown; error?: { message?: string } };
    if (json.error) throw new Error(`paybox MCP ${method} error: ${String(json.error.message ?? "unknown").slice(0, 200)}`);
    return json.result;
  }

  private async post(payload: unknown): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.bearer}`,
        "content-type": "application/json",
        "mcp-protocol-version": PROTOCOL_VERSION,
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`paybox MCP request failed (${response.status})`);
    return text;
  }
}
