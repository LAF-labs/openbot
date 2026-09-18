import type { ShopProfile } from "@shared/shop/catalogue";
import type { QueryClient } from "@tanstack/react-query";
import { authKeys, type CurrentUserResult } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";
import { parseShop } from "@/lib/shop/catalogue";

/**
 * The shop answers, on the wire: read off `/api/me`, written through `PUT /api/me/shop`.
 *
 * NO QUERY OF THEIR OWN. Every screen that orders anything by them is drawn after `/api/me` has
 * answered — `_authed` waits for it before any of them renders — so they are on the current user
 * and in hand on the first frame. A second request would land after the intro card had dealt its
 * chips, and a hand that is re-dealt while somebody reads it is a screen changing its mind.
 */

/**
 * Replace the answer, and put what the server now holds onto the current user.
 *
 * Written into the cache rather than refetched: the answer is what the server read back after
 * saving, and a refetch of `/api/me` would be a second round trip to learn the same two facts.
 * The words of a failure are this surface's; the server sends a code.
 */
export async function saveShop(
  shop: ShopProfile,
  queryClient: QueryClient,
): Promise<ShopProfile> {
  let response: Response;
  try {
    response = await fetch("/api/me/shop", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: shop.kind, places: shop.places }),
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
    shop?: unknown;
  } | null;
  const held = parseShop(body?.shop);
  queryClient.setQueryData<CurrentUserResult>(
    authKeys.currentUser(),
    (current) =>
      current && typeof current === "object"
        ? { ...current, shop: held }
        : current,
  );
  return held;
}
