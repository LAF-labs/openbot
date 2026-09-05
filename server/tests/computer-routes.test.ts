import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { ComputerClient } from "../src/computer/client";
import { createApprovalRegistry } from "../src/computer/approvals";
import { createDemonstrationRecorder } from "../src/computer/demonstration";
import { createComputerGateway } from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import { createPolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";
import type {
  HumanInput,
  SecretRequest,
  SnapshotResult,
  TypeInput,
  WriteFileInput,
} from "../src/computer/schema";

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

function fakeClient() {
  const calls: string[] = [];
  /** What `humanInput` was actually handed, which is the whole question in one of these tests. */
  const human: HumanInput[] = [];
  /** Everything the far side was told, so a secret-absence test can search all of it at once. */
  const sentToComputer: unknown[] = [];
  const client = {
    status: async (botId: string) => ({ botId, state: "ready" as const }),
    screenshot: async () => ({
      base64: "aGVsbG8=",
      width: 1280,
      height: 800,
      capturedAt: "2026-09-03T00:00:00.000Z",
    }),
    read: async () => ({ url: SNAPSHOT.url, title: SNAPSHOT.title, text: "" }),
    snapshot: async () => SNAPSHOT,
    navigate: async (url: string) => ({ url, title: "Order", elapsedMs: 3 }),
    click: async () => ({ action: "click", url: SNAPSHOT.url, elapsedMs: 1 }),
    type: async (input: TypeInput) => {
      sentToComputer.push(input);
      return { action: "type", url: SNAPSHOT.url, elapsedMs: 1 };
    },
    key: async () => ({ action: "key", url: SNAPSHOT.url, elapsedMs: 1 }),
    scroll: async () => ({ action: "scroll", url: SNAPSHOT.url, elapsedMs: 1 }),
    listFiles: async () => ({ path: ".", entries: [] }),
    readFile: async () => ({
      path: "notes.md",
      contents: "",
      truncated: false,
    }),
    writeFile: async (input: WriteFileInput) => {
      sentToComputer.push(input);
      return { path: input.path, bytes: input.contents.length };
    },
    control: async () => ({ holder: "bot" as const, url: SNAPSHOT.url }),
    requestControl: async () => ({ holder: "bot" as const, url: SNAPSHOT.url }),
    takeControl: async () => ({ holder: "human" as const, url: SNAPSHOT.url }),
    releaseControl: async () => ({ holder: "bot" as const, url: SNAPSHOT.url }),
    computers: async () => ({ computers: [] }),
    requestSecret: async (input: SecretRequest) => {
      calls.push("requestSecret");
      sentToComputer.push(input);
      return { holder: "human" as const, url: SNAPSHOT.url };
    },
    resetComputer: async () => {
      calls.push("resetComputer");
      return { botId: "bot-1", state: "stopped" as const } as never;
    },
    stopComputer: async () => {
      calls.push("stopComputer");
      return { wasRunning: true } as never;
    },
    humanInput: async (input: HumanInput) => {
      human.push(input);
      sentToComputer.push(input);
      return { action: "human_click", characters: 0 } as never;
    },
    supplySecret: async (text: string) => {
      calls.push("supplySecret");
      // The one place the value legitimately exists: on its way through to the browser.
      sentToComputer.push({ suppliedSecret: text });
      return { characters: text.length } as never;
    },
    forBot() {
      return client;
    },
  } as unknown as ComputerClient;
  return { client, calls, human, sentToComputer };
}

function surface(
  actor: typeof ADMIN | typeof STAFF,
  policy: ActionPolicy = PERMISSIVE,
  /**
   * A trail that will not accept the row, which is a real condition and the one that decides what a
   * 500 body is allowed to say. Every acting route writes an audit row before it answers.
   */
  auditFailure?: Error,
) {
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => {
      if (auditFailure) throw auditFailure;
      rows.push(event);
    },
  };
  const { client, calls, human, sentToComputer } = fakeClient();
  const approvals = createApprovalRegistry();
  const gateway = createComputerGateway({
    client,
    auditStore,
    policy: () => policy,
    approvals,
  });
  const policyStore = createPolicyStore({ deny: [], ask: [], allow: ["true"] });
  /**
   * A real recorder, not a stub.
   *
   * The secret tests serialise it, and a stub that kept nothing would pass them by doing nothing —
   * which is the failure mode this whole file exists to avoid. This one records for real, so the
   * assertion is about what the shipped recorder keeps.
   */
  const demonstrations = createDemonstrationRecorder();
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
    createComputerRoutes(
      client,
      gateway,
      policyStore,
      requireUser,
      demonstrations,
      undefined,
      auditStore,
    ),
  );
  /** The page the gateway is allowed to decide about. Without it every rule is undecidable. */
  const seen = async () =>
    void (await app.request("/bot-1/snapshot", { method: "POST" }));
  return {
    app,
    calls,
    human,
    rows,
    policyStore,
    sentToComputer,
    demonstrations,
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
 * `../../tmp/x`. Measured: `join("/profiles", "../../tmp/x")` is `/tmp/x`, and taking control wrote
 * a file there, as root, inside the container that holds every login this customer has. Any signed
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
      const response = await app.request(`/${id}/control/take`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teaching: true }),
      });
      const body = (await response.json()) as { code?: string };
      expect([id, response.status, body.code]).toEqual([
        id,
        400,
        "laf:bot_id_invalid",
      ]);
    }

    // Nothing reached the computer, nothing was recorded, and no recording was started: the refusal
    // is in front of the handler rather than inside it.
    expect(calls).toEqual([]);
    expect(sentToComputer).toEqual([]);
    expect(rows).toEqual([]);
  });

  test("an id this product mints is not caught by it", async () => {
    // A refusal that also refuses `agent_<uuid>` would take the computer away from every Bot
    // anybody has made, which is the failure worth catching in the same breath.
    const { app } = surface(ADMIN);

    const response = await app.request(
      "/agent_2f1c9a3e-7d24-4a6b-9b1e-0c8f5d2a7b41/control",
      { method: "GET" },
    );

    expect(response.status).toBe(200);
  });
});

