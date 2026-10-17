import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { HttpFacilitator, LocalEvmFacilitator } from "./x402/facilitator.js";

const config = loadConfig();
const log = createLogger(config.logLevel);
const facilitator =
  config.facilitatorMode === "http" ? new HttpFacilitator(config.facilitatorUrl, config.facilitatorToken) : new LocalEvmFacilitator();

if (facilitator.mode === "local") log.warn("FACILITATOR_MODE=local: payments are verified in-process and never settled on chain");

const { app } = createApp({ config, facilitator, log });

// Warm the Solana fee payer cache so the first 402 already offers every rail.
void facilitator.feePayers().then((fp) => log.info("facilitator ready", { mode: facilitator.mode, solanaFeePayer: Boolean(fp.solana) }));

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  log.info("merchant listening", { host: config.host, port: info.port, rails: config.rails, env: config.env });
});

const shutdown = () => {
  log.info("shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
