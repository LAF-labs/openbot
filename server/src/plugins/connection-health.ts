import {
  type ConnectionFailureCode,
  type ConnectionHealth,
  INVALID_CLIENT,
  iso,
  PluginRefusedError,
  TokenRefusedError,
} from "./store";

/**
 * Whether a connection still works, decided in ONE place.
 *
 * Two lies were measured on 2026-09-10 (audit A9, F2 and F3), and they were opposite lies from the
 * same cause — the judgement was spread over a classifier here, a status read there and a call path
 * that judged nothing at all:
 *
 *  - a vendor's token endpoint answering 503 or 429 was written as `refresh_failed`, so one five
 *    minute outage at Google put every connection on the VM behind 다시 연결, and left it there
 *    after Google came back;
 *  - a vendor's API answering 401 after a perfectly good token exchange was written as nothing,
 *    so a grant missing a scope, or an account whose administrator had blocked the app, drew 연결됨
 *    forever while every call failed — the exact lie `laf:needs_reconnect` was introduced to stop.
 *
 * So every reason a call can fail is judged by {@link judgeHealth}, and only there. The exchange
 * path hands it the error it caught; the call path hands it the status the vendor answered. Nobody
 * reads a sentence, and nobody outside this file decides what a status means.
 */

/**
 * Why a call did not work, as the two places that know hand it in.
 *
 * `exchange` is the token endpoint refusing or failing to answer — everything thrown out of
 * `connectionTokenFor`. `vendor` is the API answering after the exchange succeeded: the token was
 * minted, presented, and this is what came back.
 */
export type HealthReason =
  | { at: "exchange"; error: unknown }
  | { at: "vendor"; status: number };

/**
 * A status that says the vendor is not able to answer right now, whoever is asking.
 *
 * 429 and every 5xx. RFC 6749 §5.2 reserves 400 for a refusal of the grant and 401 for a refusal
 * of the client; nothing about a person's connection is decided by a status that is not one of
 * those two, and a token endpoint behind a maintenance page answers 503 with an HTML body that a
 * defensive reader turns into whatever `error` code it happens to find.
 */
const isUnavailable = (status: number | null | undefined): boolean =>
  status === 429 || (typeof status === "number" && status >= 500);

/**
 * Which of our three failures this is, or nothing when it is not this connection's failure at all.
 *
 * READ OFF THE ERROR CLASS, THE PROTOCOL CODE AND THE STATUS, never off the sentence. The vendor's
 * prose is written for whoever registered the client and is in whatever language that vendor
 * writes; a classifier that read it would be one rewording away from calling every revoked grant
 * a transient outage.
 *
 * The table, in the order it is asked:
 *
 * | reason                                      | code             | status                |
 * |---------------------------------------------|------------------|-----------------------|
 * | exchange · a refusal of OURS                | —                | untouched             |
 * | exchange · `invalid_client`                 | —                | untouched (see below) |
 * | exchange · token endpoint 429 / 5xx         | `vendor_down`    | ok, retry later       |
 * | exchange · `invalid_grant` (RFC 6749 §5.2)  | `revoked`        | needs_reconnect       |
 * | exchange · any other refusal                | `refresh_failed` | needs_reconnect       |
 * | exchange · timeout, DNS, HTML for a token   | `vendor_down`    | ok, retry later       |
 * | vendor · 401                                | `refresh_failed` | needs_reconnect       |
 * | vendor · 429 / 5xx                          | `vendor_down`    | ok, retry later       |
 * | vendor · anything else                      | —                | untouched             |
 *
 * `invalid_client` is recorded NOWHERE, and it is the most important line. It is the vendor
 * disowning the DEPLOYMENT's client rather than saying anything about this person's grant — every
 * connection in the deployment gets it at once — and it is also, as `oauth-client.ts` measured,
 * what a vendor that is simply down answers every exchange with. It already has an owner:
 * `refuseAndReplaceEvictedClient` registers this deployment again and refuses the call.
 *
 * A vendor 403 is deliberately nothing. Google answers 403 both for an API that is not enabled for
 * the project and for a scope the grant does not carry; the first is not the person's to fix and
 * the second is, and the status cannot tell them apart. The vendor's own sentence stays on the
 * result, where it names which.
 *
 * A refusal of OURS returns nothing: `PluginRefusedError` here means the connection was withdrawn
 * or removed while the call queued, and there is either no row left to write to or nothing new to
 * say about it.
 */
export function judgeHealth(
  reason: HealthReason,
): ConnectionFailureCode | null {
  if (reason.at === "vendor") {
    if (reason.status === 401) return "refresh_failed";
    return isUnavailable(reason.status) ? "vendor_down" : null;
  }
  const { error } = reason;
  if (error instanceof PluginRefusedError) return null;
  if (error instanceof TokenRefusedError) {
    if (error.code === INVALID_CLIENT) return null;
    if (isUnavailable(error.status)) return "vendor_down";
    return error.code === "invalid_grant" ? "revoked" : "refresh_failed";
  }
  return "vendor_down";
}

/**
 * Whether a recorded failure is one a person has to answer.
 *
 * Two callers ask it — the refusal before the vendor is contacted, and the status the settings page
 * draws — and they must never disagree. A screen saying 연결됨 in front of a tool path that refuses
 * with "connect again" is the exact lie this whole module exists to remove, and two expressions of
 * the same rule is how it comes back.
 */
export const needsReconnect = (code: string | null): boolean =>
  code === "revoked" || code === "refresh_failed";

/** The column narrowed to a code this build knows, or null. Text in, closed set out. */
export const knownFailureCode = (
  code: unknown,
): ConnectionFailureCode | null =>
  code === "revoked" || code === "refresh_failed" || code === "vendor_down"
    ? code
    : null;

/**
 * The health of one connection, from the three columns that hold it.
 *
 * `vendor_down` is carried even though the status is `ok`, because it is a fact worth having: a
 * screen can say 잠시 문제가 있었어요 without telling anybody to go and reconnect. A value this
 * build does not know is no code at all rather than one the surface has no words for.
 */
export function healthOf(row: {
  lastOkAt: Date | string | null;
  lastFailureAt: Date | string | null;
  lastFailureCode: string | null;
}): ConnectionHealth {
  return {
    status: needsReconnect(row.lastFailureCode) ? "needs_reconnect" : "ok",
    lastOkAt: iso(row.lastOkAt),
    lastFailureAt: iso(row.lastFailureAt),
    failureCode: knownFailureCode(row.lastFailureCode),
  };
}

/**
 * The same, from a health another reader serialised — or the healthy reading when nothing says
 * anything.
 *
 * For the overview, which composes rows it did not query. Read defensively: a field this build
 * does not recognise fails towards `ok`, because "다시 연결 필요" on every healthy account is the
 * worst possible way to be wrong about a connection.
 */
export function healthFrom(said: unknown): ConnectionHealth {
  const record =
    said && typeof said === "object" ? (said as Record<string, unknown>) : null;
  const text = (value: unknown): string | null =>
    typeof value === "string" && value ? value : null;
  return {
    status: record?.status === "needs_reconnect" ? "needs_reconnect" : "ok",
    lastOkAt: text(record?.lastOkAt),
    lastFailureAt: text(record?.lastFailureAt),
    failureCode: knownFailureCode(record?.failureCode),
  };
}
