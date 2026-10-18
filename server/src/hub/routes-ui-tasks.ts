import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { HUB_FACTS } from "../../../shared/hub/protocol";
import type { AppVariables } from "../auth/guards";
import type { HubAnswer, HubHttp, HubRequest } from "./http";
import type { HubLink } from "./link";

/**
 * 회사 → 업무판's doors (`app/src/routes/_authed/_app/company.tasks.tsx`): the company's task board,
 * asked of the hub with this VM's pass, as `routes-ui.ts` asks for rooms and files. The browser never
 * learns the hub's address or the pass.
 *
 *   GET   /api/hub/tasks             the tasks this person can see (`stage=`, `cursor=`, `limit=`)
 *   GET   /api/hub/tasks/:id         one task and its notes
 *   POST  /api/hub/tasks             a new task, given to somebody or to nobody
 *   PATCH /api/hub/tasks/:id         moved, reordered, renamed, given to somebody else
 *   POST  /api/hub/tasks/:id/notes   a person's note
 *
 * A PERSON'S PRESS, NEVER A RUN'S. Every call goes as `x-laf-origin: person` and every write as
 * `as: "member"` with no run id, whatever the body says: `as: "bot"` and a run id are what a 라피's
 * run sends when it took the task (`checkout`), and taking, beating and letting go are not doors here
 * at all. A move carries the `version` the board read; the hub answers an older one with 409
 * `laf:task_stale`, which keeps its status and code here so the board reads the task again.
 *
 * WHAT THIS DOOR CHECKS is the shape of what it forwards — ids that stay in their path, a stage the
 * board has, an assignee spelled the hub's way, numbers that are numbers — and only the fields the
 * screen sends. Who may see, move or reshape a task is the hub's to say, with one rule held here as
 * well: a 라피 is given work only by its own person (`bot:<this VM's member>`), since it runs on
 * that person's VM with that person's logins. A refusal keeps the field the hub named, so the
 * board can say which part was refused.
 *
 * Its own file beside `routes-ui.ts`, so the board and the other 회사 parts change without touching
 * each other; the few lines they share (the 502 rule, the key rule) are spelled the same way.
 */

type Hub = { http: HubHttp; link: HubLink };
type Ctx = Context<{ Variables: AppVariables }>;

const ID_SHAPE = /^[A-Za-z0-9_-]{1,100}$/;
const KEY_SHAPE = /^[A-Za-z0-9_.:-]{8,128}$/;
const WHOLE = /^\d{1,15}$/;
/** `GET /tasks`'s cursor: `<created ms>.<task id>`. */
const CURSOR_SHAPE = /^\d{1,15}\.[A-Za-z0-9_-]{1,80}$/;
/** A person, that person's 라피, or a job (a sub-Bot) on its owner's VM. */
const ASSIGNEE_SHAPE = /^(m|bot|job):[A-Za-z0-9_-]{1,80}$/;
const STAGES = ["todo", "doing", "review", "blocked", "done"] as const;
const VISIBILITIES = ["company", "me", "members"] as const;

const invalid = (context: Ctx, field: string) =>
  context.json({ ok: false, code: "laf:request_invalid", field }, 400);

/** As `routes-ui.ts`: the hub's status where it means the same here, 502 where it would not. */
function statusFor(
  status: number | null,
): 400 | 403 | 404 | 409 | 413 | 502 | 507 {
  switch (status) {
    case 400:
    case 403:
    case 404:
    case 409:
    case 413:
    case 507:
      return status;
    default:
      return 502;
  }
}

async function jsonOf(context: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await context.req.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

class Invalid extends Error {
  constructor(readonly field: string) {
    super(field);
  }
}

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * The fields of a create or an edit, each checked and copied; anything else in the body is left
 * behind. Lengths are the hub's to judge — it knows its own limits and names the field.
 */
function taskFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const field of allowed) {
    const value = body[field];
    if (value === undefined) continue;
    switch (field) {
      case "title":
      case "note":
        if (!isString(value)) throw new Invalid(field);
        break;
      case "description":
        if (value !== null && !isString(value)) throw new Invalid(field);
        break;
      case "stage":
        if (!STAGES.includes(value as (typeof STAGES)[number]))
          throw new Invalid(field);
        break;
      case "visibility":
        if (!VISIBILITIES.includes(value as (typeof VISIBILITIES)[number]))
          throw new Invalid(field);
        break;
      case "assignee":
        if (value !== null && !(isString(value) && ASSIGNEE_SHAPE.test(value)))
          throw new Invalid(field);
        break;
      case "members":
        if (
          !Array.isArray(value) ||
          !value.every((id) => isString(id) && ID_SHAPE.test(id))
        )
          throw new Invalid(field);
        break;
      case "rank":
        if (typeof value !== "number" || !Number.isFinite(value))
          throw new Invalid(field);
        break;
      case "version":
        if (typeof value !== "number" || !Number.isInteger(value))
          throw new Invalid(field);
        break;
    }
    kept[field] = value;
  }
  return kept;
}

const CREATE_FIELDS = [
  "title",
  "description",
  "stage",
  "visibility",
  "members",
  "assignee",
  "rank",
] as const;

