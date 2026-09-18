/**
 * What kind of business the person runs and where they work every day — kept, and changed.
 *
 * The first run asks it (`app/src/routes/_authed/welcome.tsx`) and Settings → 내 가게 changes it;
 * both write through `PUT /api/me/shop` and nothing else writes at all. That is the whole security
 * property, and it is structural rather than checked: the only caller of `save` is the route below,
 * the route needs a person's session, and no tool any Bot holds posts to it
 * (`server/tests/shop-boundary.test.ts` walks the tool handlers to say so). A Bot that could rewrite
 * what it is told about the business it works for would be writing its own brief.
 *
 * Read on `/api/me`, beside who is asking, and on every run by `agents/shop-context.ts`.
 *
 * A store rather than a query in the route, because `app.ts` takes services and never a connection.
 */
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  EMPTY_SHOP,
  parseShopAnswer,
  type ShopProfile,
  shopFrom,
} from "../../../shared/shop/catalogue";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { users } from "../db/schema";

export type ShopStore = {
  /** Nothing answered — or nobody by that id — reads as the empty answer. Never throws on a miss. */
  read: (userId: string) => Promise<ShopProfile>;
  /** Replace the answer whole, and hand back what is held now. */
  save: (userId: string, shop: ShopProfile) => Promise<ShopProfile>;
};

export function createShopStore(database: Database): ShopStore {
  const read = async (userId: string): Promise<ShopProfile> => {
    const [row] = await database
      .select({ kind: users.businessKind, places: users.dailyPlaces })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row ? shopFrom(row.kind, row.places) : EMPTY_SHOP;
  };
  return {
    read,
    save: async (userId, shop) => {
      await database
        .update(users)
        .set({ businessKind: shop.kind, dailyPlaces: [...shop.places] })
        .where(eq(users.id, userId));
      // Read back rather than echoed: what the person is shown is what every Bot will be told.
      return read(userId);
    },
  };
}

/**
 * `PUT /api/me/shop`, mounted under `/api`.
 *
 * PUT, AND WHOLE. The two answers are sent together every time — the first run's two screens and
 * Settings each hold both — so the stored answer is exactly the last one a person saw on a screen,
 * and there is no partial update whose other half somebody has to reason about.
 */
export function createShopRoutes(
  store: ShopStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.put("/me/shop", requireUser, async (context) => {
    const parsed = parseShopAnswer(await context.req.json().catch(() => null));
    if (!parsed.ok) {
      return context.json({ error: parsed.code, code: parsed.code }, 400);
    }
    const shop = await store.save(context.var.actor.id, parsed.value);
    return context.json({ shop });
  });

  return routes;
}
