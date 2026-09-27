import { type Persona, personaFrom } from "@shared/persona";
import type { QueryClient } from "@tanstack/react-query";
import { authKeys, type CurrentUserResult } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";

/**
 * Who the person is, on the wire: read off `/api/me`, written through `PUT /api/me/persona`.
 *
 * The same shape `saveShop` has, for the same reason: every screen that orders anything by it is
 * drawn after `/api/me` answered, so what the server holds after the save is written straight onto
 * the current user rather than refetched — the chips re-deal once, on the press that caused it.
 *
 * ONLY A PERSON'S PRESS CALLS THIS: the greeting's rows and Settings' 나는 row. No tool handler may
 * (`server/tests/shop-boundary.test.ts` walks them for `savePersona`).
 */
export async function savePersona(
  persona: Persona | null,
  queryClient: QueryClient,
): Promise<Persona | null> {
  let response: Response;
  try {
    response = await fetch("/api/me/persona", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persona }),
    });
  } catch {
    throw new Error(
      t("That was not saved. Check the connection and try again."),
    );
  }
  if (!response.ok) {
    throw new Error(t("That was not saved. Try again."));
  }
  const body = (await response.json().catch(() => null)) as {
    persona?: unknown;
  } | null;
  const held = personaFrom(body?.persona);
  queryClient.setQueryData<CurrentUserResult>(
    authKeys.currentUser(),
    (current) =>
      current && typeof current === "object"
        ? { ...current, persona: held }
        : current,
  );
  return held;
}
