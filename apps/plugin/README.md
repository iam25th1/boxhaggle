# BOXHAGGLE PayBox plugin

The hosted PayBox marketplace plugin for BOXHAGGLE. A standard MCP server built from PayBox plugin starter `1.0.2`, bundled to one `dist/plugin.mjs`.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `boxhaggle_items` | read, no network | The Broker's shelf with list prices. Sample call for conformance. |
| `boxhaggle_open_session` | data, network | `POST /session` (channel `plugin`). Returns session id, ask, patience, mood and the floor commitment. Uses the brokered `X-Merchant-Key`. |
| `boxhaggle_status` | read, network | `GET /session/:id`. Current ask, patience, mood, round, deal state. |
| `boxhaggle_propose_offer` | x402 proposal | `POST /offer { sessionId, amount }`, `maxAmount` = the haggling fee, Solana or Base USDC. |
| `boxhaggle_propose_checkout` | x402 proposal | `POST /checkout { sessionId }`, `maxAmount` = the exact agreed price. |
| `boxhaggle_reveal` | read, network | `GET /reveal/:id`, then recomputes `SHA-256(F | salt)` inside the plugin. |

Every result opens with a frame: a monospace picture of the counter (face, line, ask, offer, fuse, mood, round ledger; the receipt after a close) in a `text` code block, followed by a one-line instruction to show it to the user as is. Data tools also return it as `structuredContent.frame` with `display`, because PayBox may forward only the structured result. The two proposal tools keep the starter's exact `io.paybox/transactionProposal` output and carry the frame in their text only. Frames come from `GET /session/:id/events` and fall back to the session view when that read fails. PayBox's guide states that hosted code cannot ship UI, so text is the only surface here (`docs/RECON-CHAT-UI.md`).

Every text result ends with an `AGENT DATA` block, one line of JSON in a `json` code block, for agents that never see `structuredContent`: item ids on `boxhaggle_items`; the session id, status, round, ask, patience, mood, deal state and `nextStep` on the session tools; on the two proposal tools also the offer or price and the exact `io.paybox/transactionProposal`, with an instruction to follow the PayBox request to its end instead of paying again; on `boxhaggle_reveal` the floor, salt and both checks. Floor and salt never appear before the reveal.

x402 proposals carry no headers or secrets, as the plugin guide requires. Plugin sessions on the merchant are therefore payment-gated on `/offer` and `/checkout`; the merchant key gates only session creation and arrives as a PayBox brokered header, so the plugin never reads it.

## Build and check

```powershell
npm ci --ignore-scripts
npm run build -w @boxhaggle/core
npm run build -w @boxhaggle/plugin
npm test -w @boxhaggle/plugin
```

The official starter conformance (`npm run test:conformance -w @boxhaggle/plugin`) requires Node 24 on macOS or Linux. It runs in CI (`.github/workflows/ci.yml`) on ubuntu with Node `24.21.0`. On Windows use WSL2. The only change from the starter scripts is `scripts/test.mjs` calling `npm run` instead of `pnpm run` (house rule: npm and `package-lock.json`). `src/paybox.ts` and the other `scripts/*.mjs` are byte-identical to starter `1.0.2`.

## Submit (manual, in the developer portal)

The portal needs your PayBox session; this cannot be done from CI.

1. Open `https://developer.paybox.sh`, choose **Register with PayBox**, sign in with the PayBox account that will own the plugin. Complete MoonPay KYC if the portal shows the eligibility badge.
2. Build `apps/plugin/dist/plugin.mjs` (above). Upload only that file, and upload the current build: any earlier upload predates the frames. No source maps, no `.env`, no `node_modules`.
3. **Test and configure**, network hosts: add the merchant host only: `boxhaggle-api.25th.dev`.
4. **Variables and Secrets**:
   - Environment variable `BOXHAGGLE_MERCHANT_URL` = `https://boxhaggle-api.25th.dev` (plain origin, no path).
   - Secret: target host `boxhaggle-api.25th.dev`, header name `X-Merchant-Key`, value = the merchant's `MERCHANT_API_KEY` (paste it from your secret store, never print it: `docs/SELF-HOSTING.md`, Environment).
5. Wait for checks, then **Run checks again** after 30 seconds if a setting was missing.
6. **Test**, **Load tools**, run `boxhaggle_items` with `{}`, then `boxhaggle_open_session` with `{"itemId":"brass-compass"}`.
7. Run `boxhaggle_propose_offer` with the session id and `{"offerUsd":"1.20","chain":"solana:mainnet"}`; choose **Validate transaction** with your Solana wallet to see the payment preview. Validation never pays.
8. Accept the hackathon terms and select **Submit Project** before Saturday 17 October 2026, 20:00 New York time.
9. After submission the plugin appears under **Unofficial plugins** in your PayBox account. Enable it, then an agent can call it through `discover_plugins` and `use_plugin`.
