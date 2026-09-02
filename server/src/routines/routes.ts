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

  /**
   * The refusal as the surface reads it: a fact code where there is one, the sentence beside it.
   *
   * The code is what the app renders Korean from; `error` stays for operators, logs and anything
   * that arrives before the surface knows the code. Server prose does not cross to the screen.
   */
  const mapError = (error: unknown) => {
    if (error instanceof RoutineError) {
      return {
        body: {
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
        },
        status: error.status,
      };
    }
    throw error;
  };

  routes.get("/", requireUser, async (context) =>
    context.json({ routines: await service.list(context.var.actor) }),
  );

  routes.post("/", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as
      | (Partial<RoutineInput> & { schedule?: RoutineInput["schedule"] })
      | null;
    if (!body?.agentId || !body.schedule) {
      return context.json(
        { error: "Name a Bot and a schedule.", code: "laf:routine_incomplete" },
        400,
      );
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

  /*
   * EVERY ONE OF THESE CARRIES THE ACTOR.
   *
   * They used to pass the id alone, and the service scoped by nothing: on a VM a shop owner shares
   * with their staff, any signed-in account could list, run, disable and delete anybody's routines,
   * and the list handed out every routine's trigger token hash on the way past. The actor is the
   * whole fix and it belongs on the service, not here — see `scopeOf` — so that the next surface to
   * reach a routine (the Bot proposing its own, one day) cannot arrive without one.
   */
  routes.get("/:id/runs", requireUser, async (context) => {
    try {
      const runs = await service.runs(
        context.var.actor,
        context.req.param("id"),
      );
      return context.json({ runs });
    } catch (error) {
      const mapped = mapError(error);
      return context.json(mapped.body, mapped.status);
    }
  });

  routes.post("/:id/enabled", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      enabled?: unknown;
    } | null;
    try {
      const routine = await service.setEnabled(
        context.var.actor,
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
      await service.runNow(context.var.actor, context.req.param("id"));
      return context.json({ ran: true });
    } catch (error) {
      const mapped = mapError(error);
      return context.json(mapped.body, mapped.status);
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    try {
      await service.remove(context.var.actor, context.req.param("id"));
      return context.json({ removed: true });
    } catch (error) {
      const mapped = mapError(error);
      return context.json(mapped.body, mapped.status);
    }
  });

  return routes;
}
