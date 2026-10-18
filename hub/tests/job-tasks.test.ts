import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { HubTask } from "../../shared/hub/protocol";
import { hubJobs } from "../src/db/schema";
import { emitEvent } from "../src/events";
import { noteJobMove } from "../src/job-handoff";
import { freeMovedJobClaims } from "../src/tasks";
import {
  asMember,
  newPass,
  putMember,
  startTestHub,
  type TestHub,
} from "./support/hub";

/**
 * A task given to a sub-Bot (`job:<id>`) is worked on the VM that runs the job now: its runner in
 * `hub_jobs`, not whoever gave the task to the job, and not a runner it moved away from.
 */

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
const dan = {
  email: "dan@example.com",
  vmOrigin: "https://dan.example",
  pass: newPass(),
};
let benId = "";
let danId = "";

beforeAll(async () => {
  hub = await startTestHub();
  await putMember(hub, ann);
  benId = (await putMember(hub, ben)).id;
  danId = (await putMember(hub, dan)).id;
});
afterAll(() => hub.stop());

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

/** A job `owner` registers for themselves, and a company task `giver` gives to it. */
async function jobTask(
  owner: { pass: string },
  giver: { pass: string },
  jobId: string,
): Promise<HubTask> {
  expect(
    (await call(owner.pass, "PUT", `/jobs/${jobId}`, { name: "Morning" }))
      .status,
  ).toBe(200);
  const made = await call(giver.pass, "POST", "/tasks", {
    title: "Weekly report",
    visibility: "company",
    assignee: `job:${jobId}`,
  });
  expect(made.status).toBe(200);
  return made.body.task as HubTask;
}

const checkout = (pass: string, id: string, runId: string) =>
  call(pass, "POST", `/tasks/${id}/checkout`, { runId });

test("the job's runner takes its task; whoever gave it to the job and a third member do not", async () => {
  const task = await jobTask(ben, ann, "j-runner");
  for (const pass of [ann.pass, dan.pass]) {
    const refused = await checkout(pass, task.id, "run-not-runner");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("laf:task_taken");
  }
  const taken = await checkout(ben.pass, task.id, "run-runner");
  expect(taken.status).toBe(200);
  expect((taken.body.task as HubTask).checkout?.by).toBe(benId);
});

test("the one who gave it may take it when they also run the job", async () => {
  const task = await jobTask(ann, ann, "j-own");
  expect((await checkout(ben.pass, task.id, "run-ben")).status).toBe(409);
  expect((await checkout(ann.pass, task.id, "run-ann")).status).toBe(200);
});

test("a 라피's task stays its member's", async () => {
  const made = await call(ann.pass, "POST", "/tasks", {
    title: "For Ben's 라피",
    visibility: "company",
    assignee: `bot:${benId}`,
  });
  const id = (made.body.task as HubTask).id;
  expect((await checkout(ann.pass, id, "run-ann-bot")).status).toBe(409);
  expect((await checkout(ben.pass, id, "run-ben-bot")).status).toBe(200);
});

test("after the job moves, the old runner's claim is freed and it is refused from then on; the new runner takes it", async () => {
  const task = await jobTask(ben, ann, "j-moving");
  expect((await checkout(ben.pass, task.id, "run-old")).status).toBe(200);
  // Ben hands the job to Dan while his run is still working the task.
  expect(
    (await call(ben.pass, "PUT", "/jobs/j-moving", { owner: danId })).status,
  ).toBe(200);
  const rows = await hub.database.execute<{
    stage: string;
    checkout_by: string | null;
  }>(sql`select stage, checkout_by from hub_tasks where id = ${task.id}`);
  expect(rows[0]).toEqual({ stage: "todo", checkout_by: null });

  const beat = await call(ben.pass, "POST", `/tasks/${task.id}/heartbeat`, {
    runId: "run-old",
  });
  expect(beat.body.code).toBe("laf:task_not_held");
  const report = await call(ben.pass, "PATCH", `/tasks/${task.id}`, {
    as: "bot",
    runId: "run-old",
    stage: "review",
  });
  expect(report.body.code).toBe("laf:task_not_held");
  const release = await call(ben.pass, "POST", `/tasks/${task.id}/release`, {
    runId: "run-old",
  });
  expect(release.body.code).toBe("laf:task_not_held");
  expect((await checkout(ben.pass, task.id, "run-old-again")).status).toBe(409);
  expect((await checkout(dan.pass, task.id, "run-new")).status).toBe(200);
});

test("a holder the task is no longer for keeps nothing alive: its beat and its report are refused", async () => {
  const task = await jobTask(ben, ann, "j-cut");
  expect((await checkout(ben.pass, task.id, "run-cut")).status).toBe(200);
  // The register moves under the claim without the move's own cleanup — as a move racing the beat
  // would leave it — and the beat and the report read who runs the job now.
  await hub.database.execute(
    sql`update hub_jobs set runner = ${danId}, owner = ${danId} where id = 'j-cut'`,
  );
  const beat = await call(ben.pass, "POST", `/tasks/${task.id}/heartbeat`, {
    runId: "run-cut",
  });
  expect(beat.body.code).toBe("laf:task_not_held");
  const report = await call(ben.pass, "PATCH", `/tasks/${task.id}`, {
    as: "bot",
    runId: "run-cut",
    stage: "review",
  });
  expect(report.body.code).toBe("laf:task_not_held");
  // Letting go is always the holder's: the task is back on the board at once.
  const release = await call(ben.pass, "POST", `/tasks/${task.id}/release`, {
    runId: "run-cut",
  });
  expect(release.status).toBe(200);
  expect((release.body.task as HubTask).stage).toBe("todo");
});

/** Until some statement on this file's database waits for a lock another transaction holds. */
async function someoneWaits(): Promise<void> {
  for (let tries = 0; tries < 500; tries++) {
    const rows = await hub.database.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await Bun.sleep(10);
  }
  throw new Error("nothing waited on a lock");
}

test("a checkout that meets a move before its commit waits for it, and the old runner is refused", async () => {
  const task = await jobTask(ben, ann, "j-racing");
  let answer: Promise<Reply> | undefined;
  await hub.database.transaction(async (tx) => {
    // `PUT /jobs/j-racing {owner: dan}` up to its commit, step by step as `jobs.ts` takes them.
    await tx
      .select()
      .from(hubJobs)
      .where(eq(hubJobs.id, "j-racing"))
      .for("update");
    await tx
      .update(hubJobs)
      .set({ owner: danId, runner: danId })
      .where(eq(hubJobs.id, "j-racing"));
    await emitEvent(tx, {
      type: "job.changed",
      refId: "j-racing",
      actor: benId,
    });
    await noteJobMove(tx, "j-racing", benId, danId);
    await freeMovedJobClaims(tx, "j-racing", benId, benId);
    // Ben's VM has not heard of the move yet and asks for the task now.
    answer = checkout(ben.pass, task.id, "run-racing");
    await someoneWaits();
  });
  const refused = await answer;
  expect(refused?.status).toBe(409);
  expect(refused?.body.code).toBe("laf:task_taken");
  expect((await checkout(dan.pass, task.id, "run-new-runner")).status).toBe(
    200,
  );
});
