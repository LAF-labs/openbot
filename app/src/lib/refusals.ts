import { t } from "@/lib/i18n";

/**
 * The words for a refused request, where the server sent a code and this surface owns the sentence.
 *
 * The server answers every refusal `{ error: code, code, …facts }` (`server/tests/error-codes.test.ts`
 * walks all of `server/src` for it). A screen looks the code up in its own table and falls back to
 * its own sentence — never to the server's `error`, which is the code itself and would print
 * `laf:…` on the screen.
 */

/**
 * The facts every route can answer before it does anything (`server/src/auth/guards.ts`).
 *
 * Read after the screen's own table, so any screen that asks gets them without listing them. They
 * were "Authentication required.", "Authorization required." and "Administrator access required."
 * until 2026-09-14, printed by whichever screen happened to reach one. The fourth,
 * `laf:session_revoked`, is a session taken away (`server/src/auth/session-revocation.ts`); the
 * session gate takes the person to the door with it, and a screen that reads it first says the same.
 */
export const ACCESS_REFUSALS: Record<string, string> = {
  "laf:unauthenticated":
    "You have been signed out. Sign in again and try once more.",
  "laf:no_access": "This account no longer has access here.",
  "laf:admin_required": "Only an administrator can do that.",
  "laf:session_revoked":
    "This account's access here was taken away, so it was signed out. If that is a mistake, ask whoever manages this place.",
};

/**
 * The words for a refusal's code out of a screen's table, or the screen's own sentence.
 *
 * `t()` on a variable, so each table is walked by a test of its own — the coverage walk only sees a
 * literal argument.
 */
export function refusalText(
  table: Record<string, string>,
  code: unknown,
  fallback: string,
): string {
  const known =
    typeof code === "string"
      ? (table[code] ?? ACCESS_REFUSALS[code])
      : undefined;
  return known ? t(known) : fallback;
}

/**
 * A request the server refused, as something a query or a mutation can throw: this surface's own
 * sentence as the message, and the server's two facts beside it.
 *
 * THE FACTS ARE WHAT A SCREEN DECIDES BY. Every read used to throw `new Error(sentence)`, which kept
 * the words and dropped the code — so a screen could not tell "this place has no memory store"
 * (`laf:not_found`, which retrying never fixes) from a dropped connection (which it does), and drew
 * both the same way. `readingOf` (`lib/reading.ts`) reads `code` off whatever was thrown.
 */
export class RequestRefusedError extends Error {
  readonly status: number;
  /** The `laf:` fact the body carried, or null for a body with none — a proxy's page, a bare 500. */
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "RequestRefusedError";
    this.status = status;
    this.code = code;
  }
}

/** A refused response read into that error. A body that is not JSON carries no code. */
export async function refusedRequest(
  response: Response,
  message: string,
): Promise<RequestRefusedError> {
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
  } | null;
  return new RequestRefusedError(
    message,
    response.status,
    typeof body?.code === "string" ? body.code : null,
  );
}

/** The same, read off a refused response's body. A body that is not JSON is the fallback. */
export async function refusalFrom(
  response: Response,
  table: Record<string, string>,
  fallback: string,
): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
  } | null;
  return refusalText(table, body?.code, fallback);
}
