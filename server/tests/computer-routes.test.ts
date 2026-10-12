import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { ComputerClient } from "../src/computer/client";
import { createApprovalRegistry } from "../src/computer/approvals";
import { createComputerGateway } from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import {
  createPolicyStore,
  NOTES_RULE,
  RETIRED_NOTES_RULE,
  revisionOf,
} from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";
import type { SecretRequest, SnapshotResult } from "../src/computer/schema";

/**
 * The computer's routes, exercised as the browser reaches them.
 *
 * Nothing did, until this file. Everything under `computer/` was tested at the gateway, which is
 * where the decisions are — and the things fixed here are all things only a route can get wrong:
 * who may press the most destructive button in the product, whether a request body can choose which
 * handler it lands in, whether a change to the boundary itself leaves a trail, and whether the two
 * routes a secret travels on keep it out of everything that outlives the request.
 *
 * "the whole surface" at the bottom is why this file names every route rather than the interesting
 * ones: a route that forgot its guard is invisible from a test that only covers the routes somebody
 * already thought about, and those are exactly the routes that have a guard.
 */

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://example.com/order",
  title: "Order",
  truncated: false,
  elements: [
    { ref: "e9", role: "button", name: "Submit order" },
    { ref: "e4", role: "textbox", name: "Customer name" },
    { ref: "e5", role: "textbox", name: "Phone" },
  ],
};

const ADMIN = {
  id: "manager-user",
  email: "manager@laf.test",
  role: "admin",
} as const;

const STAFF = {
  id: "staff-user",
  email: "staff@laf.test",
  role: "user",
} as const;

const PERMISSIVE: ActionPolicy = { deny: [], ask: [], allow: ["true"] };

/**
 * The value that must not survive the request.
 *
 * One string, distinctive enough that a substring search over a whole serialised object means what
 * it looks like it means — a password of "test" would be found inside "latest" and prove nothing.
 */
const SECRET = "hunter2-Zx9-BANKPASS";

/** What the computer says it holds: the caller's Bot with a tab open, and one that is nobody's here. */
const LISTED = {
  botId: "bot-1",
  running: true,
  startedAt: "2026-09-16T09:00:00.000Z",
  egress: null,
};
/** A Bot the container still lists after it was deleted (audit R3-09), or somebody else's. */
const LISTED_ELSEWHERE = {
  botId: "bot-gone",
  running: false,
  startedAt: null,
  egress: null,
};

function fakeClient() {
  const calls: string[] = [];
  /** Everything the far side was told, so a secret-absence test can search all of it at once. */
  const sentToComputer: unknown[] = [];
  const client = {
    screenshot: async () => ({
      base64: "aGVsbG8=",
      width: 1280,
      height: 800,
      capturedAt: "2026-09-03T00:00:00.000Z",
    }),
    read: async () => ({ url: SNAPSHOT.url, title: SNAPSHOT.title, text: "" }),
    snapshot: async () => SNAPSHOT,
    navigate: async (url: string) => ({ url, title: "Order", elapsedMs: 3 }),
    click: async (input: unknown) => {
      sentToComputer.push(input);
      return { action: "click", url: SNAPSHOT.url, elapsedMs: 1 };
    },
    listFiles: async () => ({ path: ".", entries: [] }),
    statFile: async (path: string) => ({ path, kind: "file", bytes: 2 }),
    downloadFile: async () => new TextEncoder().encode("hi"),
    control: async () => ({ holder: "bot" as const, url: SNAPSHOT.url }),
    requestControl: async () => ({ holder: "bot" as const, url: SNAPSHOT.url }),
    releaseControl: async () => ({ holder: "bot" as const, url: SNAPSHOT.url }),
    // One row, so a list that came back is told apart from a list that was never asked for.
    computers: async () => {
      calls.push("computers");
      return { computers: [LISTED, LISTED_ELSEWHERE] };
    },
    requestSecret: async (input: SecretRequest) => {
      calls.push("requestSecret");
      sentToComputer.push(input);
      return { holder: "bot" as const, url: SNAPSHOT.url };
    },
    resetComputer: async () => {
      calls.push("resetComputer");
      return { botId: "bot-1", state: "stopped" as const } as never;
    },
    stopComputer: async () => {
      calls.push("stopComputer");
      return { wasRunning: true } as never;
    },
    supplySecret: async (values: string[]) => {
      calls.push("supplySecret");
      // The one place the value legitimately exists: on its way through to the browser.
      sentToComputer.push({ suppliedSecret: values });
      return { characters: values.join("").length } as never;
    },
    forBot() {
      return client;
    },
  } as unknown as ComputerClient;
  return { client, calls, sentToComputer };
}

function surface(
  actor: typeof ADMIN | typeof STAFF,
  policy: ActionPolicy = PERMISSIVE,
  /**
   * A trail that will not accept the row, which is a real condition and the one that decides what a
   * 500 body is allowed to say. Every acting route writes an audit row before it answers.
   */
  auditFailure?: Error,
  /**
   * Whose Bots the actor may drive. `bot-1` unless a test says otherwise — the Computers page's
   * list is pressed by an administrator who owns none, which is the arrangement that broke it.
   */
  drives: (botId: string) => boolean = (botId) => botId === "bot-1",
  /** How long the trail takes over a row, in milliseconds: the one wait between a save and its answer. */
  auditTakes = 0,
) {
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => {
      if (auditTakes > 0) {
        await new Promise((resolve) => setTimeout(resolve, auditTakes));
      }
      if (auditFailure) throw auditFailure;
      rows.push(event);
    },
  };
  const { client, calls, sentToComputer } = fakeClient();
  const approvals = createApprovalRegistry();
  const gateway = createComputerGateway({
    client,
    auditStore,
    policy: () => policy,
    approvals,
  });
  const policyStore = createPolicyStore({ deny: [], ask: [], allow: ["true"] });
  /**
   * The guard as `createRequireUser` ships it: the actor, and beside it whose Bots they may drive.
   * `bot-1` is theirs; every other id is somebody else's, which is what the cross-use sweep at the
   * bottom presses on. The role is not consulted — since 2026-09-16 an administrator has no
   * exception here either, so the answer is the same one for everybody.
   */
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    context.set("mayDriveBot", async (botId) => drives(botId));
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createComputerRoutes(client, gateway, policyStore, requireUser, auditStore),
  );
  /** The page the gateway is allowed to decide about. Without it every rule is undecidable. */
  const seen = async () =>
    void (await app.request("/bot-1/snapshot", { method: "POST" }));
  return {
    app,
    calls,
    rows,
    policyStore,
    sentToComputer,
    seen,
  };
}

