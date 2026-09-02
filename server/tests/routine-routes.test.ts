import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createRoutineRoutes } from "../src/routines/routes";
import { RoutineError, type RoutineService } from "../src/routines/service";

/**
 * The routines HTTP surface, which had no test of any kind.
 *
 * WHAT THIS FILE EXISTS FOR. Four of these handlers passed the route parameter to the service and
 * nothing else — no actor — and the service scoped by nothing, so on the VM a shop owner shares with
 * their staff any signed-in account could list, run, disable and delete anybody's routines, and the
 * list handed out every routine's trigger token hash on the way past. None of that is visible from
 * the service's own tests, because the service was never given an actor to ignore.
 *
 * So the assertions here are about the seam: every authenticated handler hands the service the actor
 * the guard resolved, the webhook stays outside the guard because its caller is a machine, and a
 * refusal arrives with the status and the fact code the surface renders Korean from.
 */

const OWNER: AuthenticatedActor = {
  id: "owner-1",
  email: "owner@laf.test",
  role: "user",
};

const STAFF: AuthenticatedActor = {
  id: "staff-1",
  email: "staff@laf.test",
  role: "user",
};

type ServiceCall = [method: string, ...arguments_: unknown[]];

/**
 * A routine service that owns exactly one routine, belonging to OWNER.
 *
 * The scoping rule itself is the service's and is tested against the database in
 * routine-service.integration.test.ts. What this stands in for is the decision: it refuses anybody
 * who is not the routine's person, exactly as the real one does, so a handler that forgets to pass
 * the actor cannot answer 200 by accident.
 */
function fakeService(overrides: Partial<RoutineService> = {}) {
  const calls: ServiceCall[] = [];
  const routine = {
    id: "routine_1",
    agentId: "agent_1",
    name: "아침 브리핑",
    instruction: "오늘 할 일 알려줘",
    enabled: true,
  };

  const mine = (actor: { id: string } | undefined, id: string) => {
    if (actor?.id !== OWNER.id || id !== routine.id) {
      throw new RoutineError(
        "There is no such routine.",
        404,
        "laf:routine_not_found",
      );
    }
  };

  const base = {
    async list(actor: { id: string }) {
      calls.push(["list", actor]);
      return actor.id === OWNER.id ? [routine] : [];
    },
    async create(actor: { id: string }, input: unknown) {
      calls.push(["create", actor, input]);
      return { ...routine, triggerToken: "the-token-once" };
    },
    async runs(actor: { id: string }, id: string) {
      calls.push(["runs", actor, id]);
      mine(actor, id);
      return [{ id: "run_1", ok: true }];
    },
    async setEnabled(actor: { id: string }, id: string, enabled: boolean) {
      calls.push(["setEnabled", actor, id, enabled]);
      mine(actor, id);
      return { ...routine, enabled };
    },
    async runNow(actor: { id: string }, id: string) {
      calls.push(["runNow", actor, id]);
      mine(actor, id);
    },
    async remove(actor: { id: string }, id: string) {
      calls.push(["remove", actor, id]);
      mine(actor, id);
    },
    async trigger(id: string, token: string, payload?: string) {
      calls.push(["trigger", id, token, payload]);
      if (id !== routine.id || token !== "the-token-once") {
        throw new RoutineError(
          "There is no such trigger.",
          404,
          "laf:routine_not_found",
        );
      }
      return { ran: true as const, finished: Promise.resolve() };
    },
    tick: async () => 0,
    start() {},
    stop() {},
  };

  return Object.assign(base, overrides, { calls, routine });
}

function appAs(
  actor: AuthenticatedActor,
  service: ReturnType<typeof fakeService>,
) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createRoutineRoutes(service as unknown as RoutineService, requireUser),
  );
  return app;
}

const post = (body?: unknown) => ({
  body: body === undefined ? undefined : JSON.stringify(body),
  headers: { "content-type": "application/json" },
  method: "POST",
});

