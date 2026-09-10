import { describeFailure, providerStatusFact } from "../../shared/failure-text";
import { createLogger } from "../../shared/log";

/**
 * This service's log, and what a failed run is allowed to say.
 *
 * Facts only — see `shared/log.ts` for the shape and what is scrubbed. What it replaced:
 * `console.error("… run failed:", error)` with the OpenAI client's error object, which Bun prints
 * whole — the provider's body (vendor, catalogue name, URLs), the response headers and the stack.
 * The line says which KIND of failure it was now (`describeFailure`), and nothing the provider
 * wrote.
 */
export const log = createLogger("agent-bot");

/**
 * The closed set a failed run may report, and how a provider failure lands in it.
 *
 * `laf:` because the surface translates exactly these and shows anything else verbatim — a prefix
 * an English sentence can never accidentally carry is what keeps the two apart. This only covers
 * what THIS service's provider throws; the codes a run ends on for its own reasons (a stream cut,
 * a tool loop) are named where they are decided, in `./run`.
 */
export function runErrorCodeOf(error: unknown): string {
  const status = statusOf(error);
  if (status === 429) return "laf:model_rate_limited";
  if (typeof status === "number") return "laf:model_unavailable";
  return "laf:model_failed";
}

/** The HTTP status a provider's error carries, whatever client shape it arrived in. */
export function statusOf(error: unknown): number | undefined {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  return typeof status === "number" ? status : undefined;
}

/**
 * What the log says a failed run failed of.
 *
 * Everything caught around the provider call is the provider's, so a status alone is enough to
 * name the kind — `describeFailure` asks for the OpenAI client's full shape before it will, and a
 * status-bearing error from any other client would otherwise keep its message, which for a
 * provider is `429 ` followed by the provider's own sentence.
 */
export function runFailureOf(error: unknown): string {
  const status = statusOf(error);
  return status === undefined
    ? describeFailure(error)
    : providerStatusFact(status);
}
