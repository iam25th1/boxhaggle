# BOXHAGGLE Phase 1 recon

Recon date: 2026-10-17 (PayBox Chapter 1 hackathon, closes 2026-10-17 20:00 EDT).

Every claim below cites what was read. Anything not confirmed from source or docs is listed under "Unverified" and sits behind an adapter in code.

Sources read:

- `@paybox-sh/sdk@2.2.0` tarball from npm: `README.md`, `SKILL.md`, `dist/index.d.ts`, `dist/chunk-*.js` (method bodies), `package.json`.
- `https://docs.paybox.sh/llms-full.txt` (all doc pages: model, approvals, request lifecycle, MCP connector, OAuth, MCP tools, API, SDK and CLI).
- `https://api.paybox.sh/openapi.json` and `/.well-known/api-catalog`.
- `https://developer.paybox.sh/llms.txt`, `/skill.md`, `/requirements.md` (hackathon plugin guide).
- Plugin starter `v1.0.2` files from `https://developer.paybox.sh/plugin-starter/v1.0.2/` (sha256 of `src/paybox.ts`, `src/plugin.ts`, `package.json`, `scripts/*.mjs` checked against `manifest.json`).
- `@x402/core@2.28.0`, `@x402/evm@2.28.0`, `@x402/hono@2.28.0`, `x402@1.2.0` tarballs (READMEs and `.d.mts`).
- Live `GET https://facilitator.payai.network/supported`.
- Live read-only PayBox MCP calls from the recon session: `list_credentials`, `discover_services` (query "weather", network base).

## 1. `@paybox-sh/sdk`

Exists on npm. Latest `2.2.0` (published 2026-10-14), Apache-2.0, repo `moonpay/paybox` (`clients/sdk`). Class `PayboxClient`.

| MCP tool | SDK method (exact) | Transport in SDK source |
| --- | --- | --- |
| `list_credentials` | `listCredentials()` | `GET /agent/grants` |
| `use_service` | `useService({ credentialId, url, method?, body? }, opts?)` | `POST /agent/use-service` |
| `pay_x402` | `payX402({ credentialId, accepts, resourceUrl }, opts?)` | `POST /agent/x402` |
| `request_secret` | `requestSecret({ credentialId, raw?, purpose? })` | `POST /agent/request` (`type: "secret"`) |
| `get_buy_link` | `getBuyLink({ credentialId, destinationChain?, currencyCode?, amountUsd? })` | `GET /agent/buy-link` |
| `verify_solana_balance` | `verifySolanaBalance({ address, tokenMint, transactionSignature })` | `POST /agent/portfolio/verify-solana-balance` |
| `discover_tokens` | **none** | MCP only |
| `get_portfolio` | `getPortfolio({ address, networkIds?, token?, networkId? })` returns `unknown` | `GET /agent/portfolio` |
| `request_swap` | `requestSwap({ credentialId, srcChain, dstChain?, srcToken, dstToken, amount, swapDirection?, slippageBps?, recipient?, valueCents? }, opts?)` | `POST /agent/swap` |
| `request_payment` | `requestPayment({ credentialId, merchant, merchantUrl, amountCents, currency? })` | `POST /agent/request` (`type: "payment"`) |
| `claim_payment_credentials` | `claimPaymentCredentials(requestId)` | `POST /agent/requests/:id/credentials` |
| `request_account_change` | `requestAccountChange(note?)` | `POST /agent/account-change` |
| `get_request` | `getRequest(requestId)`, plus `waitForRequest(requestId, { intervalMs?, timeoutMs? })` | `GET /agent/requests/:id` |
| `list_requests` | **none** | MCP only |

Docs confirm the gaps: "request history (`list_requests`) has no SDK method or CLI command, and the wrappers don't expose the advanced x402 options (the v2 `x402_version` + `resource` fields on `pay_x402`; custom `headers` and probe mode on `use_service`)." (`/sdk-cli`).

Headless auth: confirmed. `new PayboxClient({ apiKey: "pbx_live_...", signingKey: "pbxk1...." })` or `PayboxClient.fromConfig()` reading `PAYBOX_API_KEY` and `PAYBOX_SIGNING_KEY`. The SDK `bearer()` returns the API key as `Authorization: Bearer`. Docs (`/api-reference`): "A personal `pbx_live_*` API key ... works as the same bearer" on `/mcp`.

In-process signing: confirmed. `payX402`, `useService`, `requestSwap`, `requestWalletSign` sign locally when a `pbxk1.` key is configured and status is `pending_signature` (`completeX402` in SDK source calls `signX402Request`, which builds an EVM EIP-3009 envelope or a Solana envelope and posts it to `/agent/requests/:id/envelopes`). The signing key and the API key are a matched pair bound to one client.