/**
 * WHAT A FAILURE MAY SAY ONCE IT IS AN HTTP BODY.
 *
 * Every acting route writes an audit row through the gateway before it answers, so a trail that
 * will not accept the row is a failure that reaches this file — and Drizzle puts the SQL it sent
 * AND its bound parameters into `message`. The route answered with `error.message`, so the reply to
 * a caller was the row the database had just refused, over HTTP, to anybody with a session.
 */
describe("a failure on its way out", () => {
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

  test("carries the database's code, and neither the statement nor what was bound to it", async () => {
    const { app, seen } = surface(ADMIN, PERMISSIVE, queryError());
    await seen();

    const response = await app.request("/bot-1/click", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "e9", snapshotId: 7 }),
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("database error (23505)");
    const said = JSON.stringify(body);
    expect(said).not.toContain("insert into");
    expect(said).not.toContain(SECRET);
  });

  test("still says what an ordinary failure was", async () => {
    // The bound is on how much and what kind, not on saying anything: a caller that cannot be told
    // what went wrong is a caller that reports an outage for a full disk.
    const { app, seen } = surface(
      ADMIN,
      PERMISSIVE,
      new Error("The trail is full."),
    );
    await seen();

    const response = await app.request("/bot-1/click", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "e9", snapshotId: 7 }),
    });

    expect(((await response.json()) as { error?: string }).error).toBe(
      "The trail is full.",
    );
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

