# Recon: the haggle inside the chat

Phase 1 for the chat surfaces. Every claim below was read from a primary source on 2026-10-17: the PayBox developer guide and MCP reference (downloaded as Markdown), a live PayBox contract, the published `@modelcontextprotocol/ext-apps@2.0.3` and `@modelcontextprotocol/server@2.0.0` packages, the ext-apps repository at tag `v2.0.3`, and Claude's own docs. Quotes are verbatim.

**Verdict: PLUGIN-UI NO.** A hosted PayBox plugin cannot ship UI. BOXHAGGLE therefore gets two surfaces: text frames in every plugin result, and a standalone MCP App on the merchant host.

## 1. Can a PayBox plugin declare UI?

No.

- The hosted plugin guide (`https://developer.paybox.sh/requirements.md`, starter `1.0.2`), table "Capabilities and boundaries":
  > | Custom interface | Hosted code cannot supply executable UI; PayBox renders its own interface. |
- Same table, the only output channel:
  > | Read data | Return text and schema-validated structured output from a standard MCP tool. |
- The in-chat windows PayBox shows are PayBox's own MCP App resource, served by PayBox's MCP server, not by plugin code (`https://docs.paybox.sh/concepts/requests.md`):
  > When a wallet sign or swap is cleared (`pending_signature`), the MCP host opens the **signing window**, an interactive UI rendered in the chat (the MCP resource `ui://paybox/wallet-sign`).
- A live official contract carries no UI fields. `get_contract paybox://plugins/world` returned, per tool, only `annotations`, `description`, `id`, `input_schema`, `name` and `output_schema`. No `_meta`, no `ui`, no resource.
- Plugins are called through PayBox's own tool. The `use_plugin` tool description says: "Unofficial plugins call the authenticated user's enabled remote MCP installation after validating `input` against its persisted schema. ... PayBox opens an interface only when the selected operation needs one." The host sees `use_plugin`, a PayBox tool, so a plugin's `_meta.ui` could never reach the host even if PayBox stored it.
- A read-only `use_plugin` call (World `world_search`, no funds) came back to the agent as plain structured JSON.

Not found anywhere in the guide: embedded resources, `resource_link`, or `_meta` in plugin results. `structuredContent` is supported and validated against the declared output schema (the starter's `scripts/schema.mjs` and the guide's x402 example).

## 2. Plugin text output

Limits from the guide's "What is checked" table:

> | Total stdout per operation | 256 KiB |
> | Result content blocks | 128 |
> | Operation duration | 10 seconds |
> | Combined input and output schema per tool | 64 KiB |

What PayBox removes, from "Test your tools in PayBox":

> Output containing the literal value of a configured brokered credential is withheld.

The guide says nothing about Markdown handling. Locally, a fenced code block survives the plugin's MCP output byte for byte (JSON string escaping; covered by the plugin tests). **Whether it reaches the agent intact through `use_plugin` is not confirmable before upload.** The World call returned only structured JSON, so a hosted plugin's `content` text may not be forwarded at all. The frame is therefore carried in both places on the data tools: fenced in `content[0].text`, and as `structuredContent.frame` plus a `display` instruction. The two proposal tools must keep the starter's strict `io.paybox/transactionProposal` output, so they carry the frame in `content` only.

## 3. MCP Apps, from the package source

Read from `@modelcontextprotocol/ext-apps@2.0.3` (`dist/src/constants.d.ts`, `spec.types.d.ts`, `server/index.js`, `app.d.ts`).

| Question | Answer |
| --- | --- |
| Resource mimeType | `RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"` |
| How a tool links its UI | Tool `_meta.ui.resourceUri: "ui://..."`. `registerAppTool` also writes the legacy key `_meta["ui/resourceUri"]` ("Host developers must check both formats"). |
| UI receives tool input | Notification `ui/notifications/tool-input`, `params.arguments` ("Complete tool call arguments as key-value pairs") |
| UI receives tool result | Notification `ui/notifications/tool-result`, `params: CallToolResult` ("Standard MCP tool execution result"), so `structuredContent` and `content` both arrive. App API: `addEventListener("toolinput" / "toolresult")`. |
| UI can call server tools | Yes: `App.callServerTool(params)`, "The host proxies the request to the actual MCP server and returns the result." Host capability `serverTools`. Tool `_meta.ui.visibility`: `"model"` and/or `"app"`, default both. |
| Resource CSP | Resource `_meta.ui.csp` (`McpUiResourceCsp`). `connectDomains` "Maps to CSP `connect-src` directive. Empty or omitted: no network connections (secure default)". `resourceDomains` maps to `img-src`, `script-src`, `style-src`, `font-src`, `media-src`. `frameDomains` maps to `frame-src`, default `'none'`. Content-item `_meta.ui` takes precedence over the listing. |
| Sandbox origin | `_meta.ui.domain`, "Host-dependent ... If omitted, host uses default sandbox origin (typically per-conversation)." |