/**
 * THE BOT'S ID IS A DIRECTORY NAME ON THE FAR SIDE.
 *
 * `agent-computer` joins `x-openbot-bot-id` onto `/profiles`: the profile Chrome opens, the
 * `control.json` written on every handover, the tree `/computers/reset` hands to `rm -rf`. Nothing
 * on this side ever looked at the string — and Hono decodes `%2F` in a path parameter before a
 * handler sees it, so `POST /..%2F..%2Ftmp%2Fx/control/take` reached the container as
 * `../../tmp/x`. Measured: `join("/profiles", "../../tmp/x")` is `/tmp/x`, and taking control (a
 * door gone since 2026-10-09; `control/release` writes the same file) wrote a file there, as root, inside the container that holds every login this customer has. Any signed
 * in member of staff could do it; the reset route, which an owner can reach, deletes such a tree.
 */
describe("the Bot an address names", () => {
  /**
   * The shapes that mean "somewhere else", each as the address a browser would actually send.
   *
   * Encoded, because that is the only way they survive the trip. A segment that is only `..`, in
   * either spelling, is resolved away by URL normalisation before anything routes it — which is
   * precisely why `%2F` was the hole: it is the one spelling that reaches a handler still meaning a
   * separator, and it carries the `..` in front of it through with it.
   */
  const ESCAPES = [
    "..%2F..%2Ftmp%2Fx",
    "%2e%2e%2f%2e%2e%2fetc",
    ".ssh",
    "bot%2F7",
    "bot%007",
  ];

  test("a path where a Bot should be is refused before anything runs", async () => {
    const { app, calls, rows, sentToComputer } = surface(ADMIN);

    for (const id of ESCAPES) {
      const response = await app.request(`/${id}/control/release`, {
        method: "POST",
      });
      const body = (await response.json()) as { code?: string };
      expect([id, response.status, body.code]).toEqual([
        id,
        400,
        "laf:bot_id_invalid",
      ]);
    }

    // Nothing reached the computer and nothing was recorded: the refusal is in front of the handler
    // rather than inside it.
    expect(calls).toEqual([]);
    expect(sentToComputer).toEqual([]);
    expect(rows).toEqual([]);
  });

  test("an id this product mints is not caught by it", async () => {
    /*
     * A refusal that also refused `agent_<uuid>` would take the computer away from every Bot
     * anybody has made, which is the failure worth catching in the same breath. What is under test
     * is the SHAPE check, so the id has to belong to the caller — the stub above calls `bot-1`
     * theirs, so this one is minted onto that name rather than a fresh uuid, and a 400 here would
     * mean the shape check had swallowed a well-formed id.
     */
    const { app } = surface(ADMIN);

    const response = await app.request(
      "/agent_2f1c9a3e-7d24-4a6b-9b1e-0c8f5d2a7b41/control",
      { method: "GET" },
    );

    // Not theirs, so 404 — and crucially not the 400 a malformed id gets.
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "laf:bot_not_found",
    });
  });
});

/**
 * WHAT A FAILURE MAY SAY ONCE IT IS AN HTTP BODY.
 *
 * Every acting route writes an audit row through the gateway before it answers, so a trail that
 * will not accept the row is a failure that reaches this file — and Drizzle puts the SQL it sent
 * AND its bound parameters into `message`. The route answered with `error.message`, so the reply to
 * a caller was the row the database had just refused, over HTTP, to anybody with a session.
 *
 * And then with `describeFailure(error)`, which kept the SQL out and still put a sentence on the
 * wire. Since 2026-09-14 the caller is told the fact and the operator's log is told what it was.
 */
describe("a failure on its way out", () => {
  /** Every line the logger printed while `act` ran. */
  async function printedDuring<T>(act: () => T | Promise<T>) {
    const lines: string[] = [];
    const keep = (...parts: unknown[]) => {
      lines.push(parts.map(String).join(" "));
    };
    const spies = (["error", "warn", "log"] as const).map((method) =>
      spyOn(console, method).mockImplementation(keep),
    );
    try {
      return { result: await act(), lines };
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }

  /** Shaped like the real thing: `query` and `params`, and the code on the cause. */
  const queryError = () => {
    const error = new Error(
      'insert into "audit_events" ("payload") values ($1) — params: [{"secret":"hunter2-Zx9-BANKPASS"}]',
    ) as Error & { query: string; params: unknown[]; cause: { code: string } };
    error.query = 'insert into "audit_events" ("payload") values ($1)';
    error.params = [{ secret: "hunter2-Zx9-BANKPASS" }];
    error.cause = { code: "23505" };
    return error;
  };

  test("carries the fact, and neither the statement nor what was bound to it", async () => {
    const { app, seen } = surface(ADMIN, PERMISSIVE, queryError());
    await seen();

    const { result: response, lines } = await printedDuring(() =>
      app.request("/bot-1/click", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: "e9", snapshotId: 7 }),
      }),
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error?: string; code?: string };
    expect(body).toEqual({
      error: "laf:computer_failed",
      code: "laf:computer_failed",
    });
    const said = JSON.stringify(body);
    expect(said).not.toContain("insert into");
    expect(said).not.toContain(SECRET);
    // The database's code is the operator's, on one log line — and the statement and its values
    // are on no line at all.
    const logged = lines.join("\n");
    expect(logged).toContain("computer_route_failed");
    expect(logged).toContain("database error (23505)");
    expect(logged).not.toContain("insert into");
    expect(logged).not.toContain(SECRET);
  });

  test("still says what an ordinary failure was, to the operator", async () => {
    // The bound is on where it goes, not on saying anything: an operator who cannot be told what
    // went wrong is one who reports an outage for a full disk. The caller is told the fact.
    const { app, seen } = surface(
      ADMIN,
      PERMISSIVE,
      new Error("The trail is full."),
    );
    await seen();

    const { result: response, lines } = await printedDuring(() =>
      app.request("/bot-1/click", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: "e9", snapshotId: 7 }),
      }),
    );

    expect(await response.json()).toEqual({
      error: "laf:computer_failed",
      code: "laf:computer_failed",
    });
    expect(lines.join("\n")).toContain("The trail is full.");
  });
});

