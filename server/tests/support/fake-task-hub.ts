import type { HubAnswer, HubHttp, HubRequest } from "../../src/hub/http";

/**
 * The company hub's task board, in memory, keeping the rules #253's `hub/src/tasks.ts` keeps where a
 * VM's run meets them: a checkout is one conditional update (waiting and unclaimed, or a claim run
 * out; assigned to this member's 라피), so of two asking at once exactly one is told yes; a beat
 * renews only the holder's claim; a Bot moves only a task its run holds, only to `review` or
 * `blocked`, never `done`, ending the claim; a release puts a `doing` task back to `todo`; the sweep
 * frees every claim run out. Every write moves the version, as the hub's does.
 *
 * Each VM gets its own `HubHttp` by member id (`as`). The clock is the test's (`advance`).
 */

export type FakeTask = {
  id: string;
  title: string;
  description: string | null;
  stage: "todo" | "doing" | "review" | "blocked" | "done";
  /** The member whose 라피 run moved it to `blocked`: whose yes it waits for (#267). */
  blockedBy?: string | null;
  assignee: string | null;
  version: number;
  checkout: { runId: string; by: string; until: number } | null;
  notes: { by: string; text: string; runId: string | null }[];
};

export const LOCK_MS = 5 * 60 * 1000;

export function fakeTaskHub() {
  let now = 1_000_000;
  const tasks = new Map<string, FakeTask>();
  /** Every request, with who sent it. */
  const requests: (HubRequest & { as: string })[] = [];
  /** Answers a request before the board does, when it returns one: a hub that is away, say. */
  let intercept: (request: HubRequest) => HubAnswer<never> | undefined = () =>
    undefined;

  const ok = (body: unknown): HubAnswer<never> =>
    ({ ok: true, status: 200, body }) as HubAnswer<never>;
  const no = (status: number, code: string): HubAnswer<never> => ({
    ok: false,
    status,
    code,
  });
  const view = (task: FakeTask) => ({
    ...task,
    checkout: task.checkout
      ? {
          runId: task.checkout.runId,
          by: task.checkout.by,
          until: new Date(task.checkout.until).toISOString(),
        }
      : null,
    notes: undefined,
  });

  function answer(as: string, request: HubRequest): HubAnswer<never> {
    const url = new URL(`http://hub${request.path}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const method = request.method ?? "GET";
    if (parts[0] !== "tasks") return no(404, "laf:hub_not_found");
    if (parts.length === 1 && method === "GET") {
      const stage = url.searchParams.get("stage");
      return ok({
        ok: true,
        tasks: [...tasks.values()]
          .filter((task) => !stage || task.stage === stage)
          .map(view),
        next: null,
      });
    }
    const task = tasks.get(parts[1] ?? "");
    if (!task) return no(404, "laf:hub_not_found");
    const runId = typeof body.runId === "string" ? body.runId : null;
    const held = () =>
      task.stage === "doing" &&
      task.checkout?.runId === runId &&
      task.checkout?.by === as;
    if (parts.length === 2 && method === "GET") {
      return ok({ ok: true, task: view(task), notes: task.notes });
    }
    if (parts.length === 2 && method === "PATCH" && body.as === undefined) {
      // A person's edit (#253's member branch): against the version it was made on, any stage,
      // a person's note, and a claim on it ended by moving it out of `doing`.
      if (body.version !== task.version) return no(409, "laf:task_stale");
      const stages = ["todo", "doing", "review", "blocked", "done"] as const;
      const stage = stages.find((value) => value === body.stage) ?? task.stage;
      task.stage = stage;
      if (stage !== "doing") task.checkout = null;
      task.version += 1;
      if (typeof body.note === "string" && body.note) {
        task.notes.push({ by: `m:${as}`, text: body.note, runId: null });
      }
      return ok({ ok: true, task: view(task) });
    }
    if (parts.length === 2 && method === "PATCH") {
      if (body.as !== "bot") return no(400, "laf:request_invalid");
      if (body.stage === "done") return no(403, "laf:task_done_by_person");
      if (body.stage !== "review" && body.stage !== "blocked") {
        return no(400, "laf:request_invalid");
      }
      if (!held()) return no(409, "laf:task_not_held");
      const note = typeof body.note === "string" ? body.note : null;
      if (note !== null && (note.length > 500 || /[\r\n]/.test(note))) {
        return no(400, "laf:request_invalid");
      }
      task.stage = body.stage;
      task.blockedBy = body.stage === "blocked" ? as : null;
      task.checkout = null;
      task.version += 1;
      if (note) task.notes.push({ by: `bot:${as}`, text: note, runId });
      return ok({ ok: true, task: view(task) });
    }
    switch (parts[2]) {
      case "approvals": {
        // #267's yes: only for a blocked task, only from the member whose run blocked it.
        if (method !== "POST") return no(404, "laf:hub_not_found");
        if (typeof body.topic !== "string" || !body.topic) {
          return no(400, "laf:request_invalid");
        }
        if (task.stage !== "blocked") return no(409, "laf:task_not_blocked");
        if (task.blockedBy !== as) return no(403, "laf:task_not_yours");
        task.stage = "todo";
        task.blockedBy = null;
        task.version += 1;
        task.notes.push({
          by: `m:${as}`,
          text: `laf:task_approval_granted topic:${body.topic}`,
          runId: null,
        });
        return ok({
          ok: true,
          approval: { taskId: task.id, by: as, topic: body.topic, at: "now" },
          task: view(task),
        });
      }
      case "checkout": {
        const waiting = task.stage === "todo" && task.checkout === null;
        const runOut =
          task.stage === "doing" &&
          task.checkout !== null &&
          task.checkout.until < now;
        const forMe =
          task.assignee === null ||
          task.assignee === `bot:${as}` ||
          task.assignee === `m:${as}`;
        if (!runId) return no(400, "laf:request_invalid");
        if (forMe && (waiting || runOut)) {
          task.stage = "doing";
          task.checkout = { runId, by: as, until: now + LOCK_MS };
          task.version += 1;
          return ok({ ok: true, task: view(task) });
        }
        if (held()) return ok({ ok: true, task: view(task) });
        return no(409, "laf:task_taken");
      }
      case "heartbeat":
        if (!held() || !task.checkout) return no(409, "laf:task_not_held");
        task.checkout.until = now + LOCK_MS;
        return ok({ ok: true });
      case "release":
        if (task.checkout?.runId !== runId || task.checkout?.by !== as) {
          return no(409, "laf:task_not_held");
        }
        task.checkout = null;
        if (task.stage === "doing") task.stage = "todo";
        task.version += 1;
        return ok({ ok: true, task: view(task) });
      default:
        return no(404, "laf:hub_not_found");
    }
  }

  return {
    tasks,
    requests,
    intercepting(by: typeof intercept) {
      intercept = by;
    },
    add(task: Partial<FakeTask> & { id: string; assignee: string | null }) {
      const made: FakeTask = {
        title: "오늘 날씨 요약해서 메모로 남겨줘",
        description: null,
        stage: "todo",
        version: 1,
        checkout: null,
        notes: [],
        ...task,
      };
      tasks.set(made.id, made);
      return made;
    },
    advance(ms: number) {
      now += ms;
    },
    /** The hub's minute sweep: every claim run out is freed, `doing` back to `todo`. */
    sweep() {
      const freed: string[] = [];
      for (const task of tasks.values()) {
        if (task.checkout && task.checkout.until < now) {
          task.checkout = null;
          if (task.stage === "doing") task.stage = "todo";
          task.version += 1;
          freed.push(task.id);
        }
      }
      return freed;
    },
    /** A VM's line to this hub, as member `as`. */
    as(member: string): HubHttp {
      return {
        async request<T>(request: HubRequest) {
          requests.push({ ...request, as: member });
          // A turn of the event loop, as a network answer takes: two VMs asking "at once" interleave.
          await Promise.resolve();
          return (intercept(request) ??
            answer(member, request)) as HubAnswer<T>;
        },
        socket: () => ({ url: "ws://unused", headers: {} }),
      };
    },
  };
}