describe("a person's own mouse and keyboard", () => {
  test("cannot be rerouted into the secret path by the request body", async () => {
    /*
     * The body used to be spread AFTER the validated `kind`, so `{"kind":"secret"}` overwrote the
     * one the route had just checked: a person's ordinary input became a secret being supplied, on
     * a path this route does not audit and whose whole design is that there is exactly one door
     * into it. `kind` goes last now, and the URL decides.
     */
    const { app, human, calls } = surface(ADMIN);

    const response = await app.request("/bot-1/human/click", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "secret", text: "hunter2", x: 1, y: 2 }),
    });

    expect(response.status).toBe(200);
    expect(human).toHaveLength(1);
    expect(human[0]?.kind).toBe("click");
    // And nothing went down the secret path, which is the thing that must have exactly one door.
    expect(calls).not.toContain("supplySecret");
  });

  test("still refuses a kind the URL does not name", async () => {
    const { app, human } = surface(ADMIN);
    const response = await app.request("/bot-1/human/secretly", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 1, y: 2 }),
    });
    expect(response.status).toBe(400);
    expect(human).toEqual([]);
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
    const { app, rows } = surface(ADMIN);

    const response = await app.request("/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...POLICY,
        reason: "정산 기간이라 사람이 직접 본다",
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
    const { app, rows } = surface(ADMIN);

    await app.request("/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deny: ["submit"], ask: [], allow: ["true"] }),
    });

    const row = rows.find((one) => one.eventType === "computer.policy_changed");
    expect(row?.payload).not.toHaveProperty("settleWithoutAskingWas");
  });

  test("does not keep the reason in the policy it enforces", async () => {
    // The reason is a fact about the change, not a rule. A policy that carried it would put it in
    // front of the evaluator and on every read of the Boundaries page.
    const { app, policyStore } = surface(ADMIN);

    await app.request("/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...POLICY, reason: "왜냐하면" }),
    });

    expect(policyStore.get()).not.toHaveProperty("reason");
    expect(policyStore.get().settleWithoutAsking).toBe("off");
  });
});

describe("a boundary decided in front of the browser", () => {
  const DENYING: ActionPolicy = {
    deny: ['intent == "type"'],
    ask: [],
    allow: ["true"],
  };
  const ASKING: ActionPolicy = {
    deny: [],
    ask: ['contains(element.name, "Customer")'],
    allow: ["true"],
  };

  test("a deny rule refuses typing at the route, and the refusal is a row", async () => {
    /*
     * Typing is the action the shipped policy denies outright — a Bot must not put a value into a
     * password box — and until this test nothing checked that the route in front of it reports the
     * refusal rather than a malfunction. 403 is what the surface renders as Blocked; a 500 would
     * send somebody looking for a broken container.
     */
    const { app, sentToComputer, rows, seen } = surface(ADMIN, DENYING);
    await seen();

    const response = await app.request("/bot-1/type", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "e4", snapshotId: 7, text: "Kim" }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { rule?: string };
    expect(body.rule).toBe('intent == "type"');
    // Nothing reached the browser, which is the only guarantee a boundary makes.
    expect(sentToComputer).toEqual([]);
    const refusal = rows.find(
      (row) => row.eventType === "computer.action_refused",
    );
    expect(refusal?.payload).toMatchObject({
      action: "computer_type",
      bot: "bot-1",
      decision: { allowed: false, source: "deny", rule: 'intent == "type"' },
    });
    // WHAT THE BOT WAS TYPING IS NOT IN THE ROW, and this is the route where that matters most: the
    // shipped policy denies typing into a password box, so the row recording that refusal is written
    // about a field somebody was about to put a credential into.
    expect(JSON.stringify(rows)).not.toContain("Kim");
  });

  test("an ask rule stops the call and opens a question instead", async () => {
    // 409 and not 403: a question is not a refusal, and a Bot told 403 stops and says so. Every ask
    // rule an operator writes would become a deny rule if this route collapsed the two.
    const { app, sentToComputer, rows, seen } = surface(ADMIN, ASKING);
    await seen();

    const response = await app.request("/bot-1/type", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "e4", snapshotId: 7, text: "Kim" }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      awaitingApproval?: boolean;
      approvalId?: string;
      rule?: string;
    };
    expect(body.awaitingApproval).toBe(true);
    expect(body.approvalId).toBeTypeOf("string");
    expect(body.rule).toBe('contains(element.name, "Customer")');
    expect(sentToComputer).toEqual([]);
    expect(rows.map((row) => row.eventType)).toContain("approval.requested");
  });

  test("writing a file is governed the same way, and names the file it refused", async () => {
    /*
     * The workspace is the other thing a Bot can change that nobody is watching. It goes through the
     * same gateway as a click, and the rule language reaches it through `file.*` — which is only
     * true if this route hands the path to the gateway rather than to the client.
     */
    const { app, sentToComputer, rows } = surface(ADMIN, {
      deny: ['file.name == ".env"'],
      ask: [],
      allow: ["true"],
    });

    const refused = await app.request("/bot-1/files/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "secrets/.env", contents: "TOKEN=1" }),
    });

    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { rule?: string }).rule).toBe(
      'file.name == ".env"',
    );
    expect(sentToComputer).toEqual([]);
    expect(
      rows.find((row) => row.eventType === "computer.action_refused")?.payload,
    ).toMatchObject({
      action: "computer_write_file",
      file: "secrets/.env",
      decision: { allowed: false, source: "deny" },
    });
    // The contents are not in the row either. A file a Bot writes is as likely to hold a credential
    // as anything it types, and the row's job is to say which file, not what was in it.
    expect(JSON.stringify(rows)).not.toContain("TOKEN=1");

    // And a file the rule does not name goes through, so the assertion above is about the rule
    // rather than about a route that refuses everything.
    const allowed = await app.request("/bot-1/files/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "notes.md", contents: "hello" }),
    });
    expect(allowed.status).toBe(200);
    expect(sentToComputer).toEqual([
      { path: "notes.md", contents: "hello", append: false },
    ]);
  });

  test("a file call is decidable before the Bot has looked at any page", async () => {
    // The blind guard refuses an action about the screen when this process has never seen one. A
    // file has no screen, and refusing it would have made the workspace unusable until somebody
    // browsed — with a message about a page the Bot was never on.
    const { app } = surface(ADMIN, {
      deny: [],
      ask: ['contains(element.name, "Submit")'],
      allow: ["true"],
    });

    const response = await app.request("/bot-1/files/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "notes.md" }),
    });

    expect(response.status).toBe(200);
  });
});

