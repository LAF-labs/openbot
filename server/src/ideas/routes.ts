import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { type IdeaService, IdeaUnknownError } from "./service";

/**
 * 아이디어's two doors (muse-shape plan §3.3):
 *
 *   GET  /api/ideas               the cards for this person, in their order: keys and states
 *   POST /api/ideas/:key/dismiss  다음에 — the card does not come back
 *
 * Both a person's own, behind their session. No door here starts anything: a press puts a sentence
 * in the composer on the surface, and only the person's send reaches a model.
 */
export function createIdeaRoutes(
  service: IdeaService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) => {
    context.header("cache-control", "no-store");
    return context.json(await service.list(context.var.actor));
  });

  routes.post("/:key/dismiss", requireUser, async (context) => {
    try {
      await service.dismiss(context.var.actor, context.req.param("key"));
      return context.json({ dismissed: true });
    } catch (error) {
      if (error instanceof IdeaUnknownError) {
        return context.json({ error: error.code, code: error.code }, 404);
      }
      throw error;
    }
  });

  return routes;
}
