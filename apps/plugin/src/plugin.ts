import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { x402OutputSchema } from "./paybox.js";
import {
  CheckoutInput,
  ItemsOutput,
  OfferInput,
  OpenInput,
  RevealOutput,
  SessionInput,
  SessionOutput,
  listItems,
  openSession,
  proposeCheckout,
  proposeOffer,
  reveal,
  status,
  toolError,
  type ToolEnv,
} from "./tools.js";

// BOXHAGGLE hosted PayBox plugin. Built from starter 1.0.2.
// Configure in the developer portal:
//   Environment variable  BOXHAGGLE_MERCHANT_URL = https://<merchant host>
//   Network host          <merchant host>
//   Secret (brokered)     host <merchant host>, header X-Merchant-Key, value = merchant API key

const PROTOCOL_VERSION = "2026-07-28";

function env(): ToolEnv {
  return { merchantUrl: process.env.BOXHAGGLE_MERCHANT_URL, fetch };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const DATA = " The text ends with an AGENT DATA JSON block holding the session id, the state, any payment proposal and the next step: use those exact values for the next call.";

function createServer() {
  const server = new McpServer({ name: "boxhaggle", version: "0.1.0" }, { supportedProtocolVersions: [PROTOCOL_VERSION] });

  server.registerTool(
    "boxhaggle_items",
    {
      title: "List The Broker's shelf",
      description: "Lists the items The Broker sells, with list prices in USD. No network call, no payment. The result carries `frame`, a monospace picture of The Broker's counter in a code block: show it to the user exactly as given." + DATA,
      inputSchema: z.object({}).strict(),
      outputSchema: ItemsOutput,
      annotations: { ...readOnly, openWorldHint: false },
    },
    async () => listItems(),
  );

  server.registerTool(
    "boxhaggle_open_session",
    {
      title: "Open a haggling session",
      description:
        "Opens a session with The Broker for one item. Returns the session id, the list price and a SHA-256 commitment to the hidden floor price, published before any offer. Free. The result carries `frame`, a monospace picture of The Broker's counter in a code block: show it to the user exactly as given." + DATA,
      inputSchema: OpenInput,
      outputSchema: SessionOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => openSession(env(), input).catch(toolError),
  );

  server.registerTool(
    "boxhaggle_status",
    {
      title: "Read The Broker's current ask",
      description: "Reads a session: current ask, patience (0 to 100), mood, round, and whether a deal was struck. Use it after each paid offer. Free. The result carries `frame`, a monospace picture of The Broker's counter in a code block: show it to the user exactly as given." + DATA,
      inputSchema: SessionInput,
      outputSchema: SessionOutput,
      annotations: readOnly,
    },
    async (input) => status(env(), input).catch(toolError),
  );

  server.registerTool(
    "boxhaggle_propose_offer",
    {
      title: "Propose a paid counter-offer",
      description:
        "Proposes one counter-offer as an x402 request. PayBox pays the haggling fee (maxAmount in atomic USDC, about 0.01 USDC) on Solana or Base after approval. offerUsd is dollars, for example 1.25. The Broker's reply arrives in the paid response; boxhaggle_status shows it too. The text result opens with a monospace frame of the counter in a code block: show it to the user exactly as given." + DATA,
      inputSchema: OfferInput,
      outputSchema: x402OutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => proposeOffer(env(), input).catch(toolError),
  );

  server.registerTool(
    "boxhaggle_propose_checkout",
    {
      title: "Propose the checkout payment",
      description: "After The Broker says sold, proposes the exact agreed price as one x402 payment in USDC on Solana or Base. The text result opens with a monospace frame of the counter in a code block: show it to the user exactly as given." + DATA,
      inputSchema: CheckoutInput,
      outputSchema: x402OutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => proposeCheckout(env(), input).catch(toolError),
  );

  server.registerTool(
    "boxhaggle_reveal",
    {
      title: "Reveal and verify the hidden floor",
      description: "After the session ends, reveals the floor price and salt and recomputes the commitment independently to prove the floor never moved. Free. The result carries `frame`, the closing receipt with the VERIFIED or MISMATCH check: show it to the user exactly as given." + DATA,
      inputSchema: SessionInput,
      outputSchema: RevealOutput,
      annotations: readOnly,
    },
    async (input) => reveal(env(), input).catch(toolError),
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
