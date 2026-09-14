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
 * The three facts every route can answer before it does anything (`server/src/auth/guards.ts`).
 *
 * Read after the screen's own table, so any screen that asks gets them without listing them. They
 * were "Authentication required.", "Authorization required." and "Administrator access required."
 * until 2026-09-14, printed by whichever screen happened to reach one.
 */
export const ACCESS_REFUSALS: Record<string, string> = {
  "laf:unauthenticated":
    "You have been signed out. Sign in again and try once more.",
  "laf:no_access": "This account no longer has access here.",
  "laf:admin_required": "Only an administrator can do that.",
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
