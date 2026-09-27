import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { FeedPostNotFound, type FeedStore } from "./store";

/**
 * 소식's doors (muse-shape plan §3.2, phase 7), every one the person's own, behind their session:
 *
 *   GET  /api/feed?cursor=      the posts, newest first, with the unseen count and the 소식 routines
 *   GET  /api/feed/unseen       the count alone, for the sidebar's row and the phone's tab
 *   POST /api/feed/seen         {ids}: the page showed these
 *   POST /api/feed/:id/like     {liked}: 좋아요 on or off
 *   POST /api/feed/:id/hide     {hidden}: 숨기기, or its undo
 *
 * Facts only; the surface owns the words. Nothing here starts a run: 소식 is made on Routines' door
 * (`POST /api/routines` with `delivery: "feed"`), and 지금 만들기 is that routine's run-now.
 */
export function createFeedRoutes(
  store: FeedStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) => {
    context.header("cache-control", "no-store");
    return context.json(
      await store.page(
        context.var.actor.id,
        context.req.query("cursor") ?? null,
      ),
    );
  });

  routes.get("/unseen", requireUser, async (context) => {
    context.header("cache-control", "no-store");
    return context.json({ count: await store.unseen(context.var.actor.id) });
  });

  routes.post("/seen", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      ids?: unknown;
    } | null;
    const ids = Array.isArray(body?.ids)
      ? body.ids
          .filter((id): id is string => typeof id === "string")
          .slice(0, 100)
      : [];
    return context.json({
      seen: await store.seen(context.var.actor.id, ids),
    });
  });

  const pressed = (verb: "like" | "hide", field: "liked" | "hidden") =>
    routes.post(`/:id/${verb}`, requireUser, async (context) => {
      const body = (await context.req.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      const on = body?.[field] !== false;
      try {
        const state =
          verb === "like"
            ? await store.like(
                context.var.actor.id,
                context.req.param("id"),
                on,
              )
            : await store.hide(
                context.var.actor.id,
                context.req.param("id"),
                on,
              );
        return context.json(state);
      } catch (error) {
        if (error instanceof FeedPostNotFound) {
          return context.json({ error: error.code, code: error.code }, 404);
        }
        throw error;
      }
    });
  pressed("like", "liked");
  pressed("hide", "hidden");

  return routes;
}
