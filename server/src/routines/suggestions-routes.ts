import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { RoutineError } from "./service";
import type { RoutineSuggestionService } from "./suggestions";

/**
 * The suggestion cards' three verbs: read them, 만들기, 다음에.
 *
 * Mounted under `/api/routines/suggestions`, ahead of the routine routes, so `suggestions` can
 * never be read as a routine id. Thin like `routes.ts`: every rule — what is eligible, the cap,
 * the latch, which Bot — is the service's, and the refusal shape is the routine service's own
 * (`RoutineError`: a status, a `laf:` code the surface renders Korean from, and a sentence for
 * the log).
 */
export function createRoutineSuggestionRoutes(
  service: RoutineSuggestionService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

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
    context.json({ suggestions: await service.list(context.var.actor) }),
  );

  /**
   * 만들기. The body may name a Bot; a person with one Bot need not. 201 with the routine — the
   * same shape `POST /api/routines` answers, trigger token included, because it IS that create.
   */
  routes.post("/:key/accept", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      agentId?: unknown;
    } | null;
    const agentId =
      typeof body?.agentId === "string" && body.agentId
        ? body.agentId
        : undefined;
    try {
      const routine = await service.accept(
        context.var.actor,
        context.req.param("key"),
        agentId,
      );
      return context.json({ routine }, 201);
    } catch (error) {
      const mapped = mapError(error);
      return context.json(mapped.body, mapped.status);
    }
  });

  routes.post("/:key/dismiss", requireUser, async (context) => {
    try {
      await service.dismiss(context.var.actor, context.req.param("key"));
      return context.json({ dismissed: true });
    } catch (error) {
      const mapped = mapError(error);
      return context.json(mapped.body, mapped.status);
    }
  });

  return routes;
}