`list_requests` and `discover_tokens` adapter: the SDK's own `McpTransport` (not exported) posts JSON-RPC `tools/call` to `${baseUrl}/mcp` with the same bearer and protocol version `2025-06-18`. BOXHAGGLE ships a small MCP adapter that does the same for these two tools only.

Envelope statuses (`RequestStatus` in `index.d.ts`): `pending_approval`, `pending_funding`, `pending_signature`, `pending_settlement`, `pending_confirmation`, `success`, `denied`, `error`. Note `pending_funding` exists in the SDK type and is not in the brief; the agent handles it.

## 2. x402 server side

Maintained packages: the `@x402/*` v2 line (`@x402/core`, `@x402/evm`, `@x402/svm`, `@x402/hono`, `@x402/express`), version `2.28.0`, published 2026-09-29, repo `x402-foundation/x402`. The older `x402`, `x402-hono`, `x402-express` are at `1.2.0` (April 2026) and are the legacy line.

`@x402/core` ships `HTTPFacilitatorClient` (`verify`, `settle`, `getSupported`) that posts `{ x402Version, paymentPayload, paymentRequirements }` to `<facilitator>/verify` and `/settle`, passing the payload's own `x402Version` through, so it serves v1 and v2 payloads. It also ships `types/v1` (`PaymentRequirementsV1` with `maxAmountRequired`, `resource`, `description`, `mimeType`, `payTo`, `maxTimeoutSeconds`, `asset`, `extra`; `PaymentPayloadV1` with `x402Version: 1, scheme, network, payload`).

Headers (from `@x402/core` README): v2 uses `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`; v1 uses a JSON 402 body plus `X-PAYMENT` and `X-PAYMENT-RESPONSE`.

What PayBox pays:

