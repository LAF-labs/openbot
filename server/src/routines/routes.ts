import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  type RoutineChange,
  RoutineError,
  type RoutineInput,
  type RoutineSchedule,
  type RoutineService,
} from "./service";

type Routes = Hono<{ Variables: AppVariables }>;
type RequireUser = MiddlewareHandler<{ Variables: AppVariables }>;

/**
 * The routines surface: create, list, edit, arm, run now, read the recent runs, read and clear the
 * notepad.
 *
 * Thin by design — every rule lives in the service, so a second surface (the Bot proposing its own
 * routine, one day) enforces the same limits by construction.
 */
export function createRoutineRoutes(
  service: RoutineService,
  requireUser: RequireUser,
) {
  const routes: Routes = new Hono<{ Variables: AppVariables }>();
  // Registered in this order: the collection, the webhook, then the verbs on one routine.
  addCollection(routes, service, requireUser);
  addWebhook(routes, service);
  addRoutineVerbs(routes, service, requireUser);
  return routes;
}

/**
 * The refusal as the surface reads it: the fact code, twice.
 *
 * The code is what the app renders Korean from (`ROUTINE_REFUSALS`). `error` used to carry the
 * service's sentence "for operators", and the app read it as the fallback for any code it had no
 * words for — which is how "The daily time must be HH:MM." reached a Korean screen. The
 * sentence is on the thrown error for a stack trace; nothing on the wire is prose.
 */
const mapError = (error: unknown) => {
  if (error instanceof RoutineError) {
    return {
      body: { error: error.code, code: error.code },
      status: error.status,
    };
  }
  throw error;
};

/**
 * The four fields an edit reaches, out of whatever arrived. A field that is absent or `null` is not
 * being changed; a name, an instruction or a summary is read as text the way create reads it, and a
 * schedule is handed on as sent for `parseSchedule` to accept or refuse with its code.
 */
function changeOf(body: unknown): RoutineChange {
  if (!body || typeof body !== "object") return {};
  const { name, instruction, summary, schedule } = body as Record<
    string,
    unknown
  >;
  return {
    ...(name === undefined || name === null ? {} : { name: String(name) }),
    ...(instruction === undefined || instruction === null
      ? {}
      : { instruction: String(instruction) }),
    ...(summary === undefined || summary === null
      ? {}
      : { summary: String(summary) }),
    ...(schedule === undefined || schedule === null
      ? {}
      : { schedule: schedule as RoutineSchedule }),
  };
}

function addCollection(
  routes: Routes,
  service: RoutineService,
  requireUser: RequireUser,
) {
  routes.get("/", requireUser, async (context) =>
    context.json({ routines: await service.list(context.var.actor) }),
  );

  routes.post("/", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as
      | (Partial<RoutineInput> & { schedule?: RoutineInput["schedule"] })
      | null;
    if (!body?.agentId) {
      return context.json(
        { error: "laf:routine_incomplete", code: "laf:routine_incomplete" },
        400,
      );
    }
    /*
     * Its own code, told apart from "name a Bot".
     *
     * A Bot creating a routine has already named itself, so the only half it can get wrong is the
     * schedule — and that is exactly the mistake worth answering precisely, because a duty with no
     * time attached is not a routine at all, it is the Bot's job. The code says so and the Korean
     * for it (`shared/prompt/tool-results.ko.ts`) points the Bot at `update_profile`.
     */
    if (!body.schedule) {
      return context.json(
        {
          error: "laf:routine_needs_schedule",
          code: "laf:routine_needs_schedule",
        },
        400,
      );
    }
    try {
      const routine = await service.create(context.var.actor, {
        agentId: String(body.agentId),
        name: String(body.name ?? ""),
        instruction: String(body.instruction ?? ""),
        // The person's line, when the Bot wrote one. Absent from the form, which is fine: a
        // routine somebody wrote by hand is already in their own words.
        ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
        schedule: body.schedule,
      });
      return context.json({ routine }, 201);
    } catch (error) {
      const mapped = mapError(error);
      return context.json(mapped.body, mapped.status);
    }
  });

  /*
   * 다시 켜기 and 계속 돌리기: one Bot's routines the unread rule paused, back on — and, for the
   * second, never paused that way again (`routines/unread.ts`). Named by the Bot, because the pause
   * and the banner that answers it are per Bot, and one press is all of them or none.
   *
   * Not a door a Bot's tool reaches: `manage_routine` edits and switches one routine at a time, and
   * exempting routines from the rule is the person's decision.
   */
  routes.post("/resume", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      agentId?: unknown;
      keepRunning?: unknown;
    } | null;
    if (typeof body?.agentId !== "string" || !body.agentId) {
      return context.json(
        { error: "laf:routine_incomplete", code: "laf:routine_incomplete" },
        400,
      );
    }
    try {
      const routines = await service.resumePaused(
        context.var.actor,
        body.agentId,
        { keepRunning: body.keepRunning === true },
      );
      return context.json({ routines });
    } catch (error) {
      const mapped = mapError(error);
      return context.json(mapped.body, mapped.status);
    }
  });
}

