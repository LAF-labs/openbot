import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { isGoalStatus } from "../../../shared/goals";
import type { AppVariables } from "../auth/guards";
import { GoalNotFound, type GoalStore } from "./store";

/**
 * 목표's doors (muse-shape plan §3.4, phase 9), every one the person's own, behind their session:
 *
 *   GET    /api/goals        every goal, active first, with how many are active
 *   GET    /api/goals/:id    one goal and its timeline
 *   PATCH  /api/goals/:id    {status}: 완료, 그만두기, 다시 진행 — the person's, never a tool's
 *   DELETE /api/goals/:id    gone, with its timeline; linked routines stay, unlinked
 *
 * Facts only; the surface owns the words. Nothing here makes a goal: a goal is made in the
 * conversation, after the person's yes (`tools.ts`).
 */
export function createGoalRoutes(
  store: Pick<GoalStore, "list" | "get" | "setStatus" | "remove">,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const notFound = { error: "laf:goal_not_found", code: "laf:goal_not_found" };

  routes.get("/", requireUser, async (context) => {
    context.header("cache-control", "no-store");
    const goals = await store.list(context.var.actor.id);
    return context.json({
      goals,
      active: goals.filter((goal) => goal.status === "active").length,
    });
  });

  routes.get("/:id", requireUser, async (context) => {
    context.header("cache-control", "no-store");
    const found = await store.get(
      context.var.actor.id,
      context.req.param("id"),
    );
    return found ? context.json(found) : context.json(notFound, 404);
  });

  routes.patch("/:id", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      status?: unknown;
    } | null;
    if (!isGoalStatus(body?.status)) {
      return context.json(
        {
          error: "laf:goal_invalid",
          code: "laf:goal_invalid",
          field: "status",
        },
        400,
      );
    }
    try {
      return context.json(
        await store.setStatus(
          context.var.actor.id,
          context.req.param("id"),
          body.status,
        ),
      );
    } catch (error) {
      if (error instanceof GoalNotFound) return context.json(notFound, 404);
      throw error;
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    const removed = await store.remove(
      context.var.actor.id,
      context.req.param("id"),
    );
    return removed
      ? context.json({ removed: true })
      : context.json(notFound, 404);
  });

  return routes;
}
