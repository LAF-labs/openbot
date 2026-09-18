/**
 * Where `describeFailure` was, kept as its address — and, since 2026-09-11, the one shape a refusal
 * takes when it crosses the HTTP boundary.
 *
 * The implementation of `describeFailure` moved to `shared/failure-text.ts` the day `agent-bot`
 * needed it for its own log line: that service's image carries `shared/` and nothing under
 * `server/`. Every server sink imports it from here as before, so the move is invisible to them and
 * to the test that pins the behaviour.
 *
 * THE REFUSAL SHAPE. Ten error classes across five modules each answered a route their own way — a
 * status here, a sentence there, a code on four of them — and audit A1 (2026-09-10) counted the
 * result on the wire: of thirty-six refusals, fourteen carried a `laf:` code and twenty-two were
 * English prose a Korean surface could not name. What every one of them has in common is written
 * down here once: a `laf:` code, an HTTP status, and whatever numbers or names ride beside the code
 * (a seat count, the address a confirmation expects). The words are the surface's; see CLAUDE.md.
 *
 * `httpRefusalOf` READS THE SHAPE, NOT THE CLASS. The boundary in `app.ts` catches whatever a route
 * threw, and importing every module's error class into the one file every module is mounted from is
 * the dependency knot audit A1's appendix A already lists. A thrown error that carries a `laf:` code
 * and a refusal status IS a refusal, whichever class it is.
 */
import { databaseCodeOf } from "../../shared/failure-text";

export {
  databaseCodeOf,
  describeFailure,
  noAnswerFact,
  providerStatusFact,
} from "../../shared/failure-text";

/** A code as the surface reads it. The prefix is what tells a fact from a sentence. */
export type RefusalCode = `laf:${string}`;

/** The statuses a refusal may carry. Anything else is not a refusal, it is a failure — 500. */
export type RefusalStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 413
  | 501
  | 502
  | 503
  | 504;

const REFUSAL_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 409, 413, 501, 502, 503, 504,
]);

export type HttpRefusal = {
  status: RefusalStatus;
  code: RefusalCode;
  /** What rides beside the code: numbers and names, never a sentence. */
  facts: Record<string, unknown>;
};

/**
 * The refusal a thrown error carries, or null for an error that is not one.
 *
 * A `status` outside the refusal set is not a refusal even with a code beside it: an error claiming
 * 200 or 500 is a bug, and a bug is answered as one.
 */
export function httpRefusalOf(error: unknown): HttpRefusal | null {
  if (!(error instanceof Error)) return null;
  const { code, status, facts } = error as {
    code?: unknown;
    status?: unknown;
    facts?: unknown;
  };
  if (typeof code !== "string" || !code.startsWith("laf:")) return null;
  if (typeof status !== "number" || !REFUSAL_STATUSES.has(status)) return null;
  return {
    status: status as RefusalStatus,
    code: code as RefusalCode,
    facts:
      facts && typeof facts === "object" && !Array.isArray(facts)
        ? (facts as Record<string, unknown>)
        : {},
  };
}

/**
 * The body the boundary answers a thrown error with: the code and its facts, and no `error` field.
 *
 * No `error`, deliberately. A route's own refusal answers `{ error: code, code }`, and a dozen
 * readers on the surface still render `error` as text wherever they have no words for the code —
 * which on a thrown error used to be a text/plain body they could not parse, and so their own
 * sentence. Carrying the code in `error` here would put `laf:internal` on those screens instead.
 */
export function refusalBody(refusal: HttpRefusal): Record<string, unknown> {
  return { ...refusal.facts, code: refusal.code };
}

/** What the boundary answers, with 500, for a failure nothing named. The log line says the rest. */
export const INTERNAL_FAILURE: RefusalCode = "laf:internal";

/** What the boundary answers for a path nothing is mounted on. */
export const NOT_FOUND: RefusalCode = "laf:not_found";

/** A value Postgres could not read as what the column holds: a request's doing, so a 400. */
export const BAD_VALUE: RefusalCode = "laf:bad_request";

/**
 * Whether a failed query failed on a VALUE rather than on the server.
 *
 * SQLSTATE class 22, "data exception": an id that is not a UUID aimed at a uuid column, a NUL byte
 * in text, a number out of range. Every one of them is what somebody sent, and a 500 for it tells
 * the surface the server broke when the request was what could not be read. Everything else a
 * query can fail on — a constraint, a missing table, a lost connection — stays a 500.
 */
export function isBadValue(error: unknown): boolean {
  return databaseCodeOf(error)?.startsWith("22") ?? false;
}