/**
 * The webhook. Deliberately NOT behind requireUser: the caller is a machine holding the token
 * that was shown once at creation. The token rides a header, never the URL — URLs land in access
 * logs, referrers and browser history, and a capability that gets logged is a capability shared
 * with everyone who can read the log.
 */
function addWebhook(routes: Routes, service: RoutineService) {
  routes.post("/:id/trigger", async (context) => {
    const token = context.req.header("x-trigger-token") ?? "";
    if (!token) {
      return context.json(
        {
          error: "laf:routine_trigger_token_missing",
          code: "laf:routine_trigger_token_missing",
        },
        401,
      );
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
}

/*
 * EVERY ONE OF THESE CARRIES THE ACTOR.
 *
 * They used to pass the id alone, and the service scoped by nothing: on a VM a shop owner shares
 * with their staff, any signed-in account could list, run, disable and delete anybody's routines,
 * and the list handed out every routine's trigger token hash on the way past. The actor is the
 * whole fix and it belongs on the service, not here — see `scopeOf` — so that the next surface to
 * reach a routine (the Bot proposing its own, one day) cannot arrive without one.
 */
function addRoutineVerbs(
  routes: Routes,
  service: RoutineService,
  requireUser: RequireUser,
) {
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

  /*
   * THE NOTEPAD HAS A READ AND A CLEAR, AND NO WRITE. What a routine notes is written by that
   * routine's own run and landed by its settlement (`notepad.ts`); a person reads it and may empty
   * it, and nothing that arrives over HTTP — a person, a page, a chat turn's tool — can put a value
   * into it. A write door here would be a way to plant "facts" in front of an unattended run.
   */
  routes.get("/:id/notepad", requireUser, async (context) => {
    try {
      const notepad = await service.notepad(
        context.var.actor,
        context.req.param("id"),
      );
      return context.json({ notepad });
    } catch (error) {
      const mapped = mapError(error);
      return context.json(mapped.body, mapped.status);
    }
  });

  routes.delete("/:id/notepad", requireUser, async (context) => {
    try {
      const { cleared } = await service.clearNotepad(
        context.var.actor,
        context.req.param("id"),
      );
      return context.json({ cleared });
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

  /*
   * 계속 돌리기 on one routine, and its undoing. Its own door, never a field of the edit below — see
   * `setRoutineKeepRunning`. Anything but `true` is off, the way the enabled switch reads its body.
   */
  routes.post("/:id/keep-running", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      keepRunning?: unknown;
    } | null;
    try {
      const routine = await service.setKeepRunning(
        context.var.actor,
        context.req.param("id"),
        body?.keepRunning === true,
      );
      return context.json({ routine });
    } catch (error) {
      const mapped = mapError(error);
      return context.json(mapped.body, mapped.status);
    }
  });

  /*
   * Its name, what it says, when it runs — changed in place, and nothing else here.
   *
   * THE BODY IS READ FOR FOUR FIELDS AND THE REST IS DROPPED, not refused. A Bot's `manage_routine`
   * posts here, and whether a routine runs, which Bot it drives and whether the unread rule may
   * pause it are each somebody's decision behind a door of their own. A body naming them changes
   * nothing rather than failing — the line the profile route draws around `autoReview`, and for
   * the same reason: a Bot told "no" tries again in another shape, and a field that never reaches
   * the store is the end of that conversation.
   */
  routes.patch("/:id", requireUser, async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    try {
      const routine = await service.update(
        context.var.actor,
        context.req.param("id"),
        changeOf(body),
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
}