- `pay_x402` MCP tool: `x402_version` "`1` for JSON-body requirements, `2` for `PAYMENT-REQUIRED` header requirements. Defaults to `1`." The SDK `payX402` cannot set version 2. So the SDK agent path is v1.
- Wallet requirement: "x402 requires a plain EOA payer" (EIP-7702 delegated wallets get a plain-EOA error or an auto-undelegate composite flow).
- Rails: `discover_services` filters `base` and `solana`. The plugin guide states "Supported payment rails are USDC on Base (`eip155:8453`) and Solana (`solana:mainnet`, mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`)." SDK source has an explicit Solana x402 rail (`isSolanaRailX402`).
- Live catalog entries returned by `discover_services` use CAIP-2 networks (`eip155:8453`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` with `extra { name: "USD Coin", version: "2" }`, and Solana USDC with `extra.feePayer`.
- The only credential this PayBox account has (from `list_credentials`) is one Solana wallet, autonomous, with `agent_signer_recorded: true`. No EVM wallet, no card, no secret yet.

Facilitator: `https://facilitator.payai.network` `/supported` (live) lists `exact` on v1 `solana`, `base` and v2 `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, `eip155:8453`, with a Solana `feePayer`. x402 docs list PayAI as needing no API key. `https://x402.org/facilitator` is the `@x402/core` default and is testnet only.

## 3. Marketplace listing

Documented path found. The hackathon "PayBox marketplace plugin" is a hosted plugin:

1. Build a standard TypeScript MCP server from starter `v1.0.2` (`@modelcontextprotocol/server@2.0.0`, `zod@4.4.3`, protocol version `2026-07-28`), bundle to one `dist/plugin.mjs` (10 MiB max).
2. Pass local conformance (`pnpm test`: typecheck, two identical builds, MCP conformance). The starter checks require Node 24 on macOS or Linux; native Windows is not supported.
3. The participant uploads `plugin.mjs` in the developer portal (`developer.paybox.sh`, "Register with PayBox"), configures exact network hosts, environment variables and host-scoped brokered secret headers, runs hosted checks, tests tools, accepts the terms and selects **Submit Project** before 20:00 EDT.
4. After submission the plugin appears under "Unofficial plugins" in the owner's PayBox account for private testing. Public listing needs manual review of each version.

x402 inside a plugin: a tool returns `structuredContent["io.paybox/transactionProposal"]` with `kind: "x402"`, `chain` `eip155:8453` or `solana:mainnet`, `request { url, method, body? }`, `payment { asset, maxAmount }`, expiry within five minutes. "Custom headers and credential injection are not supported for these payment requests." PayBox fetches the live 402, checks asset and amount against the proposal, the user approves, and PayBox pays and retries.

`discover_services` curation: docs say curated results need "at least 10 unique payers in the last 30 days, and a supported x402 rail"; `raw: true` returns the uncurated Bazaar response. The catalogs are Coinbase Bazaar and pay.sh. How a new service enters Bazaar or pay.sh is not documented on PayBox docs. Unknown.

## 4. Card checkout

`request_payment` issues a Basis Theory one-time virtual card bound to `merchant_url`; `claim_payment_credentials` returns the card details once. To charge it, this merchant would need a card processor and would receive the card number, which puts our server in PCI DSS scope. No documented PayBox path lets a merchant receive a processor token instead of card details, and a processor-hosted checkout page needs a browser, not a headless agent.

Recommendation: card path OFF. `POST /checkout/card` is not mounted. The agent keeps a `CARD_PATH=off` flag; turning it on without a configured processor-hosted charger fails closed before `request_payment` is called.

## 5. Decisions

Stack:

- npm workspaces, Node 24 for deploy (local dev on Node 26), TypeScript, `zod@4.4.3` everywhere (matches the plugin starter pin).
- `packages/core`: engine, commit-reveal (`@noble/hashes` SHA-256 so browser and server compute the same hash), dialogue, zod schemas, typed events.
- `apps/merchant`: Hono on `@hono/node-server`, `@x402/core` `HTTPFacilitatorClient` behind a `Facilitator` adapter.
- `apps/agent`: `@paybox-sh/sdk@2.2.0` behind a `PayboxPort` adapter, plus a minimal MCP adapter for `discover_tokens` and `list_requests`.
- `apps/web`: Vite, TypeScript, `animejs@4`.
- `apps/plugin`: the hosted PayBox plugin from starter `v1.0.2`, adapted to npm.

Network and asset: USDC on Solana mainnet as the primary rail (the only wallet on this PayBox account is Solana), USDC on Base mainnet as the second rail. Both via the PayAI facilitator. Configured by `X402_NETWORKS`.

Protocol: every 402 carries both a v1 JSON body and a v2 `PAYMENT-REQUIRED` header. The merchant accepts `X-PAYMENT` (v1) and `PAYMENT-SIGNATURE` (v2).

Merchant API key and PayBox secrets:

- SDK agent channel: `/session`, `/offer`, `/checkout` require `X-Merchant-Key`. The agent calls `request_secret` with `raw: false` first and records the `secret_token` output type. No PayBox doc describes how a third-party merchant redeems a `secret_token`, so the agent then falls back to `raw: true`, holds the key in memory only and never logs it. Documented as a fallback.
- Plugin channel: `/session` requires `X-Merchant-Key`, injected by PayBox as a host-scoped brokered header (this is the documented PayBox-mediated egress). `/offer` and `/checkout` on plugin sessions are authorized by the verified x402 payment plus the unguessable session id, because PayBox x402 proposals cannot carry custom headers.

## 6. Unverified assumptions and adapter boundaries

| # | Assumption | Why unverified | Adapter |
| --- | --- | --- | --- |
| U1 | `secret_token` from `request_secret raw:false` can be redeemed by a third-party merchant | Not documented anywhere read | `SecretSource` in agent: token first, raw fallback |
| U2 | Shape of `output.value.x_payment` (docs: "header name and value") | Exact keys not in types (`value: unknown`) | `extractPaymentHeader()` accepts `{header,value}`, `{name,value}`, or a bare string |
| U3 | PayBox `payX402` v1 accepts v1 `solana` / `base` network names and `maxAmountRequired` | Not shown in docs or SDK types | Merchant serves v1 body and v2 header; agent passes `accepts` verbatim |
| U4 | Which x402 version the hosted-plugin x402 flow parses | Not stated in guide | Same dual 402 response |
| U5 | PayAI facilitator limits and long-term availability | Third-party service, free tier terms not read | `Facilitator` interface, URL from `X402_FACILITATOR_URL` |
| U6 | `get_portfolio` response shape | SDK returns `unknown`; MCP description lists fields | `readHolding()` parses defensively, treats unknown as "cannot confirm" |
| U7 | `discover_tokens` and `list_requests` over `/mcp` with a `pbx_live_*` bearer | Documented as same bearer, not exercised | `McpToolsPort` |
| U8 | `request_swap` semantics of `amount` with `exact-amount-out` | Docs define `amount` in source units only | Agent uses `exact-amount-in` only |
| U9 | Approval thresholds that trigger `pending_approval` | Set by the user in the PayBox app | Agent handles every status regardless |
| U10 | Path from a new x402 service into Bazaar or pay.sh curation | Not documented by PayBox | Merchant publishes `/.well-known/x402` discovery metadata; README lists manual steps |
| U11 | Testnet support in PayBox wallets | No testnet chain in any documented enum | Mainnet only, hard spend cap |

Not confirmable headlessly: passkey approvals and the signing window, real mainnet x402 payments, swaps and bridge settlement, MoonPay buy-link checkout, card path end to end, marketplace listing acceptance, visual quality.
