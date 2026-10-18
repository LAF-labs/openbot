import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import type {
  HubBudget,
  HubBudgetEntry,
  HubJob,
  HubSync,
  HubTask,
} from "../../shared/hub/protocol";
import { sweepExpiredReservations } from "../src/budget";
import {
  asMember,
  newPass,
  putMember,
  startTestHub,
  type TestHub,
} from "./support/hub";

let hub: TestHub;
const ann = {
  email: "ann@example.com",
  vmOrigin: "https://ann.example",
  pass: newPass(),
};
const ben = {
  email: "ben@example.com",
  vmOrigin: "https://ben.example",
  pass: newPass(),
};
const cho = {
  email: "cho@example.com",
  vmOrigin: "https://cho.example",
  pass: newPass(),
  role: "admin" as const,
};
const dan = {
  email: "dan@example.com",
  vmOrigin: "https://dan.example",
  pass: newPass(),
};
let annId = "";
let benId = "";

beforeAll(async () => {
  hub = await startTestHub();
  annId = (await putMember(hub, ann)).id;
  benId = (await putMember(hub, ben)).id;
  await putMember(hub, cho);
  await putMember(hub, dan);
});
afterAll(() => hub.stop());

// This file's hub has a database of its own (`startTestHub`), so every test starts from an empty
// ledger without reaching anything another file made. The trail is append-only and is left alone.
beforeEach(async () => {
  await hub.database.execute(sql`delete from hub_budget_entries`);
  await hub.database.execute(sql`delete from hub_budget_limits`);
  await hub.database.execute(sql`delete from hub_jobs`);
});

type Reply = { status: number; body: Record<string, unknown> };

