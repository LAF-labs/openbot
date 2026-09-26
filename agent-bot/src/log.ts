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

/**
 * Whether a request that failed before a byte arrived is worth sending once more, now.
 *
 * A server error or a dropped connection, yes: the next attempt is usually answered. A 429 never —
 * a provider refusing wants waiting, and asking again at once is how one refusal became three
 * (CLAUDE.md, "Failures are not all the same failure"). Anything else with a status is a request
 * the provider will refuse the same way again. The OpenAI SDK used to decide this on its own,
 * twice, silently (`./provider`).
 */
export function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (status === undefined) {
    const name = error instanceof Error ? error.name : "";
    return name === "APIConnectionError";
  }
  return status === 408 || (status >= 500 && status <= 599);
}

/**
 * The HTTP status a provider's error carries, whatever client shape it arrived in.
 *
 * INCLUDING ONE SENT INSIDE THE STREAM, which has no status of its own. A provider that fails after
 * its response has begun — OpenRouter, whose response begins with a processing comment before the
 * model has answered — sends `data: {"error":{"code":429,…}}`, and the SDK throws that as an
 * `APIError` with `status` undefined and the provider's number in `code` (and in `error.code`).
 * Read by `.status` alone it was `laf:model_failed`, "ask again", in front of a rate limit —
 * measured 2026-09-26 against a local endpoint — and a 5xx sent that way was never retried. Only a
 * number in the HTTP range counts: `code` is also where Node puts `ECONNRESET`.
 */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const said = error as {
    status?: unknown;
    code?: unknown;
    error?: { code?: unknown } | null;
  };
  if (typeof said.status === "number") return said.status;
  return httpStatus(said.code) ?? httpStatus(said.error?.code);
}

function httpStatus(value: unknown): number | undefined {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{3}$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(number) && number >= 100 && number <= 599
    ? number
    : undefined;
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