/**
 * THE VALUE, AND EVERYTHING THAT OUTLIVES THE REQUEST.
 *
 * A secret has exactly one path: a person's keyboard, through this server, into the page. Every
 * other thing that survives the call — the audit row, the response body, the demonstration being
 * recorded beside it — is a place it must not be, and each of them is written by different code
 * that has no reason to know it is holding one.
 *
 * Asserted by serialising each of them whole and looking for the string, rather than by checking
 * the fields somebody thought of. A field added later is exactly the way this breaks.
 */
describe("a secret being asked for and supplied", () => {
  const carrying = (thing: unknown) => JSON.stringify(thing) ?? "";

  test("the request names the field and the label, and holds no value", async () => {
    const { app, calls, rows, sentToComputer } = surface(ADMIN);

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
    // field. The request carries no value at all, so there is nothing here to leave out.
    expect(asked?.payload).toMatchObject({ reason: "은행 비밀번호 (into e4)" });
    expect(sentToComputer).toEqual([
      { label: "은행 비밀번호", ref: "e4", snapshotId: 7 },
    ]);
  });

  test("supplying one records that it happened and how long it was, never what it was", async () => {
    const { app, rows, demonstrations } = surface(ADMIN);
    // A demonstration running at the same moment, which is the realistic case: somebody has taken
    // the wheel in order to type the thing the Bot must not hold.
    await app.request("/bot-1/control/take", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teaching: true }),
    });

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
    expect(carrying(demonstrations.read("bot-1", ADMIN.id))).not.toContain(SECRET);
  });

  test("the value is in no row, no reply and no recording, on either of its two routes", async () => {
    const { app, rows, demonstrations, sentToComputer } = surface(ADMIN);
    await app.request("/bot-1/control/take", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teaching: true }),
    });

    const replies: unknown[] = [];
    /*
     * The Bot asking, a person typing into the page with their own keyboard, and a person handing
     * the value over — the three calls a real secret entry is made of, in order.
     *
     * The label the Bot sends is its own words for the field and is recorded, deliberately: it is
     * what tells an investigator which credential entered this session. It is not a place the value
     * can appear, because a Bot asking for a secret is by construction a Bot that does not have one.
     * The two calls that DO carry it are the second and the third.
     */
    for (const [path, body] of [
      [
        "/bot-1/control/secret",
        { label: "은행 비밀번호", ref: "e4", snapshotId: 7 },
      ],
      ["/bot-1/human/type", { text: SECRET }],
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

    // The reply, the trail and the recording — serialised whole, so a field somebody adds later is
    // covered without anybody remembering to cover it.
    expect(carrying(replies)).not.toContain(SECRET);
    expect(carrying(rows)).not.toContain(SECRET);
    expect(carrying(demonstrations.read("bot-1", ADMIN.id))).not.toContain(SECRET);
    // The demonstration is real and recording, so the absence above is an absence and not an
    // unstarted recorder: handing back closes it, and what it kept is still readable.
    await app.request("/bot-1/control/release", { method: "POST" });
    expect(demonstrations.read("bot-1", ADMIN.id)).not.toBeNull();

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
    ["GET", "/bot-1/status"],
    ["GET", "/bot-1/screenshot"],
    ["GET", "/bot-1/read"],
    ["POST", "/bot-1/navigate", { url: "https://example.com" }],
    ["POST", "/bot-1/snapshot"],
    ["POST", "/bot-1/click", { ref: "e9", snapshotId: 7 }],
    ["POST", "/bot-1/type", { ref: "e4", snapshotId: 7, text: "Kim" }],
    ["POST", "/bot-1/key", { key: "Enter" }],
    ["POST", "/bot-1/scroll", { deltaY: 100 }],
    ["GET", "/bot-1/control"],
    ["POST", "/bot-1/control/request", { reason: "stuck" }],
    ["GET", "/bot-1/computers"],
    ["POST", "/bot-1/computers/stop"],
    ["POST", "/bot-1/computers/reset"],
    ["POST", "/bot-1/control/take", { teaching: true }],
    ["POST", "/bot-1/control/release"],
    ["GET", "/bot-1/demonstration"],
    ["POST", "/bot-1/demonstration/write-up"],
    ["DELETE", "/bot-1/demonstration"],
    [
      "POST",
      "/bot-1/control/secret",
      { label: "PIN", ref: "e4", snapshotId: 7 },
    ],
    ["POST", "/bot-1/human/secret", { text: "x" }],
    ["POST", "/bot-1/human/click", { x: 1, y: 2 }],
    ["POST", "/bot-1/human/type", { text: "x" }],
    ["POST", "/bot-1/human/key", { key: "Enter" }],
    ["POST", "/bot-1/human/scroll", { deltaY: 10 }],
    ["POST", "/bot-1/files/list", { path: "." }],
    ["POST", "/bot-1/files/read", { path: "notes.md" }],
    ["POST", "/bot-1/files/write", { path: "notes.md", contents: "hi" }],
    ["GET", "/policy"],
    ["PUT", "/policy", { deny: [], ask: [], allow: ["true"] }],
  ];

  /** Which of them an ordinary member of staff may not have. */
  const ADMIN_ONLY = new Set([
    "POST /bot-1/computers/reset",
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

  test("answers every route, and refuses exactly the three that are an owner's", async () => {
    const { app, seen } = surface(STAFF);
    await seen();
    const hit = send(app);

    const statuses: Array<[string, number]> = [];
    for (const route of ROUTES) {
      statuses.push([`${route[0]} ${route[1]}`, (await hit(route)).status]);
    }

    expect(statuses).toHaveLength(ROUTES.length);
    for (const [route, status] of statuses) {
      /*
       * 409 is the write-up route with an empty recording, which is what this run leaves it: the
       * wheel was taken and handed back with nothing typed. Everything else either did the thing or
       * was refused for a reason the route itself decided; never a 500, which is what a route
       * reading an actor that was never set produces.
       */
      const expected = ADMIN_ONLY.has(route) ? [403] : [200, 204, 409];
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

  test("gives an administrator the three the staff member was refused", async () => {
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

/**
 * The routes pass the asker through: a recording somebody else started is not read, not written up
 * and not thrown away through them. See the note at the top of `demonstration.ts`.
 */
describe("somebody else's demonstration", () => {
  test("is not readable, not writable-up, and survives a stranger's delete", async () => {
    const { app, demonstrations, sentToComputer } = surface(ADMIN);
    // Started by another person on the same deployment, as the take-control route would have.
    demonstrations.start("bot-1", "the-owner");
    demonstrations.observe("bot-1", { type: "key", event: "down", key: "Enter" });

    const read = await app.request("/bot-1/demonstration");
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ demonstration: null });

    const writeUp = await app.request("/bot-1/demonstration/write-up", {
      method: "POST",
    });
    expect(writeUp.status).toBe(409);
    // No model call was spent on a recording the caller may not look at.
    expect(sentToComputer).toEqual([]);

    const gone = await app.request("/bot-1/demonstration", {
      method: "DELETE",
    });
    expect(gone.status).toBe(204);
    expect(demonstrations.read("bot-1", "the-owner")?.steps).toHaveLength(1);
  });
});
