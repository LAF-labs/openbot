/**
 * What a failure is allowed to say once it leaves the place it happened.
 *
 * Six sinks stored `error.message` verbatim — the append-only trail, a run's `error` column, the
 * operator log, an HTTP 500 body — and every one of them received a Drizzle query error at least once.
 * Drizzle's wrapper puts the SQL it sent AND its bound parameters into `message`: a failed credential
 * write carried the encrypted envelope, a failed message append carried the whole conversation. The
 * trail cannot be edited afterwards (that is the point of it), so the copy was permanent.
 *
 * One helper, so a sink cannot get this wrong by forgetting. A query error becomes its PostgreSQL
 * code, which is what an operator actually needs; every other error keeps its message, on one line
 * and bounded, because a message that runs to a megabyte is the other way a trail row goes wrong.
 *
 * HERE RATHER THAN IN `server/src`, since 2026-09-06, because the second sink that needed it was
 * `agent-bot`'s own log, and that service's image carries `shared/` and nothing of the server. The
 * server re-exports it from where it was.
 *
 * A MODEL PROVIDER'S ERROR IS THE THIRD KIND. The OpenAI client throws an `APIError` whose message
 * is the status code followed by the provider's own body — and that body names the vendor, the
 * model's real catalogue entry and its URLs ("This model was ZAI's GLM-5.3 Flash… openrouter.ai/…",
 * measured on the wire the day the stealth alpha died). The product's model is served under a name
 * only we choose, so the log says what KIND of failure it was, which is also the only part an
 * operator acts on: a rate limit wants waiting, a refused key wants the key checked, and neither
 * wants the sentence.
 */
const MAX_CHARS = 200;

type QueryShaped = { query?: unknown; params?: unknown; cause?: unknown };

function isQueryError(error: Error): boolean {
  const shaped = error as Error & QueryShaped;
  return (
    error.constructor?.name === "DrizzleQueryError" ||
    (typeof shaped.query === "string" && Array.isArray(shaped.params))
  );
}

/** The `code` PostgreSQL attached, if the driver kept it. `23505` says more than "insert failed". */
function postgresCode(error: Error & QueryShaped): string | null {
  const candidates = [error, error.cause];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && "code" in candidate) {
      const code = (candidate as { code: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    }
  }
  return null;
}

/**
 * The OpenAI client's error family, by the names its classes carry.
 *
 * Recognised by shape rather than `instanceof`: the package is `agent-bot`'s dependency, and this
 * module is read by two services that do not have it. The client never sets `error.name`, so the
 * constructor's name is the one that is readable; the own-property triple is the fallback for a
 * bundler that renamed the class.
 */
const PROVIDER_ERROR_NAMES = new Set([
  "OpenAIError",
  "APIError",
  "APIUserAbortError",
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "BadRequestError",
  "AuthenticationError",
  "PermissionDeniedError",
  "NotFoundError",
  "ConflictError",
  "UnprocessableEntityError",
  "RateLimitError",
  "InternalServerError",
  "LengthFinishReasonError",
  "ContentFilterFinishReasonError",
]);

function isProviderError(error: Error): boolean {
  if (PROVIDER_ERROR_NAMES.has(error.constructor?.name ?? "")) return true;
  return (
    Object.hasOwn(error, "status") &&
    Object.hasOwn(error, "headers") &&
    Object.hasOwn(error, "error")
  );
}

/**
 * What an HTTP status from a model provider means, as the fact an operator acts on.
 *
 * Every value is a closed word: nothing the provider wrote reaches the caller. The status rides
 * beside the word where it disambiguates — a 503 and a 502 want the same wait, a 400 and a 404 do
 * not want the same fix. Shared by the SDK path (`agent-bot`) and the hand-written call
 * (`server/src/computer/model-call.ts`), so a 429 reads the same whichever road it came by.
 */
export function providerStatusFact(status: number): string {
  if (status === 429) return "provider_rate_limited";
  if (status === 401 || status === 403) return "provider_refused";
  if (status >= 500) return `provider_unavailable (${status})`;
  return `provider_rejected_request (${status})`;
}

/** The same, for the OpenAI client's error family. */
export function describeProviderFailure(error: Error): string {
  const name = error.constructor?.name ?? "";
  const status = (error as { status?: unknown }).status;
  if (name === "APIConnectionTimeoutError") return "provider_timed_out";
  if (name === "APIConnectionError") return "provider_unreachable";
  if (name === "APIUserAbortError") return "request_aborted";
  if (typeof status === "number") return providerStatusFact(status);
  // `OpenAIError` proper and the two finish-reason errors: the stream could not be read, the
  // answer was cut off or filtered, or the SDK refused the request before it was sent. Either way
  // the model did not answer usably.
  return "reply_unusable";
}

export function describeFailure(error: unknown, limit = MAX_CHARS): string {
  if (!(error instanceof Error)) return "Something went wrong.";
  if (isQueryError(error)) {
    const code = postgresCode(error);
    return code ? `database error (${code})` : "database error";
  }
  if (isProviderError(error)) return describeProviderFailure(error);
  const line = error.message.replace(/\s+/g, " ").trim();
  if (!line) return error.name || "Error";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/**
 * The same closed words for `askModel`'s `NoAnswer`, which is not an error and never was one.
 *
 * `model-call.ts` returns why there is no answer as one of four phrases a caller can act on; a log
 * line wants them as the facts the provider errors above already use, so a 429 reads the same
 * whether it came through the SDK or through the hand-written call.
 */
export function noAnswerFact(because: string): string {
  switch (because) {
    case "no credential":
      return "no_credential";
    case "refused":
      return "provider_refused";
    case "took too long":
      return "provider_timed_out";
    case "unreadable":
      return "reply_unusable";
    default:
      return because.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  }
}
