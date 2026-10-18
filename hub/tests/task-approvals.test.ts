import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type {
  HubSync,
  HubTask,
  HubTaskApproval,
  HubTaskDetail,
} from "../../shared/hub/protocol";
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
let annId = "";
let choId = "";

beforeAll(async () => {
  hub = await startTestHub();
  annId = (await putMember(hub, ann)).id;
  await putMember(hub, ben);
  choId = (await putMember(hub, cho)).id;
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

const TOPIC = "browser/activate@shop.example.test";

/** A company task Ann's 라피 took and stopped on, as #260's pickup leaves one. */
async function blockedByAnnsRun(): Promise<HubTask> {
  const made = await call(ann.pass, "POST", "/tasks", {
    title: "Order the paper",
    visibility: "company",
  });
  const task = made.body.task as HubTask;
  const runId = `run-${task.id}`;
  expect(
    (await call(ann.pass, "POST", `/tasks/${task.id}/checkout`, { runId }))
      .status,
  ).toBe(200);
  const blocked = await call(ann.pass, "PATCH", `/tasks/${task.id}`, {
    as: "bot",
    runId,
    stage: "blocked",
    note: `laf:task_needs_approval run:${runId} topic:${TOPIC}`,
  });
  expect(blocked.status).toBe(200);
  return blocked.body.task as HubTask;
}

const approve = (pass: string, id: string, body: Record<string, unknown>) =>
  call(pass, "POST", `/tasks/${id}/approvals`, body);

async function headSeq(): Promise<number> {
  const rows = await hub.database.execute<{ head: string | null }>(
    sql`select max(seq)::text as head from hub_events`,
  );
  return Number(rows[0]?.head ?? 0);
}

async function seen(pass: string, since: number) {
  const reply = await call(pass, "GET", `/sync?since=${since}`);
  return (reply.body as unknown as HubSync).events;
}

test("the member whose run stopped says yes: back to todo, the topic noted, task.approval_granted named", async () => {
  const task = await blockedByAnnsRun();
  const before = await headSeq();
  const yes = await approve(ann.pass, task.id, {
    topic: TOPIC,
    version: task.version,
  });
  expect(yes.status).toBe(200);
  const approval = yes.body.approval as HubTaskApproval;
  expect(Object.keys(approval).sort()).toEqual(["at", "by", "taskId", "topic"]);
  expect(approval).toMatchObject({ taskId: task.id, by: annId, topic: TOPIC });

  // Everybody who can see the task hears both, the board's line first.
  for (const pass of [ann.pass, ben.pass]) {
    const events = await seen(pass, before);
    expect(
      events.map((event) => [event.type, event.refId, event.actor]),
    ).toEqual([
      ["task.changed", task.id, annId],
      ["task.approval_granted", task.id, annId],
    ]);
    expect(events[1]?.at).toBe(approval.at);
  }

  const detail = (await call(ben.pass, "GET", `/tasks/${task.id}`))
    .body as unknown as HubTaskDetail;
  expect(detail.task.stage).toBe("todo");
  expect(detail.notes.at(-1)).toMatchObject({
    by: `m:${annId}`,
    text: `laf:task_approval_granted topic:${TOPIC}`,
  });

  // The trail: ids and the outcome, not the topic.
  const trail = await hub.database.execute<{ payload: unknown }>(
    sql`select payload from hub_audit where action = 'task.approval_granted' and target = ${task.id} and outcome = 'ok'`,
  );
  expect(trail.length).toBe(1);
  expect(JSON.stringify(trail)).not.toContain("shop.example.test");
});

test("only the member whose run stopped may say yes: another member and an admin are refused, and nothing moves", async () => {
  const task = await blockedByAnnsRun();
  const before = await headSeq();
  for (const pass of [ben.pass, cho.pass]) {
    const refused = await approve(pass, task.id, { topic: TOPIC });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("laf:task_not_yours");
  }
  const still = (await call(ann.pass, "GET", `/tasks/${task.id}`))
    .body as unknown as HubTaskDetail;
  expect(still.task.stage).toBe("blocked");
  expect(still.task.version).toBe(task.version);
  expect(await seen(ann.pass, before)).toEqual([]);
  const refusals = await hub.database.execute<{ member: string }>(
    sql`select member from hub_audit where action = 'task.approval_granted' and target = ${task.id} and outcome = 'laf:task_not_yours'`,
  );
  expect(refusals.map((row) => row.member)).toContain(choId);
  const yes = await approve(ann.pass, task.id, { topic: TOPIC });
  expect(yes.status).toBe(200);
  expect((yes.body.approval as HubTaskApproval).by).toBe(annId);
});

test("a task a person moved is no longer waiting on that run's yes", async () => {
  const task = await blockedByAnnsRun();
  // Ben puts it back to todo and then blocks it himself: no run's stop waits any more.
  const back = await call(ben.pass, "PATCH", `/tasks/${task.id}`, {
    version: task.version,
    stage: "todo",
  });
  const notWaiting = await approve(ann.pass, task.id, { topic: TOPIC });
  expect(notWaiting.status).toBe(409);
  expect(notWaiting.body.code).toBe("laf:task_not_blocked");
  await call(ben.pass, "PATCH", `/tasks/${task.id}`, {
    version: (back.body.task as HubTask).version,
    stage: "blocked",
  });
  expect((await approve(ann.pass, task.id, { topic: TOPIC })).status).toBe(403);
});

test("an older version is stale, and a topic that is not a topic is refused", async () => {
  const task = await blockedByAnnsRun();
  const stale = await approve(ann.pass, task.id, {
    topic: TOPIC,
    version: task.version - 1,
  });
  expect(stale.status).toBe(409);
  expect(stale.body.code).toBe("laf:task_stale");
  for (const topic of ["", "a value with spaces", 42, "x".repeat(201)]) {
    const bad = await approve(ann.pass, task.id, { topic });
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe("topic");
  }
  const extra = await approve(ann.pass, task.id, {
    topic: TOPIC,
    value: "typed",
  });
  expect(extra.body.field).toBe("value");
  expect((await approve(ann.pass, task.id, { topic: TOPIC })).status).toBe(200);
});