describe("the routines surface, as its owner", () => {
  test("lists their routines and hands the service the actor", async () => {
    const service = fakeService();
    const response = await appAs(OWNER, service).request("http://laf.test/");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      routines: [{ id: "routine_1" }],
    });
    expect(service.calls[0]).toEqual(["list", OWNER]);
  });

  test("reads the runs, arms, runs now and deletes", async () => {
    const service = fakeService();
    const app = appAs(OWNER, service);

    expect((await app.request("http://laf.test/routine_1/runs")).status).toBe(
      200,
    );
    expect(
      (
        await app.request(
          "http://laf.test/routine_1/enabled",
          post({ enabled: false }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await app.request("http://laf.test/routine_1/run", post())).status,
    ).toBe(200);
    expect(
      (await app.request("http://laf.test/routine_1", { method: "DELETE" }))
        .status,
    ).toBe(200);

    // THE ASSERTION THIS FILE IS FOR: every one of them carried the actor, in first position.
    expect(service.calls.map((call) => [call[0], call[1]])).toEqual([
      ["runs", OWNER],
      ["setEnabled", OWNER],
      ["runNow", OWNER],
      ["remove", OWNER],
    ]);
  });

  test("the list body carries no trigger token hash", async () => {
    // A hash is not the token, but it is the material for guessing one offline, and the roster has
    // no use for it. Asserted on the serialised body, which is what actually reaches a browser.
    const service = fakeService();
    const response = await appAs(OWNER, service).request("http://laf.test/");

    expect(await response.text()).not.toContain("triggerTokenHash");
  });

  test("a create without a Bot refuses with a fact code", async () => {
    const service = fakeService();
    const response = await appAs(OWNER, service).request(
      "http://laf.test/",
      post({ name: "무제" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "laf:routine_incomplete",
      error: "Name a Bot.",
    });
    expect(service.calls).toEqual([]);
  });

  /*
   * A MISSING SCHEDULE IS ITS OWN CODE, and this is why.
   *
   * A Bot creates routines too (`manage_routine`), and it always names itself, so the only half it
   * can get wrong is the schedule. "Pick a Bot and a schedule" answers a question it did not ask;
   * the Korean for this code points it at `update_profile` instead, because a duty with no time
   * attached is a job, not a routine — which is the confusion the tool split exists to end.
   */
  test("a create without a schedule says which half is missing", async () => {
    const service = fakeService();
    const response = await appAs(OWNER, service).request(
      "http://laf.test/",
      post({ agentId: "bot-1", name: "아침 점검", instruction: "확인" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "laf:routine_needs_schedule",
      error: "Name a schedule.",
    });
    expect(service.calls).toEqual([]);
  });
});

describe("the routines surface, as somebody else on the same VM", () => {
  /*
   * 404 and not 403, following agents/routes.ts: a Bot somebody cannot see answers 404 there
   * (AgentNotFoundError), and 403 is kept for a resource they can see and may not change — a public
   * Bot, or one a package shipped. A routine has no public visibility, so that second case has no
   * equivalent here and a routine that is not yours simply is not there.
   */
  test.each([
    ["reading the runs", "http://laf.test/routine_1/runs", { method: "GET" }],
    [
      "disabling it",
      "http://laf.test/routine_1/enabled",
      post({ enabled: false }),
    ],
    ["running it now", "http://laf.test/routine_1/run", post()],
    ["deleting it", "http://laf.test/routine_1", { method: "DELETE" }],
  ])(
    "is refused %s, as a routine that is not there",
    async (_what, url, init) => {
      const service = fakeService();
      const response = await appAs(STAFF, service).request(url, init);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        code: "laf:routine_not_found",
        error: "There is no such routine.",
      });
    },
  );

  test("does not see it in the list either", async () => {
    // The 404s above are only half of it: a routine that is refused but still listed is a routine
    // whose name, instruction and schedule somebody else can read.
    const service = fakeService();
    const response = await appAs(STAFF, service).request("http://laf.test/");

    expect(await response.json()).toEqual({ routines: [] });
    expect(service.calls[0]).toEqual(["list", STAFF]);
  });
});

describe("the webhook, which has no session", () => {
  /** No requireUser on this one: the caller is a machine holding the token. */
  const unauthenticated = (service: ReturnType<typeof fakeService>) => {
    const refuse: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
    ) => context.json({ error: "Authentication required." }, 401);
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createRoutineRoutes(service as unknown as RoutineService, refuse),
    );
    return app;
  };

  test("the token fires the routine with no session at all", async () => {
    const service = fakeService();
    const response = await unauthenticated(service).request(
      "http://laf.test/routine_1/trigger",
      {
        body: '{"review":"별점 1점"}',
        headers: { "x-trigger-token": "the-token-once" },
        method: "POST",
      },
    );

    // 202: the run was accepted and is happening; the sender is not kept on the line for it.
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ran: true });
    expect(service.calls[0]).toEqual([
      "trigger",
      "routine_1",
      "the-token-once",
      '{"review":"별점 1점"}',
    ]);
  });

  test("no token is a 401 and never reaches the service", async () => {
    const service = fakeService();
    const response = await unauthenticated(service).request(
      "http://laf.test/routine_1/trigger",
      { method: "POST" },
    );

    expect(response.status).toBe(401);
    expect(service.calls).toEqual([]);
  });

  test("a wrong token reads exactly like a missing routine", async () => {
    const service = fakeService();
    const response = await unauthenticated(service).request(
      "http://laf.test/routine_1/trigger",
      { headers: { "x-trigger-token": "guessed" }, method: "POST" },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "laf:routine_not_found",
    });
  });

  test("every other route is behind the guard", async () => {
    // The webhook is the ONE hole in the guard, and it is a hole a token closes. If a handler ever
    // loses its middleware this is what says so.
    const service = fakeService();
    const app = unauthenticated(service);

    for (const [url, init] of [
      ["http://laf.test/", { method: "GET" }],
      ["http://laf.test/", post({ agentId: "a", schedule: {} })],
      ["http://laf.test/routine_1/runs", { method: "GET" }],
      ["http://laf.test/routine_1/enabled", post({ enabled: true })],
      ["http://laf.test/routine_1/run", post()],
      ["http://laf.test/routine_1", { method: "DELETE" }],
    ] as const) {
      const response = await app.request(url, init);
      expect(response.status).toBe(401);
    }
    expect(service.calls).toEqual([]);
  });
});