async function call(
  pass: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Reply> {
  const response = await fetch(`${hub.url}/hub/v1${path}`, {
    ...asMember(pass, { "content-type": "application/json" }),
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

const reserve = (
  pass: string,
  runId: string,
  amount: number,
  scopes?: string[],
) =>
  call(pass, "POST", "/budget/reserve", {
    runId,
    amount,
    ...(scopes ? { scopes } : {}),
  });

const settle = (
  pass: string,
  runId: string,
  actual: number,
  scopes?: string[],
) =>
  call(pass, "POST", "/budget/settle", {
    runId,
    actual,
    ...(scopes ? { scopes } : {}),
  });

const setLimits = (limits: { scope: string; dailyUsd: number | null }[]) =>
  call(cho.pass, "PUT", "/budget/limits", { limits });

async function budget(pass: string): Promise<HubBudget> {
  const reply = await call(pass, "GET", "/budget");
  expect(reply.status).toBe(200);
  return reply.body as unknown as HubBudget;
}

async function sync(pass: string, since: number): Promise<HubSync> {
  const reply = await call(pass, "GET", `/sync?since=${since}`);
  return reply.body as unknown as HubSync;
}

async function headSeq(): Promise<number> {
  const rows = await hub.database.execute<{ head: string | null }>(
    sql`select max(seq)::text as head from hub_events`,
  );
  return Number(rows[0]?.head ?? 0);
}

async function entry(member: string, runId: string) {
  const rows = await hub.database.execute<{
    state: string;
    reserved: string;
    actual: string | null;
  }>(
    sql`select state, reserved::text, actual::text from hub_budget_entries where member = ${member} and run_id = ${runId}`,
  );
  return rows[0];
}

describe("reserve", () => {
  test("two VMs racing for the last dollar: of ten $0.2 reservations against $1, exactly five pass", async () => {
    expect(
      (await setLimits([{ scope: "workspace", dailyUsd: 1 }])).status,
    ).toBe(200);
    const replies = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        reserve(
          index % 2 === 0 ? ann.pass : ben.pass,
          `run-race-${index}`,
          0.2,
        ),
      ),
    );
    const passed = replies.filter((reply) => reply.status === 200);
    const refused = replies.filter((reply) => reply.status === 409);
    expect(passed).toHaveLength(5);
    expect(refused).toHaveLength(5);
    for (const reply of refused) {
      expect(reply.body).toEqual({
        ok: false,
        code: "laf:budget_reached",
        scope: "workspace",
      });
    }
    const [sum] = await hub.database.execute<{ total: string }>(
      sql`select sum(reserved)::text as total from hub_budget_entries`,
    );
    expect(sum?.total).toBe("1.000000");
  });

  test("with no limit set, the workspace's day is its active seats × $0.6, and a new seat raises it", async () => {
    const before = await budget(cho.pass);
    expect(before.workspace.seats).toBe(4);
    expect(before.workspace.limit).toBe(2.4);
    for (let index = 0; index < 4; index += 1) {
      expect((await reserve(ann.pass, `run-seat-${index}`, 0.6)).status).toBe(
        200,
      );
    }
    const full = await reserve(ann.pass, "run-seat-over", 0.6);
    expect(full.status).toBe(409);
    expect(full.body.scope).toBe("workspace");

    await putMember(hub, {
      email: "eve@example.com",
      vmOrigin: "https://eve.example",
      pass: newPass(),
    });
    expect((await budget(cho.pass)).workspace.limit).toBe(3);
    expect((await reserve(ann.pass, "run-seat-over", 0.6)).status).toBe(200);
  });

  test("a job's own limit refuses with the job's scope while the workspace has room, and says budget.reached once", async () => {
    await call(ann.pass, "PUT", "/jobs/j-limit", { name: "A job" });
    await setLimits([{ scope: "job:j-limit", dailyUsd: 0.3 }]);
    const since = await headSeq();
    expect(
      (await reserve(ann.pass, "run-job-1", 0.2, ["job:j-limit"])).status,
    ).toBe(200);
    const refused = await reserve(ann.pass, "run-job-2", 0.2, ["job:j-limit"]);
    expect(refused.status).toBe(409);
    expect(refused.body.scope).toBe("job:j-limit");
    expect(
      (await reserve(ann.pass, "run-job-3", 0.2, ["job:j-limit"])).status,
    ).toBe(409);
    // A run outside the job still fits in the workspace.
    expect((await reserve(ann.pass, "run-plain", 0.2)).status).toBe(200);

    const reached = (await sync(ann.pass, since)).events.filter(
      (event) => event.type === "budget.reached",
    );
    expect(reached.map((event) => event.refId)).toEqual(["job:j-limit"]);
    // Not the job's, not an admin, not the one refused: not told.
    expect(
      (await sync(dan.pass, since)).events.some(
        (event) => event.type === "budget.reached",
      ),
    ).toBe(false);
  });

  test("a reservation may not name a job another member's VM runs", async () => {
    await call(ann.pass, "PUT", "/jobs/j-anns", { name: "Ann's job" });
    const reply = await reserve(ben.pass, "run-not-mine", 0.2, ["job:j-anns"]);
    expect(reply.status).toBe(403);
    expect(await entry(benId, "run-not-mine")).toBeUndefined();
    expect(
      (await reserve(ann.pass, "run-mine", 0.2, ["job:j-anns"])).status,
    ).toBe(200);
  });

  test("a task scope counts only for a task the member can see", async () => {
    const made = await call(ann.pass, "POST", "/tasks", {
      title: "Kept to ann",
      visibility: "me",
    });
    const task = made.body.task as HubTask;
    expect(
      (await reserve(ben.pass, "run-hidden", 0.1, [`task:${task.id}`])).status,
    ).toBe(404);
    expect(
      (await reserve(ann.pass, "run-own-task", 0.1, [`task:${task.id}`]))
        .status,
    ).toBe(200);
  });

  test("only an owner or admin sets a limit", async () => {
    const before = (await budget(cho.pass)).workspace.limit;
    const reply = await call(ann.pass, "PUT", "/budget/limits", {
      limits: [{ scope: "workspace", dailyUsd: 100 }],
    });
    expect(reply.status).toBe(403);
    expect((await budget(cho.pass)).workspace.limit).toBe(before);
    expect(
      (await setLimits([{ scope: "workspace", dailyUsd: 100 }])).status,
    ).toBe(200);
    expect((await budget(cho.pass)).workspace.limit).toBe(100);
  });
});

describe("settle", () => {
  test("settling twice writes the first actual and answers the second with it unchanged", async () => {
    expect((await reserve(ann.pass, "run-twice", 0.2)).status).toBe(200);
    const first = await settle(ann.pass, "run-twice", 0.15);
    expect(first.status).toBe(200);
    expect((first.body.entry as HubBudgetEntry).actual).toBe(0.15);
    const again = await settle(ann.pass, "run-twice", 0.3);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect((again.body.entry as HubBudgetEntry).actual).toBe(0.15);
    expect(await entry(annId, "run-twice")).toEqual({
      state: "settled",
      reserved: "0.200000",
      actual: "0.150000",
    });
    const view = await budget(ann.pass);
    expect(view.workspace.spent).toBe(0.15);
    expect(view.workspace.reserved).toBe(0);
  });

  test("a settle with no reservation is written and counted", async () => {
    await setLimits([{ scope: "workspace", dailyUsd: 0.5 }]);
    const reply = await settle(ben.pass, "run-unreserved", 0.4);
    expect(reply.status).toBe(200);
    expect(await entry(benId, "run-unreserved")).toEqual({
      state: "settled",
      reserved: "0.000000",
      actual: "0.400000",
    });
    expect((await reserve(ann.pass, "run-after", 0.2)).status).toBe(409);
  });

  test("a settle with no reservation counts only against the scopes its member may name", async () => {
    await call(ann.pass, "PUT", "/jobs/j-ann-settle", { name: "Ann's job" });
    await call(ben.pass, "PUT", "/jobs/j-ben-settle", { name: "Ben's job" });
    const made = await call(ann.pass, "POST", "/tasks", {
      title: "Kept to ann",
      visibility: "me",
    });
    const hidden = `task:${(made.body.task as HubTask).id}`;
    await setLimits([
      { scope: "job:j-ann-settle", dailyUsd: 0.3 },
      { scope: hidden, dailyUsd: 0.3 },
    ]);
    const reply = await settle(ben.pass, "run-settle-others", 0.4, [
      "job:j-ann-settle",
      hidden,
      "job:j-ben-settle",
    ]);
    expect(reply.status).toBe(200);
    // Counted against the workspace and ben's own job; ann's job and task are left off.
    expect((reply.body.entry as HubBudgetEntry).scopes).toEqual([
      "workspace",
      "job:j-ben-settle",
    ]);
    expect(
      (
        await reserve(ann.pass, "run-ann-job", 0.2, [
          "job:j-ann-settle",
          hidden,
        ])
      ).status,
    ).toBe(200);
  });
});

describe("expiry", () => {
  test("a reservation unsettled for thirty minutes is marked expired, still counts, and a late settle replaces it", async () => {
    await setLimits([{ scope: "workspace", dailyUsd: 0.3 }]);
    expect((await reserve(ann.pass, "run-quiet", 0.2)).status).toBe(200);
    expect((await reserve(ben.pass, "run-fresh", 0.05)).status).toBe(200);
    await hub.database.execute(
      sql`update hub_budget_entries set reserved_at = now() - interval '31 minutes' where run_id = 'run-quiet'`,
    );
    expect(await sweepExpiredReservations(hub.database)).toBe(1);
    expect((await entry(annId, "run-quiet"))?.state).toBe("expired");
    expect((await entry(benId, "run-fresh"))?.state).toBe("reserved");

    const view = await budget(cho.pass);
    expect(view.workspace.spent).toBe(0.2);
    expect(view.workspace.reserved).toBe(0.05);
    // Still counted: 0.2 + 0.05 + 0.1 is over 0.3.
    expect((await reserve(ben.pass, "run-blocked", 0.1)).status).toBe(409);

    const late = await settle(ann.pass, "run-quiet", 0.02);
    expect(late.status).toBe(200);
    expect((await entry(annId, "run-quiet"))?.state).toBe("settled");
    expect((await reserve(ben.pass, "run-blocked", 0.1)).status).toBe(200);
    const [trail] = await hub.database.execute<{ outcome: string }>(
      sql`select outcome from hub_audit where action = 'budget.settled' and run_id = 'run-quiet'`,
    );
    expect(trail?.outcome).toBe("late");
  });
});

describe("GET /budget", () => {
  test("a member reads the workspace total and only their own runs; an admin reads everybody's", async () => {
    const made = await call(ann.pass, "POST", "/tasks", {
      title: "Shared",
      visibility: "company",
    });
    const task = made.body.task as HubTask;
    await reserve(ann.pass, "run-ann", 0.2, [`task:${task.id}`]);
    await settle(ann.pass, "run-ann", 0.1);
    await reserve(ben.pass, "run-ben", 0.3);

    const bens = await budget(ben.pass);
    expect(bens.workspace.spent).toBe(0.1);
    expect(bens.workspace.reserved).toBe(0.3);
    expect(bens.members).toEqual([{ member: benId, spent: 0, reserved: 0.3 }]);
    expect(bens.scopes).toEqual([]);

    const chos = await budget(cho.pass);
    expect(chos.members.map((line) => line.member).sort()).toEqual(
      [annId, benId].sort(),
    );
    expect(chos.scopes).toEqual([
      { scope: `task:${task.id}`, limit: null, spent: 0.1, reserved: 0 },
    ]);
  });
});

describe("jobs", () => {
  test("handing a job to another member moves it: job.moved to the old and new runner, job.changed to all", async () => {
    const made = await call(ann.pass, "PUT", "/jobs/j-move", {
      name: "Morning report",
      schedule: "0 9 * * *",
    });
    expect(made.status).toBe(200);
    expect((made.body.job as HubJob).runner).toBe(annId);
    const since = await headSeq();

    const moved = await call(ann.pass, "PUT", "/jobs/j-move", { owner: benId });
    expect(moved.status).toBe(200);
    expect(moved.body.job).toMatchObject({ owner: benId, runner: benId });

    const seen = async (pass: string) =>
      (await sync(pass, since)).events
        .filter((event) => event.refId === "j-move")
        .map((event) => event.type);
    expect(await seen(ann.pass)).toEqual(["job.changed", "job.moved"]);
    expect(await seen(ben.pass)).toEqual(["job.changed", "job.moved"]);
    expect(await seen(dan.pass)).toEqual(["job.changed"]);

    // The job's runs are now ben's to reserve for, and no longer ann's.
    expect(
      (await reserve(ann.pass, "run-old-vm", 0.1, ["job:j-move"])).status,
    ).toBe(403);
    expect(
      (await reserve(ben.pass, "run-new-vm", 0.1, ["job:j-move"])).status,
    ).toBe(200);

    // Ann handed it on; it is no longer hers to edit.
    expect(
      (await call(ann.pass, "PUT", "/jobs/j-move", { name: "Taken back" }))
        .status,
    ).toBe(403);

    const trail = await hub.database.execute(
      sql`select * from hub_audit where target = 'j-move'`,
    );
    expect(trail.length).toBe(2);
    const serialised = JSON.stringify(trail);
    expect(serialised).not.toContain("Morning report");
    expect(serialised).not.toContain("0 9 * * *");
    expect(serialised).toContain(benId);
  });

  test("a member may not set a job's limit, nor register a job for someone else", async () => {
    await call(ann.pass, "PUT", "/jobs/j-own", { name: "Mine" });
    expect(
      (await call(ann.pass, "PUT", "/jobs/j-own", { dailyUsd: 50 })).status,
    ).toBe(403);
    expect(
      (
        await call(ann.pass, "PUT", "/jobs/j-other", {
          name: "X",
          owner: benId,
        })
      ).status,
    ).toBe(403);
    const set = await call(cho.pass, "PUT", "/jobs/j-own", { dailyUsd: 0.5 });
    expect(set.status).toBe(200);
    expect((set.body.job as HubJob).dailyUsd).toBe(0.5);
    const list = await call(dan.pass, "GET", "/jobs");
    expect((list.body.jobs as HubJob[]).map((job) => job.id)).toEqual([
      "j-own",
    ]);
  });

  test("the register takes no prompt: an unknown field is refused and nothing is written", async () => {
    const reply = await call(ann.pass, "PUT", "/jobs/j-prompt", {
      name: "Has a prompt",
      prompt: "do something",
    });
    expect(reply.status).toBe(400);
    expect(reply.body.field).toBe("prompt");
    expect((await call(ann.pass, "GET", "/jobs/j-prompt")).status).toBe(404);
  });
});
