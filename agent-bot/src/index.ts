/**
 * The Bot service, by module.
 *
 * This file was 983 lines and one function: `runAgent` was 569 of them, all inside one
 * `new ReadableStream({ start })` closure, six levels deep — the provider client, the transcript
 * conversion and its budget, the streaming translation, the bridge round loop, the empty-answer
 * retry, the token metering, the log, the HTTP server and the signal handlers. Every fix to the
 * loop landed in the same closure. It is now:
 *
 * - `provider.ts`   the model, the endpoint, and the one call this service makes (the test seam)
 * - `transcript.ts` AG-UI messages → the provider's shape, with the context budget
 * - `turn.ts`       one request, streamed out as AG-UI events as it arrives
 * - `run.ts`        the loop: rounds, retries, the bridge's answers, what a run ends on
 * - `guards.ts`     what the loop answers instead of forwarding, and the bounds on one question
 * - `log.ts`        this service's log and the closed set of codes a failed run may report
 * - `server.ts`     the HTTP service, the boot refusal, the shutdown line
 *
 * Importing this module — a test driving `runAgent` against a fake provider — must not bind a
 * port, or the second test file in a run fails with EADDRINUSE against the first. Only the
 * process started as the service does.
 */
import { startServer } from "./server";

export { runErrorCodeOf } from "./log";
export type { CompletionProvider } from "./provider";
export { runAgent } from "./run";
export { botIdOf, toProviderMessages } from "./transcript";

if (import.meta.main) startServer();
