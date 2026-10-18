import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { HUB_FACTS, type HubMe } from "../../../shared/hub/protocol";
import type { AuditStore } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { StandingApprovalStore } from "../computer/standing-approvals";
import type { Database } from "../db/client";
import type { HubHttp } from "./http";
import type { HubLink } from "./link";
import type { HubOutbox } from "./outbox";
import type { HubJobs } from "./jobs";
import { allowForTask, ownsBot, type TaskAsks } from "./task-asks";
import { HUB_JOB_TOO_LARGE } from "./wire";

/**
 * The app's two doors to the company hub, behind the person's session like every other route:
 *
 *   GET /api/hub/status   whether this VM belongs to a company, and whether the line is up
 *   GET /api/hub/me       who this person is in their company, asked of the hub now
 *   GET  /api/hub/tasks/:id/allowance   a board task's stop still waiting on a yes: its topic
 *   POST /api/hub/tasks/:id/allowance   "이 일감에서는 해도 돼" for that task and that topic
 *   POST /api/hub/jobs {routineId}      one of the person's routines registered as a sub-Bot
 *
 * The server asks the hub with the pass and hands back facts; the browser never learns the hub's
 * address, the pass, or the private address `/me` offers a VM. A hub failure is a 502 with its
 * fact, never the hub's own status: a 401 passed through would read to the app as this person's
 * session having ended.
 */
export function createHubRoutes(
  hub: { http: HubHttp; link: HubLink; outbox?: HubOutbox } | undefined,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  company: {
    /** What the board task's allowance needs. Absent: the task doors answer that there is none. */
    tasks?: {
      database: Database;
      asks: TaskAsks;
      standing: StandingApprovalStore;
      auditStore?: AuditStore;
    };
    /** The sub-Bot register (`jobs.ts`). Absent: the job door answers that there is no company. */
    jobs?: Pick<HubJobs, "register">;
  } = {},
) {
  const { tasks, jobs } = company;
  const routes = new Hono<{ Variables: AppVariables }>();

  /*
   * The task's id is the only thing read off the request. What is allowed — rule, scope, topic —
   * is the stop's own record on this VM (`task-asks.ts`), never a body's.
   */
  routes.get("/tasks/:id/allowance", requireUser, async (context) => {
    context.header("cache-control", "no-store");
    if (!tasks) {
      return context.json({ ok: false, code: "laf:hub_not_configured" }, 404);
    }
    const ask = await tasks.asks.waiting(context.req.param("id"));
    // Somebody else's Bot's stop is not said to exist: the same answer as none.
    const shown =
      ask && (await ownsBot(tasks.database, context.get("actor"), ask.botId))
        ? ask
        : null;
    return context.json({
      waiting: shown ? { topic: shown.topic, askedAt: shown.askedAt } : null,
    });
  });

  routes.post("/jobs", requireUser, async (context) => {
    if (!jobs) {
      return context.json({ ok: false, code: "laf:hub_not_configured" }, 404);
    }
    const body = (await context.req.json().catch(() => null)) as {
      routineId?: unknown;
    } | null;
    if (typeof body?.routineId !== "string" || !body.routineId) {
      return context.json({ ok: false, code: "laf:request_invalid" }, 400);
    }
    const result = await jobs
      .register(context.get("actor"), body.routineId)
      .catch(() => ({ ok: false as const, code: "laf:routine_not_found" }));
    return result.ok
      ? context.json(result)
      : context.json(
          result,
          result.code === "laf:routine_not_found"
            ? 404
            : result.code === HUB_JOB_TOO_LARGE
              ? 413
              : 502,
        );
  });

  routes.post("/tasks/:id/allowance", requireUser, async (context) => {
    if (!tasks) {
      return context.json({ ok: false, code: "laf:task_nothing_waiting" }, 404);
    }
    const actor = context.get("actor");
    const result = await allowForTask(
      {
        ...tasks,
        ...(hub?.outbox ? { hub: { http: hub.http, outbox: hub.outbox } } : {}),
      },
      actor,
      context.req.param("id"),
    );
    if (!result.ok) {
      return context.json(
        result,
        result.code === "laf:task_not_yours" ? 403 : 404,
      );
    }
    return context.json(result);
  });

  routes.get("/status", requireUser, (context) => {
    context.header("cache-control", "no-store");
    if (!hub) return context.json({ configured: false });
    return context.json({ configured: true, ...hub.link.status() });
  });

  routes.get("/me", requireUser, async (context) => {
    context.header("cache-control", "no-store");
    if (!hub) {
      return context.json({ ok: false, code: "laf:hub_not_configured" }, 404);
    }
    if (hub.link.status().state === "refused") {
      return context.json({ ok: false, code: HUB_FACTS.passRefused }, 502);
    }
    const answer = await hub.http.request<HubMe>({ path: "/me" });
    if (!answer.ok) {
      if (answer.code === HUB_FACTS.passRefused) {
        hub.link.passRefused("api_me");
      }
      return context.json({ ok: false, code: answer.code }, 502);
    }
    const { member, workspace } = answer.body;
    return context.json({
      ok: true,
      member: { id: member.id, role: member.role, name: member.name },
      workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
    });
  });

  return routes;
}
