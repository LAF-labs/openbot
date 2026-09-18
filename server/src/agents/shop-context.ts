import type { ShopProfile } from "../../../shared/shop/catalogue";
import type { LoadAgentsForActor } from "../copilot";
import { log } from "../log";

/**
 * The shop answers, carried on every Bot's profile so the prompt can say them.
 *
 * WHY A WRAPPER, the same reason `granted-skills.ts` is one: the loader reads what a Bot IS; this
 * is a fact about the PERSON asking, read once per request for their whole roster rather than once
 * per Bot, and never inside the prompt middleware, which is synchronous AG-UI. Every run path —
 * the chat runtime, a routine, a room's turn, one Bot asking another — resolves its agents through
 * the loader this wraps (`main.ts`), so every run of every Bot carries the same line.
 *
 * READ ON EVERY REQUEST, so an answer changed in Settings is what the very next run is told.
 *
 * A READ THAT FAILS IS LOGGED AND THE RUN GOES ON WITHOUT THE LINE. The line is context, not
 * permission: nothing about whether an action stops for a person depends on it, and a Bot that
 * cannot answer because one optional fact could not be read is a worse failure than a Bot that
 * answers without it.
 */
export function withShopProfile(
  loadAgents: LoadAgentsForActor,
  readShop: (userId: string) => Promise<ShopProfile>,
): LoadAgentsForActor {
  return async (actor) => {
    const registered = await loadAgents(actor);
    const remote = registered.filter((agent) => agent.type === "remote_ag_ui");
    if (remote.length === 0) return registered;

    let shop: ShopProfile;
    try {
      shop = await readShop(actor.id);
    } catch (error) {
      log.warn("shop_read_failed", { error });
      return registered;
    }
    if (shop.kind === null && shop.places.length === 0) return registered;
    for (const agent of remote) agent.profile.shop = shop;
    return registered;
  };
}