const EDIT_FIELDS = [
  "version",
  "title",
  "description",
  "stage",
  "rank",
  "assignee",
  "note",
] as const;

export function createHubTaskRoutes(
  hub: Hub | undefined,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  const opened = (context: Ctx): Hub | Response => {
    context.header("cache-control", "no-store");
    if (!hub) {
      return context.json({ ok: false, code: "laf:hub_not_configured" }, 404);
    }
    if (hub.link.status().state === "refused") {
      return context.json({ ok: false, code: HUB_FACTS.passRefused }, 502);
    }
    return hub;
  };

  const settle = <T>(context: Ctx, live: Hub, answer: HubAnswer<T>) => {
    if (answer.ok) return context.json(answer.body as Record<string, unknown>);
    if (answer.code === HUB_FACTS.passRefused) live.link.passRefused("api_ui");
    return context.json(
      {
        ok: false,
        code: answer.code,
        ...(answer.field ? { field: answer.field } : {}),
      },
      statusFor(answer.status),
    );
  };

  /**
   * Another member's 라피 is never this person's to give work: `bot:` names this VM's own member
   * or nothing goes. Before `/me` has answered nobody here is known, which is the hub not reached.
   */
  const othersLafi = (
    context: Ctx,
    live: Hub,
    fields: Record<string, unknown>,
  ) => {
    const assignee = fields.assignee;
    if (typeof assignee !== "string" || !assignee.startsWith("bot:"))
      return null;
    const me = live.link.me()?.member.id;
    if (!me)
      return context.json({ ok: false, code: HUB_FACTS.unreachable }, 502);
    if (assignee === `bot:${me}`) return null;
    // Said as the hub says it, so the board has one sentence for the rule wherever it was met.
    return context.json(
      { ok: false, code: HUB_FACTS.forbidden, field: "assignee" },
      403,
    );
  };

  /** Asked once: the board's own query retries, and "cannot reach" after one try is sooner true. */
  const read = async (context: Ctx, path: string) => {
    const live = opened(context);
    if (live instanceof Response) return live;
    return settle(
      context,
      live,
      await live.http.request({ path, origin: "person", retry: false }),
    );
  };

  const write = async (
    context: Ctx,
    request: Omit<HubRequest, "origin" | "idempotencyKey">,
  ) => {
    const live = opened(context);
    if (live instanceof Response) return live;
    const refused = othersLafi(
      context,
      live,
      (request.body ?? {}) as Record<string, unknown>,
    );
    if (refused) return refused;
    const sent = context.req.header("idempotency-key");
    const key = sent === undefined ? randomUUID() : sent;
    if (!KEY_SHAPE.test(key)) return invalid(context, "idempotencyKey");
    return settle(
      context,
      live,
      await live.http.request({
        ...request,
        origin: "person",
        idempotencyKey: key,
      }),
    );
  };

  const taskId = (context: Ctx): string | null => {
    const value = context.req.param("id");
    return value && ID_SHAPE.test(value) ? value : null;
  };

  routes.get("/tasks", requireUser, async (context) => {
    const kept = new URLSearchParams();
    const checks: Record<string, (value: string) => boolean> = {
      stage: (value) => STAGES.includes(value as (typeof STAGES)[number]),
      cursor: (value) => CURSOR_SHAPE.test(value),
      limit: (value) => WHOLE.test(value),
    };
    for (const [name, valid] of Object.entries(checks)) {
      const value = context.req.query(name);
      if (value === undefined) continue;
      if (!valid(value)) return invalid(context, name);
      kept.set(name, value);
    }
    const query = kept.toString();
    return read(context, `/tasks${query ? `?${query}` : ""}`);
  });

  routes.get("/tasks/:id", requireUser, async (context) => {
    const id = taskId(context);
    if (id === null) return invalid(context, "path");
    return read(context, `/tasks/${id}`);
  });

  routes.post("/tasks", requireUser, async (context) => {
    const body = await jsonOf(context);
    if (!body || !isString(body.title)) return invalid(context, "title");
    try {
      return write(context, {
        method: "POST",
        path: "/tasks",
        body: { ...taskFields(body, CREATE_FIELDS), as: "member" },
      });
    } catch (error) {
      if (error instanceof Invalid) return invalid(context, error.field);
      throw error;
    }
  });

  routes.patch("/tasks/:id", requireUser, async (context) => {
    const id = taskId(context);
    if (id === null) return invalid(context, "path");
    const body = await jsonOf(context);
    // A person's edit is always against the version they read; without one it could undo a run's move.
    if (!body || typeof body.version !== "number") {
      return invalid(context, "version");
    }
    try {
      return write(context, {
        method: "PATCH",
        path: `/tasks/${id}`,
        body: { ...taskFields(body, EDIT_FIELDS), as: "member" },
      });
    } catch (error) {
      if (error instanceof Invalid) return invalid(context, error.field);
      throw error;
    }
  });

  routes.post("/tasks/:id/notes", requireUser, async (context) => {
    const id = taskId(context);
    if (id === null) return invalid(context, "path");
    const body = await jsonOf(context);
    if (!body || !isString(body.text)) return invalid(context, "text");
    return write(context, {
      method: "POST",
      path: `/tasks/${id}/notes`,
      body: { text: body.text, as: "member" },
    });
  });

  return routes;
}
