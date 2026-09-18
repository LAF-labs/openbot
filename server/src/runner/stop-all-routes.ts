import { Hono, type MiddlewareHandler } from "hono";
import { type AppVariables, mayDriveBot } from "../auth/guards";
import type { StopAll } from "./stop-all";

/**
 * The two doors behind `모두 멈추기`: what is going on, and stop it all.
 *
 * Under `/api/me`, because both are about the person asking and nobody else. The read is its own
 * door rather than a dry run of the stop, so that opening the confirm dialog changes nothing — the
 * number it shows is counted the same way the stop counts, from the same list.
 *
 * Both ask the request's own `mayDriveBot`, the ownership rule every door a Bot id opens asks.
 */
export function createStopAllRoutes(
  stopAll: StopAll,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/me/running", requireUser, async (context) =>
    context.json(
      await stopAll.running(context.var.actor, (botId) =>
        mayDriveBot(context, botId),
      ),
    ),
  );

  routes.post("/me/stop-all", requireUser, async (context) =>
    context.json(
      await stopAll.stopAll(context.var.actor, (botId) =>
        mayDriveBot(context, botId),
      ),
    ),
  );

  return routes;
}