describe("wiping a computer", () => {
  /*
   * THE MOST DESTRUCTIVE BUTTON IN THE PRODUCT sat behind the same guard as reading a screenshot.
   * It deletes every login on the one browser all of this account's Bots share, and there is no
   * undo — the person who has to be able to press it is the one who decides what the deployment
   * does, not everyone who can watch a Bot work.
   */
  test("is refused to somebody who is not an administrator", async () => {
    const { app, calls } = surface(STAFF);

    const response = await app.request("/bot-1/computers/reset", {
      method: "POST",
    });

    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("is allowed to an administrator, and recorded", async () => {
    const { app, calls, rows } = surface(ADMIN);

    const response = await app.request("/bot-1/computers/reset", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["resetComputer"]);
    expect(rows.map((row) => row.eventType)).toEqual(["computer.reset"]);
  });

  test("stopping stays open to anybody who can drive the Bot", async () => {
    // Stopping costs somebody the page they were on. It is the recovery path for a Bot that has got
    // stuck, and locking it behind an administrator would leave the person watching it unable to
    // stop it.
    const { app, calls } = surface(STAFF);
    expect(
      (await app.request("/bot-1/computers/stop", { method: "POST" })).status,
    ).toBe(200);
    expect(calls).toEqual(["stopComputer"]);
  });
});

/**
 * THE COMPUTERS PAGE'S LIST, AT AN ADDRESS THAT NAMES NO BOT.
 *
 * Measured 2026-09-16 (audit R3-04, R5-02): the page asked `GET /shared/computers`, a Bot id no
 * `agents` row has, and once `397213f` took the administrator exception out of the ownership guard
 * that answered 404 `laf:bot_not_found` to everybody. The page drew a load error whose retry could
 * never work, and no rows — so the Reset button, one of the two doors that empty the deployment's
 * browser profile, was never drawn. The list is the computer's, not a Bot's, so its address names
 * none, and the administrator below owns no Bot at all.
 */
describe("the computers the Computers page lists", () => {
  test("are read at an address that names no Bot, by an administrator who owns none", async () => {
    const { app, calls, rows } = surface(
      ADMIN,
      PERMISSIVE,
      undefined,
      () => false,
    );

    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      isolation: "shared",
      computers: [
        { ...LISTED, mayDrive: false },
        { ...LISTED_ELSEWHERE, mayDrive: false },
      ],
    });
    expect(calls).toEqual(["computers"]);
    // A read: nobody is recorded as having looked, and no Bot is invented to record it against.
    expect(rows).toEqual([]);
  });

  /*
   * WHETHER A ROW'S BUTTONS CAN WORK, SAID BY THE SERVER. Stop and reset go through the row's own Bot
   * and its ownership guard. Measured 2026-09-16 in the real page against a real computer: a row for
   * a Bot the administrator could not drive drew both buttons, and Reset on it was a 404 that the
   * page then wiped off the screen by reading the list again — a press that did nothing and said
   * nothing. The container keeps listing deleted Bots (audit R3-09), so on a one-person deployment
   * that is every Bot its person has ever deleted.
   */
  test("say, row by row, whether the asker may drive that row's Bot", async () => {
    const { app } = surface(ADMIN);

    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      isolation: "shared",
      computers: [
        { ...LISTED, mayDrive: true },
        { ...LISTED_ELSEWHERE, mayDrive: false },
      ],
    });
  });

  test("are refused to somebody who is not an administrator, before the computer is asked", async () => {
    const { app, calls } = surface(STAFF);

    const response = await app.request("/");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "laf:admin_required",
      code: "laf:admin_required",
    });
    expect(calls).toEqual([]);
  });

  test("are no longer read through a Bot's address", async () => {
    // The door the page used to knock on, and the same door through a Bot that IS the caller's:
    // a list of every Bot's browser was never that Bot's business, so neither address opens it.
    const { app, calls } = surface(ADMIN);

    expect((await app.request("/shared/computers")).status).toBe(404);
    expect((await app.request("/bot-1/computers")).status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe("a person's own mouse and keyboard", () => {
  test("have no door: nobody drives the Bot's browser, and a body naming a secret opens nothing", async () => {
    /*
     * `/human/click`, `/type`, `/key` and `/scroll` carried a person's own input to the Bot's page
     * while they held the wheel. Nobody holds it now (owner, 2026-10-09). The secret path is the one
     * way anything a person types reaches the page, and a window from before the change still
     * posting here — even with `{"kind":"secret"}` in the body, which once rerouted a click into
     * that path — reaches nothing.
     */
    const { app, calls, sentToComputer } = surface(ADMIN);
    for (const kind of ["click", "type", "key", "scroll"]) {
      const response = await app.request(`/bot-1/human/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "secret", text: "hunter2", x: 1, y: 2 }),
      });
      expect({ kind, status: response.status }).toEqual({ kind, status: 404 });
    }
    expect(calls).not.toContain("supplySecret");
    expect(sentToComputer).toEqual([]);
  });
});

describe("changing the boundary", () => {
  const POLICY = {
    deny: [],
    ask: ['intent == "activate"'],
    allow: ["true"],
    settleWithoutAsking: "off" as const,
  };

  test("is refused to somebody who is not an administrator", async () => {
    const { app, policyStore } = surface(STAFF);

    const response = await app.request("/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(POLICY),
    });

    expect(response.status).toBe(403);
    // And the guard ran before the handler did: nothing was saved on the way to being refused.
    expect(policyStore.get().ask).toEqual([]);
  });

  test("reading it is refused too", async () => {
    const { app } = surface(STAFF);
    expect((await app.request("/policy")).status).toBe(403);
  });

  test("records who changed it and why, and what the switch is now", async () => {
    /*
     * `settleWithoutAsking` is the one control that decides whether anybody sees an action at all.
     * The table holds what is in force and who saved it last, which answers "what are the rules"
     * and never "what was the argument for loosening them" — so the reason goes in the trail, where
     * the next save cannot overwrite it.
     */
    const { app, rows, policyStore } = surface(ADMIN);

    const response = await app.request("/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...POLICY,
        reason: "정산 기간이라 사람이 직접 본다",
        revision: policyStore.revision(),
      }),
    });

    expect(response.status).toBe(200);
    const row = rows.find((one) => one.eventType === "computer.policy_changed");
    expect(row?.payload).toMatchObject({
      actor: "manager@laf.test",
      reason: "정산 기간이라 사람이 직접 본다",
      settleWithoutAsking: "off",
      settleWithoutAskingWas: "allowed",
      ask: 1,
    });
  });

  test("does not claim the switch moved when only a rule changed", async () => {
    // A row for every rule edit saying the switch is on would bury the few rows where somebody
    // actually moved it, which are the ones an investigator is looking for.
    const { app, rows, policyStore } = surface(ADMIN);

    await app.request("/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deny: ["submit"],
        ask: [],
        allow: ["true"],
        revision: policyStore.revision(),
      }),
    });

    const row = rows.find((one) => one.eventType === "computer.policy_changed");
    // There is a row to say it of: the save was stored.
    expect(policyStore.get().deny).toEqual(["submit"]);
    expect(row).toBeDefined();
    expect(row?.payload).not.toHaveProperty("settleWithoutAskingWas");
  });

  test("does not keep the reason in the policy it enforces", async () => {
    // The reason is a fact about the change, not a rule. A policy that carried it would put it in
    // front of the evaluator and on every read of the Boundaries page.
    const { app, policyStore } = surface(ADMIN);

    await app.request("/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...POLICY,
        reason: "왜냐하면",
        revision: policyStore.revision(),
      }),
    });

    expect(policyStore.get()).not.toHaveProperty("reason");
    // Nor the mark it was saved against: that is a fact about the save, like the reason.
    expect(policyStore.get()).not.toHaveProperty("revision");
    expect(policyStore.get().settleWithoutAsking).toBe("off");
  });
});

/**
 * A SAVE IS MADE AGAINST THE BOUNDARY ITS WINDOW READ, AND STORES NOTHING IF THAT IS NOT THE ONE
 * IN FORCE (`policy-store.ts`, `revisionOf`).
 *
 * The boundaries screen reads the whole policy once and sends the whole of it back with one thing
 * changed. Measured 2026-10-07: a window that was on that screen across an upgrade saved the rule
 * a migration had just rewritten straight back, and a write to `Notes/x.md` went unasked again.
 * That is one case of a general one — any window holding an older copy undoes whatever was decided
 * since, the switch that decides whether anybody is asked at all included — so it is closed for
 * every save, and the rule that started it is refused by name besides.
 */
describe("a save and the boundary it was made against", () => {
  type Held = { policy: ActionPolicy; revision: string };
  const PERMISSIVE_AS_READ = { deny: [], ask: [], allow: ["true"] };
  const changed = (rows: AuditEventInput[]) =>
    rows.filter((row) => row.eventType === "computer.policy_changed");

  /** A window: what it read, and a save of that with one thing changed — the way the screen saves. */
  function windowOn(app: ReturnType<typeof surface>["app"]) {
    let held: Held | undefined;
    const read = async () => {
      held = (await (await app.request("/policy")).json()) as Held;
      return held;
    };
    const save = async (change: Partial<ActionPolicy>, revision?: string) => {
      const response = await app.request("/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...held?.policy,
          ...change,
          ...(revision === undefined
            ? held
              ? { revision: held.revision }
              : {}
            : { revision }),
        }),
      });
      // Whatever came back, as it came: a refusal's facts are asserted whole, key for key.
      const body = (await response.json()) as Record<string, unknown>;
      // As the screen does: a save that was stored is the boundary this window holds now.
      if (response.ok) held = body as Held;
      return { status: response.status, code: body.code, body };
    };
    return { read, save };
  }

  test("a read hands out the boundary's mark, and a save made against it is stored and hands out the next", async () => {
    const { app, policyStore, rows } = surface(ADMIN);
    const window = windowOn(app);

    const first = await window.read();
    expect(first.policy).toEqual(PERMISSIVE_AS_READ);
    expect(first.revision).toBe(policyStore.revision());
    expect(first.revision.length).toBeGreaterThan(15);

    const saved = await window.save({ ask: ['intent == "activate"'] });
    expect(saved.status).toBe(200);
    expect(policyStore.get().ask).toEqual(['intent == "activate"']);
    // The mark moved with the boundary, the answer carries the new one, and a read agrees.
    expect(saved.body.revision).not.toBe(first.revision);
    expect(saved.body.revision).toBe(policyStore.revision());
    expect((await window.read()).revision).toBe(policyStore.revision());
    // And the same window's next save, made against what it was handed, is stored too.
    expect((await window.save({ deny: ["second"] })).status).toBe(200);
    expect(policyStore.get().deny).toEqual(["second"]);
    expect(changed(rows)).toHaveLength(2);
  });

  test("a save that names no boundary stores nothing: a window from before marks existed", async () => {
    const { app, policyStore, rows } = surface(ADMIN);
    const before = policyStore.get();

    for (const body of [
      { deny: [], ask: ["anything"], allow: ["true"] },
      { deny: [], ask: ["anything"], allow: ["true"], revision: "" },
      { deny: [], ask: ["anything"], allow: ["true"], revision: 7 },
      { deny: [], ask: ["anything"], allow: ["true"], revision: null },
    ]) {
      const response = await app.request("/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect([response.status, await response.json()]).toEqual([
        409,
        { error: "laf:policy_changed", code: "laf:policy_changed" },
      ]);
    }
    expect(policyStore.get()).toEqual(before);
    expect(changed(rows)).toEqual([]);
  });

  test("a save made against an older boundary stores nothing — not its rules, and not the switch it would have moved back", async () => {
    const { app, policyStore, rows } = surface(ADMIN);
    const one = windowOn(app);
    const two = windowOn(app);
    await one.read();
    await two.read();

    // The first window stands the boundary up: a rule, and every question in front of a person.
    expect(
      (
        await one.save({
          ask: ['intent == "activate"'],
          settleWithoutAsking: "off",
        })
      ).status,
    ).toBe(200);
    const stood = policyStore.get();

    // The second still holds the boundary as it was — no rule, the switch on — and adds a rule of
    // its own to THAT. Stored, it would take the first one's rule away and switch the questions
    // back to being settled without anybody seeing them.
    const stale = await two.save({ deny: ["something else"] });
    expect([stale.status, stale.code]).toEqual([409, "laf:policy_changed"]);
    expect(stale.body).toEqual({
      error: "laf:policy_changed",
      code: "laf:policy_changed",
    });
    expect(policyStore.get()).toEqual(stood);
    expect(policyStore.get().settleWithoutAsking).toBe("off");
    expect(policyStore.get().ask).toEqual(['intent == "activate"']);
    expect(policyStore.get().deny).toEqual([]);
    // One change was made, and the trail has one.
    expect(changed(rows)).toHaveLength(1);
  });

  test("two windows in turn: the one that was refused reads again, and its save is taken on top of the other's", async () => {
    const { app, policyStore, rows } = surface(ADMIN);
    const one = windowOn(app);
    const two = windowOn(app);
    await one.read();
    await two.read();

    expect((await one.save({ ask: ["first"] })).status).toBe(200);
    expect((await two.save({ deny: ["second"] })).status).toBe(409);
    // Reading again is what makes it this window's decision about the boundary there is now.
    await two.read();
    expect((await two.save({ deny: ["second"] })).status).toBe(200);
    expect(policyStore.get()).toEqual({
      deny: ["second"],
      ask: ["first"],
      allow: ["true"],
    });
    // And now the first is the one whose copy is old.
    expect((await one.save({ ask: [] })).status).toBe(409);
    expect(policyStore.get().ask).toEqual(["first"]);
    expect(changed(rows)).toHaveLength(2);
  });

  test("two saves that arrive together were made against one boundary, and one of them is stored", async () => {
    const { app, policyStore, rows } = surface(ADMIN);
    const one = windowOn(app);
    const two = windowOn(app);
    await one.read();
    await two.read();

    const [first, second] = await Promise.all([
      one.save({ ask: ["first"] }),
      two.save({ deny: ["second"] }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    // Whichever it was, the boundary is that one's whole and nothing of the other's.
    expect(policyStore.get()).toEqual(
      first.status === 200
        ? { deny: [], ask: ["first"], allow: ["true"] }
        : { deny: ["second"], ask: [], allow: ["true"] },
    );
    expect(changed(rows)).toHaveLength(1);
  });

  test("a save that changes nothing leaves the mark as it was, so it turns nobody else's window away", async () => {
    // The mark is the boundary's own digest, not a count of saves: only a boundary that differs
    // is a different one.
    const { app, policyStore } = surface(ADMIN);
    const one = windowOn(app);
    const two = windowOn(app);
    const read = await one.read();
    await two.read();

    expect((await one.save({})).status).toBe(200);
    expect(policyStore.revision()).toBe(read.revision);
    expect((await two.save({ ask: ["mine"] })).status).toBe(200);
    expect(policyStore.get().ask).toEqual(["mine"]);
  });

  test("the rule this server no longer takes is refused by name, with what to write instead — and nothing is stored", async () => {
    const { app, policyStore, rows } = surface(ADMIN);
    const window = windowOn(app);
    await window.read();
    const before = policyStore.get();

    for (const list of ["ask", "deny"] as const) {
      const refused = await window.save({
        [list]: ["repeat.count >= 5", RETIRED_NOTES_RULE],
      });
      expect([list, refused.status, refused.body]).toEqual([
        list,
        400,
        {
          error: "laf:policy_rule_retired",
          code: "laf:policy_rule_retired",
          list,
          rule: RETIRED_NOTES_RULE,
          replacement: NOTES_RULE,
        },
      ]);
    }
    expect(policyStore.get()).toEqual(before);
    expect(changed(rows)).toEqual([]);

    // The rule that replaced it is taken, in the same window — its copy was never the trouble.
    expect((await window.save({ ask: [NOTES_RULE] })).status).toBe(200);
    expect(policyStore.get().ask).toEqual([NOTES_RULE]);
  });

  test("a window from before the upgrade, saving the old rule back, is told its copy is old — not about a rule nobody typed", async () => {
    /*
     * The case that was measured: the copy a window read before a migration rewrote that rule,
     * sent back whole. It holds the retired rule only because it is out of date, so that is what
     * it is told — a page that knows the answer then reads the boundary again, where the rule is
     * not. Told the rule was not taken, its person would be editing a list they should not be
     * saving from at all.
     */
    const { app, policyStore, rows } = surface(ADMIN);
    const before = policyStore.get();
    const send = async (body: unknown) => {
      const response = await app.request("/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return [
        response.status,
        ((await response.json()) as { code: string }).code,
      ];
    };
    const stale = { deny: [], ask: [RETIRED_NOTES_RULE], allow: ["true"] };

    // With no mark at all (a page from before marks existed), and with the mark of a boundary
    // that is not the one in force (a page from after).
    expect(await send(stale)).toEqual([409, "laf:policy_changed"]);
    expect(await send({ ...stale, revision: revisionOf(stale) })).toEqual([
      409,
      "laf:policy_changed",
    ]);
    // Made against the boundary in force, the same body is somebody typing the old rule in.
    expect(await send({ ...stale, revision: policyStore.revision() })).toEqual([
      400,
      "laf:policy_rule_retired",
    ]);
    // And what is no policy at all is said to be that, whatever mark it does or does not carry:
    // it was never anybody's copy of a boundary, old or new.
    expect(await send({ deny: "everything" })).toEqual([
      400,
      "laf:policy_list_invalid",
    ]);
    expect(
      await send({ deny: "everything", revision: policyStore.revision() }),
    ).toEqual([400, "laf:policy_list_invalid"]);
    expect(policyStore.get()).toEqual(before);
    expect(changed(rows)).toEqual([]);
  });
  test("a boundary that still holds the retired rule can be saved around and repaired from the screen — in both lists, one removal at a time", async () => {
    /*
     * Codex's read of this change. The screen's Remove takes a rule out of its own list and sends
     * the rest back; with the rule in both lists the other copy was still in the body, so neither
     * removal was taken and every other save was refused with them. What is refused is the rule
     * coming into a list — not a list handing back what it holds.
     */
    const { app, policyStore, rows } = surface(ADMIN);
    // Past the door on purpose: a row written by hand, or restored from a copy made before.
    await policyStore.set(
      {
        deny: [RETIRED_NOTES_RULE],
        ask: ["repeat.count >= 5", RETIRED_NOTES_RULE],
        allow: ["true"],
      },
      { revision: policyStore.revision() },
    );
    const window = windowOn(app);
    const held = await window.read();

    // Something else changed, the rule handed back where it was: stored.
    expect(
      (await window.save({ ask: [...held.policy.ask, 'intent == "upload"'] }))
        .status,
    ).toBe(200);
    // Taken out of one list, with the other's copy still in the body: stored.
    expect((await window.save({ deny: [] })).status).toBe(200);
    // Brought back into the list that no longer holds it: refused, by that list's name.
    const back = await window.save({ deny: [RETIRED_NOTES_RULE] });
    expect([back.status, back.code, back.body.list]).toEqual([
      400,
      "laf:policy_rule_retired",
      "deny",
    ]);
    // And out of the other.
    expect(
      (await window.save({ ask: ["repeat.count >= 5", 'intent == "upload"'] }))
        .status,
    ).toBe(200);
    expect(policyStore.get()).toEqual({
      deny: [],
      ask: ["repeat.count >= 5", 'intent == "upload"'],
      allow: ["true"],
    });
    // Gone from the boundary, it is the rule nobody may bring in again.
    expect((await window.save({ ask: [RETIRED_NOTES_RULE] })).status).toBe(400);
    expect(changed(rows)).toHaveLength(3);
  });

  test("a body that is no policy is told so before anything about the mark or the rule, whichever else it holds", async () => {
    /*
     * The three answers have an order — what is no policy (400), then a copy that is out of date
     * (409), then the rule that is not taken (400) — and the first has to be first for every way
     * of being no policy. The switch was looked at after the rule, so a body with both went the
     * later way: told its copy was old, and sent to read a boundary it was never a copy of.
     */
    const { app, policyStore, rows } = surface(ADMIN);
    const before = policyStore.get();
    const current = policyStore.revision();
    const send = async (body: unknown, raw = false) => {
      const response = await app.request("/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: raw ? String(body) : JSON.stringify(body),
      });
      const answer = (await response.json()) as Record<string, unknown>;
      return [response.status, answer.code, answer.list ?? null];
    };
    const retired = { ask: [RETIRED_NOTES_RULE] };
    const noPolicy: [unknown, string, string | null, boolean?][] = [
      ["{ not json", "laf:policy_not_object", null, true],
      [null, "laf:policy_not_object", null],
      ["a policy", "laf:policy_not_object", null],
      [{ ...retired, deny: "everything" }, "laf:policy_list_invalid", "deny"],
      [
        { deny: [RETIRED_NOTES_RULE], ask: [1] },
        "laf:policy_list_invalid",
        "ask",
      ],
      [{ ...retired, allow: "true" }, "laf:policy_list_invalid", "allow"],
      [
        { ...retired, settleWithoutAsking: "sometimes" },
        "laf:policy_settle_invalid",
        null,
      ],
    ];
    for (const [body, code, list, raw] of noPolicy) {
      // With no mark, with one that was never handed out, and with the one in force.
      for (const revision of [undefined, "not a mark", current]) {
        const sent =
          raw || body === null || typeof body !== "object"
            ? body
            : { ...body, ...(revision === undefined ? {} : { revision }) };
        expect([code, revision, await send(sent, raw)]).toEqual([
          code,
          revision,
          [400, code, list],
        ]);
      }
    }
    expect(policyStore.get()).toBe(before);
    expect(changed(rows)).toEqual([]);
  });

  test("a save is answered with the boundary in force and that boundary's mark — also when another save landed before the answer left", async () => {
    /*
     * The answer is what the window holds from then on, and its next save presents that mark. So
     * the two are a pair, read from the store together. Answered with the rules it had sent beside
     * the mark in force, the first window here would hold its own older rules under the second
     * window's mark, and its next save would write them over the second's with nothing refused:
     * the lost update this mark exists to stop, by way of the answer.
     *
     * The one wait between the write and the answer is the trail's row, so that is what is slow.
     */
    const { app, policyStore, rows } = surface(
      ADMIN,
      undefined,
      undefined,
      undefined,
      20,
    );
    const one = windowOn(app);
    const two = windowOn(app);
    await one.read();

    const first = one.save({ deny: ["one"] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Stored, and its answer still waiting on the trail.
    expect(policyStore.get().deny).toEqual(["one"]);
    await two.read();
    expect((await two.save({ ask: ["two"] })).status).toBe(200);

    const answered = await first;
    const inForce = { deny: ["one"], ask: ["two"], allow: ["true"] };
    expect([answered.status, answered.body]).toEqual([
      200,
      { policy: inForce, revision: revisionOf(inForce) },
    ]);
    expect(answered.body.revision).toBe(policyStore.revision());
    // And so the first window's next save is made against what is there, and keeps the second's.
    expect((await one.save({ deny: ["one", "more"] })).status).toBe(200);
    expect(policyStore.get()).toEqual({ ...inForce, deny: ["one", "more"] });
    expect(changed(rows)).toHaveLength(3);
  });
});

describe("a boundary decided in front of the browser", () => {
  const DENYING: ActionPolicy = {
    deny: ['intent == "activate"'],
    ask: [],
    allow: ["true"],
  };
  const ASKING: ActionPolicy = {
    deny: [],
    ask: ['contains(element.name, "Submit")'],
    allow: ["true"],
  };

  test("a deny rule refuses a click at the route, and the refusal is a row", async () => {
    /*
     * Until this test nothing checked that the route in front of a refused action reports the
     * refusal rather than a malfunction. 403 is what the surface renders as Blocked; a 500 would
     * send somebody looking for a broken container.
     *
     * It pressed `/type` until that door went with the window that called it (2026-10-06). What a
     * refusal's row keeps of a value a Bot was typing is held where a Bot types now, in its turn
     * (`chat-tools.test.ts`, "what a Bot was typing is not in the row its refusal leaves").
     */
    const { app, sentToComputer, rows, seen } = surface(ADMIN, DENYING);
    await seen();

    const response = await app.request("/bot-1/click", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "e9", snapshotId: 7 }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { rule?: string };
    expect(body.rule).toBe('intent == "activate"');
    // Nothing reached the browser, which is the only guarantee a boundary makes.
    expect(sentToComputer).toEqual([]);
    const refusal = rows.find(
      (row) => row.eventType === "computer.action_refused",
    );
    expect(refusal?.payload).toMatchObject({
      action: "computer_click",
      bot: "bot-1",
      decision: {
        allowed: false,
        source: "deny",
        rule: 'intent == "activate"',
      },
    });
  });

  test("an ask rule stops the call and opens a question instead", async () => {
    // 409 and not 403: a question is not a refusal, and a Bot told 403 stops and says so. Every ask
    // rule an operator writes would become a deny rule if this route collapsed the two.
    const { app, sentToComputer, rows, seen } = surface(ADMIN, ASKING);
    await seen();

    const response = await app.request("/bot-1/click", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "e9", snapshotId: 7 }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      awaitingApproval?: boolean;
      approvalId?: string;
      rule?: string;
    };
    expect(body.awaitingApproval).toBe(true);
    expect(body.approvalId).toBeTypeOf("string");
    expect(body.rule).toBe('contains(element.name, "Submit")');
    expect(sentToComputer).toEqual([]);
    expect(rows.map((row) => row.eventType)).toContain("approval.requested");
  });
});

/**
 * THE VALUE, AND EVERYTHING THAT OUTLIVES THE REQUEST.
 *
 * A secret has exactly one path: a person's keyboard, through this server, into the page. Every
 * other thing that survives the call — the audit row, the response body — is a place it must not
 * be, and each of them is written by different code that has no reason to know it is holding one.
 *
 * Asserted by serialising each of them whole and looking for the string, rather than by checking
 * the fields somebody thought of. A field added later is exactly the way this breaks.
 */
describe("a secret being asked for and supplied", () => {
  const carrying = (thing: unknown) => JSON.stringify(thing) ?? "";

  test("the request names the field and the label, and holds no value", async () => {
    const { app, calls, rows, sentToComputer, seen } = surface(ADMIN);
    // The field has to be on a screen the server holds: a request for a ref it never saw is
    // refused, which is the security review's rule and is pinned in computer-gateway.test.ts.
    await seen();

    const response = await app.request("/bot-1/control/secret", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "은행 비밀번호",
        ref: "e4",
        snapshotId: 7,
      }),
    });

    expect(response.status).toBe(200);
    expect(calls).toContain("requestSecret");
    const asked = rows.find(
      (row) => row.eventType === "computer.secret_requested",
    );
    // What an investigator needs: a human credential entered this session, called this, into that
    // field. The request carries no value at all, so there is nothing here to leave out. The field
    // is named as the SERVER resolved it — role, label and host — beside the Bot's own words.
    expect(asked?.payload).toMatchObject({
      reason: '은행 비밀번호 (into textbox "Customer name" on example.com)',
    });
    // The card as the computer is handed it: its one box, in the list a card's boxes are in.
    expect(sentToComputer).toEqual([
      { fields: [{ label: "은행 비밀번호", ref: "e4" }], snapshotId: 7 },
    ]);
  });

  test("supplying one records that it happened and how long it was, never what it was", async () => {
    const { app, rows, seen } = surface(ADMIN);
    await seen();
    const asked = await app.request("/bot-1/control/secret", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "은행 비밀번호",
        ref: "e4",
        snapshotId: 7,
      }),
    });
    expect(asked.status).toBe(200);

    const response = await app.request("/bot-1/human/secret", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: SECRET }),
    });

    expect(response.status).toBe(200);
    const answered = (await response.json()) as { characters?: number };
    // Its length, which is how a person sees that something real was entered.
    expect(answered.characters).toBe(SECRET.length);
    expect(carrying(answered)).not.toContain(SECRET);

    const supplied = rows.find(
      (row) => row.eventType === "computer.secret_supplied",
    );
    expect(supplied?.payload).toMatchObject({
      reason: `${SECRET.length} characters`,
    });
    // Every row, not only that one: nothing else along the way may have picked it up either.
    expect(carrying(rows)).not.toContain(SECRET);
  });

  test("a card of several boxes goes through the same two doors: a value for every box, or none reaches the computer", async () => {
    const OTHER = "010-CANARY-4477";
    const { app, calls, rows, seen } = surface(ADMIN);
    await seen();
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const asked = await post("/bot-1/control/secret", {
      fields: [
        { ref: "e4", label: "이름" },
        { ref: "e5", label: "전화번호" },
      ],
      snapshotId: 7,
    });
    expect(asked.status).toBe(200);
    expect(
      rows.find((row) => row.eventType === "computer.secret_requested")?.payload
        .reason,
    ).toBe(
      '이름 (into textbox "Customer name" on example.com); 전화번호 (into textbox "Phone" on example.com)',
    );

    // One value is what a window from before a card held several sends: not this card's answer.
    // Nor is a list with a hole in it, or with something that is not a value.
    for (const body of [
      { text: SECRET },
      { values: [SECRET] },
      { values: [SECRET, ""] },
      { values: [SECRET, 7] },
      { values: [] },
    ]) {
      const short = await post("/bot-1/human/secret", body);
      expect([short.status, await short.json()]).toEqual([
        400,
        {
          error: "laf:secret_value_required",
          code: "laf:secret_value_required",
        },
      ]);
    }
    expect(calls).not.toContain("supplySecret");

    const response = await post("/bot-1/human/secret", {
      values: [SECRET, OTHER],
    });
    expect(response.status).toBe(200);
    const answered = (await response.json()) as { characters?: number };
    expect(answered.characters).toBe(SECRET.length + OTHER.length);
    expect(
      rows.find((row) => row.eventType === "computer.secret_supplied")?.payload,
    ).toMatchObject({
      reason: `${SECRET.length + OTHER.length} characters in 2 fields`,
    });
    for (const value of [SECRET, OTHER]) {
      expect(carrying(answered)).not.toContain(value);
      expect(carrying(rows)).not.toContain(value);
    }
  });

  /*
   * THE TICK THAT KEEPS WHAT WAS TYPED AS A SAVED LOGIN (2026-10-10, record §6, piece 2-6) is read
   * here and passed on: that the person said so, and what to call it. This deployment's stand-in
   * has no vault, so the gateway keeps nothing and says so — which is how this test tells a tick
   * that was passed on from one that was not. What it keeps, and when, is the gateway's
   * (`saved-login-fill.test.ts`).
   */
  test("a person's tick to keep the login is passed on with its name, and anything else under it is no tick", async () => {
    const { app, seen } = surface(ADMIN);
    await seen();
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const answered = async (save: unknown) => {
      await post("/bot-1/control/secret", {
        label: "은행 비밀번호",
        ref: "e4",
        snapshotId: 7,
      });
      const response = await post("/bot-1/human/secret", {
        values: [SECRET],
        ...(save === undefined ? {} : { save }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    };
    // Said, with a name: the gateway was asked, and answers that nothing was kept.
    expect(await answered({ label: "은행" })).toMatchObject({
      loginSaved: false,
    });
    // Not said: no tick, a name that is not one, or something that is not a tick at all.
    for (const save of [
      undefined,
      {},
      { label: "" },
      { label: " " },
      { label: 7 },
      "yes",
      true,
    ]) {
      expect(await answered(save)).not.toHaveProperty("loginSaved");
    }
  });

  test("a value nothing asked for reaches no computer: the door answers what the computer says of one", async () => {
    /*
     * It used to be passed on, and the computer put it wherever its own note of a request named.
     * A value is held to the field the gateway judged the request on now, so a value with no
     * request held here — this server restarted between the question and the answer, or nothing
     * ever asked — has no field to be held to, and goes nowhere.
     */
    const { app, rows, sentToComputer, seen } = surface(ADMIN);
    await seen();
    const response = await app.request("/bot-1/human/secret", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: SECRET }),
    });
    expect([response.status, await response.json()]).toEqual([
      409,
      { error: "laf:secret_not_pending", code: "laf:secret_not_pending" },
    ]);
    expect(carrying(sentToComputer)).not.toContain(SECRET);
    expect(carrying(rows)).not.toContain(SECRET);
    expect(
      rows.filter((row) => row.eventType === "computer.secret_supplied"),
    ).toEqual([]);
  });

  test("the value is in no row and no reply, on its way through", async () => {
    const { app, rows, sentToComputer, seen } = surface(ADMIN);
    await seen();

    const replies: unknown[] = [];
    /*
     * The Bot asking, and a person handing the value over in the masked box — the two calls a real
     * secret entry is made of, in order. A third, a person typing it into the page with their own
     * keyboard, went with taking the wheel (2026-10-09).
     *
     * The label the Bot sends is its own words for the field and is recorded, deliberately: it is
     * what tells an investigator which credential entered this session. It is not a place the value
     * can appear, because a Bot asking for a secret is by construction a Bot that does not have one.
     * The call that DOES carry it is the second.
     */
    for (const [path, body] of [
      [
        "/bot-1/control/secret",
        { label: "은행 비밀번호", ref: "e4", snapshotId: 7 },
      ],
      ["/bot-1/human/secret", { text: SECRET }],
    ] as const) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect([path, response.status]).toEqual([path, 200]);
      replies.push(await response.json());
    }

    // The reply and the trail — serialised whole, so a field somebody adds later is covered without
    // anybody remembering to cover it.
    expect(carrying(replies)).not.toContain(SECRET);
    expect(carrying(rows)).not.toContain(SECRET);

    // And the one place it is allowed to be: on its way through to the browser.
    expect(carrying(sentToComputer)).toContain(SECRET);
  });
});

/**
 * Every route in this file, hit once, by somebody who is not an administrator.
 *
 * Two properties at once, and both are about routes nobody wrote a test for. Every route requires a
 * session: one mounted without `requireUser` reads `context.var.actor` and throws, so an unguarded
 * route fails here rather than in production. And exactly three of them are an administrator's, so
 * a fourth appearing — or one of the three losing its guard — changes this list.
 */
describe("the whole surface", () => {
  const ROUTES: Array<[string, string, unknown?]> = [
    ["GET", "/bot-1/screenshot"],
    ["GET", "/bot-1/read"],
    ["POST", "/bot-1/navigate", { url: "https://example.com" }],
    ["POST", "/bot-1/snapshot"],
    ["POST", "/bot-1/click", { ref: "e9", snapshotId: 7 }],
    ["GET", "/bot-1/control"],
    ["POST", "/bot-1/control/request", { reason: "stuck" }],
    ["GET", "/"],
    ["POST", "/bot-1/computers/stop"],
    ["POST", "/bot-1/computers/reset"],
    ["POST", "/bot-1/control/release"],
    [
      "POST",
      "/bot-1/control/secret",
      { label: "PIN", ref: "e4", snapshotId: 7 },
    ],
    ["POST", "/bot-1/human/secret", { text: "x" }],
    // The person's own doors into the Bot's folder (`computer-file-handoff.test.ts`).
    ["GET", "/bot-1/files"],
    ["GET", "/bot-1/files/info?path=notes.md"],
    ["GET", "/bot-1/files/download?path=notes.md"],
    ["GET", "/policy"],
    [
      "PUT",
      "/policy",
      // As the screen sends it: with the mark of the boundary it read, which is the one a fresh
      // surface holds. Without it this is a save against no boundary, and a 409 for everybody.
      {
        deny: [],
        ask: [],
        allow: ["true"],
        revision: revisionOf({ deny: [], ask: [], allow: ["true"] }),
      },
    ],
  ];

  /**
   * Which of them an ordinary member of staff may not have.
   *
   * `GET /` is the list of what the container holds — every Bot's browser, not one Bot's — and the
   * only page that reads it is the admin one. It sat at `/:botId/computers` until 2026-09-16, where
   * the ownership guard in front of it turned the page's made-up Bot id into a 404 for everybody.
   */
  const ADMIN_ONLY = new Set([
    "POST /bot-1/computers/reset",
    "GET /",
    "GET /policy",
    "PUT /policy",
  ]);

  const send = (app: Hono<{ Variables: AppVariables }>) =>
    async function hit([method, path, body]: [string, string, unknown?]) {
      return app.request(path, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
    };

  /*
   * THE SAME SWEEP ON A BOT THAT IS NOT THE CALLER'S.
   *
   * Measured 2026-09-10 (audit A8): a signed-in colleague named the owner's Bot in the path and got
   * the screenshot back, 200 and 6,387 bytes, then `/read`, `/control` and `control/take` — the
   * one middleware here looked at the SHAPE of the id and nothing asked whose it was, while every
   * other door a Bot id opens (chat, the live screen, tool calls) had been closed with the same
   * predicate. One middleware, so the next route added cannot forget; and 404 with the code, not
   * 403, so the refusal does not confirm that the Bot exists.
   */
  test("refuses every one of them on a Bot that is not the caller's, and reaches nothing", async () => {
    const { app, seen, calls, rows, sentToComputer } = surface(STAFF);
    await seen();
    const hit = send(app);

    for (const [method, path, body] of ROUTES) {
      if (!path.startsWith("/bot-1/")) continue;
      const elsewhere = path.replace("/bot-1/", "/bot-2/");
      const response = await hit([method, elsewhere, body]);
      const answer = (await response.json()) as { code?: string };
      expect([`${method} ${path}`, response.status, answer.code]).toEqual([
        `${method} ${path}`,
        404,
        "laf:bot_not_found",
      ]);
    }
    // Nothing reached the computer and nothing was written about a Bot the caller may not drive:
    // the refusal happened before any handler, which is the only place it can be relied on.
    expect(calls).toEqual([]);
    expect(sentToComputer).toEqual([]);
    expect(rows.filter((row) => row.targetId === "bot-2")).toEqual([]);
  });

  test("answers every route, and refuses exactly the four that are an owner's", async () => {
    const { app, seen } = surface(STAFF);
    await seen();
    const hit = send(app);

    const statuses: Array<[string, number]> = [];
    for (const route of ROUTES) {
      statuses.push([`${route[0]} ${route[1]}`, (await hit(route)).status]);
    }

    expect(statuses).toHaveLength(ROUTES.length);
    for (const [route, status] of statuses) {
      // Every one did the thing; never a 500, which is what a route reading an actor that was never
      // set produces.
      const expected = ADMIN_ONLY.has(route) ? [403] : [200];
      expect([route, expected.includes(status), status]).toEqual([
        route,
        true,
        status,
      ]);
    }
  });

  test("refuses every one of them a Bot id that is a path", async () => {
    /*
     * The same sweep, with `bot-1` replaced by an escape. One middleware guards these rather than a
     * check per handler, and this is what says so: a route added later that forgets is not a route
     * that can forget, and a middleware quietly narrowed to one path shows up here rather than in a
     * container with a file written outside its profile.
     */
    const { app, seen } = surface(ADMIN);
    await seen();
    const hit = send(app);

    for (const [method, path, body] of ROUTES) {
      if (!path.startsWith("/bot-1/")) continue;
      const escaped = path.replace("/bot-1/", "/..%2F..%2Ftmp%2Fx/");
      const response = await hit([method, escaped, body]);
      expect([`${method} ${path}`, response.status]).toEqual([
        `${method} ${path}`,
        400,
      ]);
    }
  });

  test("gives an administrator the four the staff member was refused", async () => {
    const { app, seen } = surface(ADMIN);
    await seen();
    const hit = send(app);

    for (const route of ROUTES.filter(([method, path]) =>
      ADMIN_ONLY.has(`${method} ${path}`),
    )) {
      const response = await hit(route);
      expect([`${route[0]} ${route[1]}`, response.status]).toEqual([
        `${route[0]} ${route[1]}`,
        200,
      ]);
    }
  });
});
