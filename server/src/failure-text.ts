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

export function describeFailure(error: unknown, limit = MAX_CHARS): string {
  if (!(error instanceof Error)) return "Something went wrong.";
  if (isQueryError(error)) {
    const code = postgresCode(error);
    return code ? `database error (${code})` : "database error";
  }
  const line = error.message.replace(/\s+/g, " ").trim();
  if (!line) return error.name || "Error";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}
