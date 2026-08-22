import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  RoutineError,
  type RoutineInput,
  type RoutineService,
} from "./service";

/**
 * The routines surface: create, list, arm, run now, read the recent runs.
 *
 * Thin by design — every rule lives in the service, so a second surface (the Bot proposing its own
 * routine, one day) enforces the same limits by construction.
 */
export function createRoutineRoutes(
  service: RoutineService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  const mapError = (error: unknown) => {
    if (error instanceof RoutineError)
      return { body: { error: error.message }, status: error.status };
    throw error;
  };

  routes.get("/", requireUser, async (context) =>
    context.json({ routines: await service.list() }),
  );

  routes.post("/", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as
      | (Partial<RoutineInput> & { schedule?: RoutineInput["schedule"] })
      | null;
    if (!body?.agentId || !body.schedule) {
      return context.json({ error: "Name a Bot and a schedule." }, 400);
    }
    try {
      const routine = await service.create(context.var.actor, {
        agentId: String(body.agentId),
        name: String(body.name ?? ""),
        instruction: String(body.instruction ?? ""),
        schedule: body.schedule,
      });
      return context.json({ routine }, 201);
    } catch (error) {
      const mapped = mapError(error);
      return context.json(mapped.body, mapped.status);
    }
  });

  /**
   * The webhook. Deliberately NOT behind requireUser: the caller is a machine holding the token
   * that was shown once at creation. The token rides a header, never the URL — URLs land in access
   * logs, referrers and browser history, and a capability that gets logged is a capability shared
   * with everyone who can read the log.
   */
  routes.post("/:id/trigger", async (context) => {
    const token = context.req.header("x-trigger-token") ?? "";
    if (!token) {
      return context.json({ error: "The trigger token is missing." }, 401);
    }
    const payload = await context.req.text().catch(() => "");
    try {
      const outcome = await service.trigger(
        context.req.param("id"),
        token,
        payload,
      );
      // 202: the run was accepted and is happening; the sender is not kept on the line for it.
      if (outcome.ran) return context.json({ ran: true }, 202);
      return context.json(outcome);
    } catch (error) {
      const mapped = mapError(error);
      return context.json(mapped.body, mapped.status);
    }
  });

  routes.get("/:id/runs", requireUser, async (context) =>
    context.json({ runs: await service.runs(context.req.param("id")) }),
  );

  routes.post("/:id/enabled", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      enabled?: unknown;
    } | null;
    try {
      const routine = await service.setEnabled(
        context.req.param("id"),
        body?.enabled === true,
      );
      return context.json({ routine });
    } catch (error) {
      const mapped = mapError(error);
      return context.json(mapped.body, mapped.status);
    }
  });

  routes.post("/:id/run", requireUser, async (context) => {
    try {
      await service.runNow(context.req.param("id"));
      return context.json({ ran: true });
    } catch (error) {
      const mapped = mapError(error);
      return context.json(mapped.body, mapped.status);
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    try {
      await service.remove(context.req.param("id"));
      return context.json({ removed: true });
    } catch (error) {
      const mapped = mapError(error);
      return context.json(mapped.body, mapped.status);
    }
  });

  return routes;
}