The server helpers have no imports at all: `registerAppTool` normalises `_meta`, `registerAppResource` defaults the mimeType. The View side (`App`) imports `@modelcontextprotocol/client`, `@modelcontextprotocol/core` and `zod/v4`. The streamable HTTP transport for a fetch-style server is `WebStandardStreamableHTTPServerTransport` in `@modelcontextprotocol/server@2.0.0` (`handleRequest(req: Request): Promise<Response>`, options `sessionIdGenerator`, `enableJsonResponse`), already in this repo's lockfile through the plugin. The same package's `createMcpHandler(factory, { legacy: "stateless" })` serves both 2025-era clients (a fresh instance per request, `GET` answered `405`) and 2026-07-28 clients from one factory; that is what `/mcp` uses.

## 4. Live updates in the sandbox

**Decision: the counter updates from tool results only.** SSE from the iframe would need two things. The first is `connectDomains: ["https://boxhaggle-api.25th.dev"]`, which is allowed. The second is a merchant CORS rule admitting the iframe's origin, and that origin is per-conversation by default. Claude documents a fixed origin (`https://claude.com/docs/connectors/building/mcp-apps/getting-started`):

> For Claude, the value is the first 32 hex characters of the SHA-256 of your server URL, followed by `.claudemcpcontent.com`.

That would let CORS name exactly one Claude origin. Other hosts use their own formats ("Each host defines its own format"). The merchant CORS stays locked to `https://boxhaggle.25th.dev`, nothing in the sandbox can be tested in a real host headlessly, and the brief says to fall back to tool results unless SSE is confirmed. So the counter resource declares no `connectDomains` at all, and makes no network connection. Every tool result carries the session's public event list, and the View replays new events through the same animation systems as the web app. Possible later: set `_meta.ui.domain` for Claude and admit that single origin on the `GET /events/:id` stream.

## 5. Hosts and adding the connector

ext-apps `README.md` (v2.0.3), "Supported Clients", links to each host's own docs: ChatGPT (`developers.openai.com/apps-sdk/mcp-apps-in-chatgpt`), Claude (`claude.com/docs/connectors/building/mcp-apps/getting-started`), VS Code (`code.visualstudio.com/blogs/2026/01/26/mcp-apps-support`), Goose (`block.github.io/goose/docs/tutorials/building-mcp-apps`) and Postman (`learning.postman.com/docs/postman-ai/mcp-requests/interact`). The README calls the full list the MCP clients page and says: "There's no _supported_ host implementation in this repo (beyond the examples/basic-host)". Claude's page shows the app inline after the user grants it: "Claude asks for permission to display the app. Click **Allow**, or **Always allow** for a server you trust".

Adding a remote server in Claude, from `https://claude.com/docs/connectors/custom/add-unlisted.md`:

> ### On a Free, Pro, or Max plan
> You add custom connectors to your own account. On the Free plan, you can add one custom connector.
> 1. Go to **Customize > Connectors**.
> 2. Click **Add custom connector**.
> 3. Enter the remote MCP server URL.
> 4. Optionally, enter OAuth credentials.
> 5. Click **Add**.

> ### On a Team or Enterprise plan
> An Owner adds the connector for the organization.
> 1. Go to **Organization settings > Connectors**.
> 2. Select **Add**, then **Custom**. If Claude asks for the connector type, choose **Web**.
> 3. Enter the remote MCP server URL.
> 4. Optionally, enter an OAuth client ID and secret.
> 5. Click **Add**.
>
> Connect as a member: Go to **Customize > Connectors**. Find the connector with the **Custom** label. Click **Connect** to authenticate.

> **No sign-in**: anyone with access to the server URL can use the connector.

The BOXHAGGLE endpoint takes no credentials, so the connector is added with **No sign-in** and the URL `https://boxhaggle-api.25th.dev/mcp`. The same page warns: "Custom connectors allow connections to unverified services."

## Reference host for testing

`examples/basic-host` in the ext-apps repository (tag `v2.0.3`): a host page and a sandbox proxy on separate ports ("Running on separate ports ensures proper origin isolation for security"), the CSP built from the resource's `_meta.ui.csp` and sent as an HTTP header, servers listed in the `SERVERS` env var. It runs in the browser, so the MCP server must answer CORS for the host page's origin. That is true for a local test merchant only; production `/mcp` keeps the existing CORS lock, which is fine because Claude and ChatGPT call connectors from their own servers.
