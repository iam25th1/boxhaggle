import { HumanLink, OutputTypeSchema } from "@boxhaggle/core";
import { loadConfig } from "./config.js";
import { Emitter } from "./emitter.js";
import { MockPaybox } from "./paybox-mock.js";
import { SdkPaybox } from "./paybox-sdk.js";
import type { EnvelopeObserver, PayboxPort } from "./port.js";
import { runShowcase } from "./run.js";
import { shortId } from "./util.js";

async function main(): Promise<number> {
  const config = loadConfig();
  const emitter = new Emitter(config.merchantUrl, config.relay);

  // Every envelope the port observes becomes a typed UI event. Only status,
  // request id, output type, a vetted approval link and an error string pass.
  const observer: EnvelopeObserver = (tool, envelope) => {
    const outputType = envelope.status === "success" ? OutputTypeSchema.safeParse(envelope.output?.output_type) : null;
    const approval = envelope.approval_url ? HumanLink.safeParse(envelope.approval_url) : null;
    emitter.emit({
      t: "paybox.envelope",
      tool,
      requestId: shortId(envelope.request_id),
      status: envelope.status,
      ...(outputType?.success ? { outputType: outputType.data } : {}),
      ...(approval?.success ? { approvalUrl: approval.data } : {}),
      ...(approval && !approval.success ? { message: "approval link withheld: unexpected host" } : {}),
      ...(envelope.error ? { message: String(envelope.error).slice(0, 200) } : {}),
    });
    if (tool === "request_swap") emitter.emit({ t: "swap.status", status: envelope.status, requestId: shortId(envelope.request_id) });
  };

  const port: PayboxPort = config.mock ? new MockPaybox(config, observer) : new SdkPaybox(config, observer);
  process.stdout.write(`BOXHAGGLE agent: ${port.label === "replay" ? "REPLAY (mock PayBox, no real funds)" : "LIVE"} against ${config.merchantUrl}, cap ${(config.spendCapAtomic / 1_000_000).toFixed(2)} USD\n`);

  const result = await runShowcase(config, port, emitter);
  process.stdout.write(
    `\nresult: ${result.outcome}  session ${result.sessionId ?? "none"}  final ${result.finalPrice ?? "-"}  fees ${result.fees}  spent ${result.spent} (atomic USDC)\n`,
  );
  if (result.sessionId) {
    process.stdout.write(`spectate: open the web app and pick Live, or add ?session=${result.sessionId}\n`);
  }
  return result.outcome === "aborted" ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`agent failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exit(1);
  },
);
