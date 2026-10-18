import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type {
  HubSync,
  HubTask,
  HubTaskDetail,
  HubTaskList,
} from "../../shared/hub/protocol";
import { createLogger, type LogLevel } from "../../shared/log";
import type { HubDatabase } from "../src/db/client";
import { createListeners } from "../src/events";
import { startTaskSweeper, sweepExpiredTasks } from "../src/task-sweeper";
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
let benId = "";
let choId = "";

beforeAll(async () => {
  hub = await startTestHub();
  annId = (await putMember(hub, ann)).id;
  benId = (await putMember(hub, ben)).id;
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
  const init = asMember(pass, { "content-type": "application/json" });
  const response = await fetch(`${hub.url}/hub/v1${path}`, {
    ...init,
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function newTask(
  pass: string,
  body: Record<string, unknown> = {},
): Promise<HubTask> {
  const reply = await call(pass, "POST", "/tasks", {
    title: "A task",
    visibility: "company",
    ...body,
  });
  expect(reply.status).toBe(200);
  return reply.body.task as HubTask;
}

const checkout = (pass: string, id: string, runId: string) =>
  call(pass, "POST", `/tasks/${id}/checkout`, { runId });

async function row(id: string) {
  const rows = await hub.database.execute<{
    stage: string;
    checkout_run_id: string | null;
    checkout_by: string | null;
    version: number;
    expired: boolean | null;
  }>(
    sql`select stage, checkout_run_id, checkout_by, version, lock_expires_at < now() as expired from hub_tasks where id = ${id}`,
  );
  const found = rows[0];
  if (!found) throw new Error(`no task ${id}`);
  return found;
}

/** Puts a claim's end in the past, as a VM that stopped beating five minutes ago leaves it. */
const expire = (id: string) =>
  hub.database.execute(
    sql`update hub_tasks set lock_expires_at = now() - interval '1 second' where id = ${id}`,
  );

async function sync(pass: string, since: number): Promise<HubSync> {
  const response = await fetch(
    `${hub.url}/hub/v1/sync?since=${since}`,
    asMember(pass),
  );
  return (await response.json()) as HubSync;
}

async function headSeq(): Promise<number> {
  const rows = await hub.database.execute<{ head: string | null }>(
    sql`select max(seq)::text as head from hub_events`,
  );
  return Number(rows[0]?.head ?? 0);
}

describe("checkout", () => {
  test("of runs asking at once, exactly one takes the task and the rest are told it is taken", async () => {
    const task = await newTask(ann.pass);
    const runs = Array.from({ length: 12 }, (_, index) => ({
      pass: index % 2 === 0 ? ann.pass : ben.pass,
      runId: `run-race-${index}`,
    }));
    const replies = await Promise.all(
      runs.map((run) => checkout(run.pass, task.id, run.runId)),
    );
    const winners = replies.filter((reply) => reply.status === 200);
    const losers = replies.filter((reply) => reply.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(11);
    for (const loser of losers) {
      expect(loser.body).toEqual({ ok: false, code: "laf:task_taken" });
    }
    const won = (winners[0]?.body.task as HubTask | undefined)?.checkout;
    const stored = await row(task.id);
    expect(stored.stage).toBe("doing");
    expect(stored.checkout_run_id).toBe(won?.runId ?? "none");
    // One version for the one claim, not one per attempt.
    expect(stored.version).toBe(task.version + 1);
  });

  test("a task assigned to somebody is theirs to take; another member's run is refused", async () => {
    const task = await newTask(ann.pass, { assignee: `bot:${benId}` });
    expect((await checkout(ann.pass, task.id, "run-not-mine")).status).toBe(
      409,
    );
    const mine = await checkout(ben.pass, task.id, "run-bens");
    expect(mine.status).toBe(200);
    expect((mine.body.task as HubTask).checkout?.by).toBe(benId);
  });

  test("the same run asking again is told it holds the task; a task already in review is not taken", async () => {
    const task = await newTask(ann.pass);
    expect((await checkout(ann.pass, task.id, "run-again")).status).toBe(200);
    const again = await checkout(ann.pass, task.id, "run-again");
    expect(again.status).toBe(200);
    expect((again.body.task as HubTask).version).toBe(task.version + 1);
    await call(ann.pass, "PATCH", `/tasks/${task.id}`, {
      as: "bot",
      runId: "run-again",
      stage: "review",
    });
    expect((await checkout(ben.pass, task.id, "run-late")).body.code).toBe(
      "laf:task_taken",
    );
  });

  test("a claim whose time ran out is taken over by the next run without waiting for the sweep", async () => {
    const task = await newTask(ann.pass);
    expect((await checkout(ann.pass, task.id, "run-dead")).status).toBe(200);
    expect((await checkout(ben.pass, task.id, "run-early")).status).toBe(409);
    await expire(task.id);
    const taken = await checkout(ben.pass, task.id, "run-alive");
    expect(taken.status).toBe(200);
    expect((await row(task.id)).checkout_run_id).toBe("run-alive");
  });

  test("a 라피's or a job's task is put in doing only by its run's checkout, never by a person's hand", async () => {
    const made = await call(ann.pass, "POST", "/tasks", {
      title: "By hand",
      visibility: "company",
      stage: "doing",
      assignee: `bot:${benId}`,
    });
    expect(made.status).toBe(400);
    expect(made.body.field).toBe("stage");
    const job = await call(ann.pass, "POST", "/tasks", {
      title: "A job's",
      visibility: "company",
      stage: "doing",
      assignee: "job:nightly",
    });
    expect(job.body.field).toBe("stage");

    const task = await newTask(ann.pass, { assignee: `bot:${benId}` });
    const moved = await call(ann.pass, "PATCH", `/tasks/${task.id}`, {
      version: task.version,
      stage: "doing",
    });
    expect(moved.status).toBe(400);
    expect(moved.body.field).toBe("stage");
    expect((await row(task.id)).stage).toBe("todo");

    // A person's own task in doing is that person at work, and giving it to a 라피 as it stands
    // would leave it where no run takes it.
    const own = await newTask(ann.pass, {
      stage: "doing",
      assignee: `m:${annId}`,
    });
    expect(own.stage).toBe("doing");
    const handed = await call(ann.pass, "PATCH", `/tasks/${own.id}`, {
      version: own.version,
      assignee: `bot:${annId}`,
    });
    expect(handed.status).toBe(400);
    expect(handed.body.field).toBe("stage");

    // The way in that is left: its run takes it.
    const taken = await checkout(ben.pass, task.id, "run-by-checkout");
    expect(taken.status).toBe(200);
    expect((taken.body.task as HubTask).stage).toBe("doing");
  });

  test("a checkout with no run id is refused before anything is written", async () => {
    const task = await newTask(ann.pass);
    const reply = await call(
      ann.pass,
      "POST",
      `/tasks/${task.id}/checkout`,
      {},
    );
    expect(reply.status).toBe(400);
    expect(reply.body.field).toBe("runId");
    expect((await row(task.id)).stage).toBe("todo");
  });
});

describe("heartbeat and release", () => {
  test("a beat from the holding run moves the end of the claim; one from another run is not_held", async () => {
    const task = await newTask(ann.pass);
    await checkout(ann.pass, task.id, "run-beat");
    await expire(task.id);
    const beat = await call(ann.pass, "POST", `/tasks/${task.id}/heartbeat`, {
      runId: "run-beat",
    });
    expect(beat.status).toBe(200);
    expect(Date.parse(String(beat.body.until))).toBeGreaterThan(
      Date.now() + 4 * 60 * 1000,
    );
    expect((await row(task.id)).expired).toBe(false);
    const other = await call(ben.pass, "POST", `/tasks/${task.id}/heartbeat`, {
      runId: "run-beat",
    });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe("laf:task_not_held");
  });

  test("release by another run, or by the same run id from another member, is refused; the holder's puts it back", async () => {
    const task = await newTask(ann.pass);
    await checkout(ann.pass, task.id, "run-holder");
    const wrongRun = await call(ann.pass, "POST", `/tasks/${task.id}/release`, {
      runId: "run-other",
    });
    expect(wrongRun.status).toBe(409);
    expect(wrongRun.body.code).toBe("laf:task_not_held");
    const wrongMember = await call(
      ben.pass,
      "POST",
      `/tasks/${task.id}/release`,
      { runId: "run-holder" },
    );
    expect(wrongMember.status).toBe(409);
    expect((await row(task.id)).checkout_run_id).toBe("run-holder");
    const released = await call(ann.pass, "POST", `/tasks/${task.id}/release`, {
      runId: "run-holder",
    });
    expect(released.status).toBe(200);
    const stored = await row(task.id);
    expect(stored.stage).toBe("todo");
    expect(stored.checkout_run_id).toBeNull();
    const trail = await hub.database.execute<{ outcome: string }>(
      sql`select outcome from hub_audit where action = 'task.released' and target = ${task.id} order by id`,
    );
    expect(trail.map((entry) => entry.outcome)).toEqual([
      "laf:task_not_held",
      "laf:task_not_held",
      "ok",
    ]);
  });

  test("a holder who has lost sight of the task cannot release it and is shown nothing of it", async () => {
    const task = await newTask(ann.pass, { title: "Kept to the maker" });
    const claimed = await checkout(ben.pass, task.id, "run-blind");
    expect(claimed.status).toBe(200);
    const narrowed = await call(ann.pass, "PATCH", `/tasks/${task.id}`, {
      version: (claimed.body.task as HubTask).version,
      visibility: "me",
    });
    expect(narrowed.status).toBe(200);
    const released = await call(ben.pass, "POST", `/tasks/${task.id}/release`, {
      runId: "run-blind",
    });
    expect(released.status).toBe(409);
    expect(released.body.code).toBe("laf:task_not_held");
    expect(JSON.stringify(released.body)).not.toContain("Kept to the maker");
    // Left as it was: the claim runs out and the sweep frees it, as with a beat it can no longer
    // send.
    expect((await row(task.id)).checkout_run_id).toBe("run-blind");
  });

  test("a person moving a task out of doing takes it from its run, whose next beat is not_held", async () => {
    const task = await newTask(ann.pass);
    const claimed = await checkout(ann.pass, task.id, "run-moved");
    const version = (claimed.body.task as HubTask).version;
    const moved = await call(ben.pass, "PATCH", `/tasks/${task.id}`, {
      version,
      stage: "todo",
    });
    expect(moved.status).toBe(200);
    expect((moved.body.task as HubTask).checkout).toBeNull();
    const beat = await call(ann.pass, "POST", `/tasks/${task.id}/heartbeat`, {
      runId: "run-moved",
    });
    expect(beat.body.code).toBe("laf:task_not_held");
  });
});

describe("the sweep", () => {
  test("frees a claim that ran out, puts the task back in todo, says so to its viewers, and leaves a live claim alone", async () => {
    const dead = await newTask(ann.pass, { visibility: "me" });
    const alive = await newTask(ann.pass);
    await checkout(ann.pass, dead.id, "run-swept");
    await checkout(ann.pass, alive.id, "run-alive-claim");
    await expire(dead.id);
    const before = await headSeq();
    expect(await sweepExpiredTasks(hub.database)).toBeGreaterThanOrEqual(1);
    const stored = await row(dead.id);
    expect(stored.stage).toBe("todo");
    expect(stored.checkout_run_id).toBeNull();
    expect((await row(alive.id)).checkout_run_id).toBe("run-alive-claim");
    const events = await hub.database.execute<{
      ref_id: string;
      visible_to: string[] | null;
    }>(
      sql`select ref_id, visible_to from hub_events where seq > ${before} and type = 'task.changed' and ref_id = ${dead.id}`,
    );
    expect([...events]).toEqual([{ ref_id: dead.id, visible_to: [annId] }]);
    const trail = await hub.database.execute<{
      run_id: string;
      member: string;
    }>(
      sql`select run_id, member from hub_audit where action = 'task.lock_expired' and target = ${dead.id}`,
    );
    expect([...trail]).toEqual([{ run_id: "run-swept", member: annId }]);
    expect((await checkout(ben.pass, alive.id, "run-thief")).status).toBe(409);
    const own = await newTask(ben.pass, { visibility: "me" });
    await checkout(ben.pass, own.id, "run-b1");
    await expire(own.id);
    await sweepExpiredTasks(hub.database);
    expect((await checkout(ben.pass, own.id, "run-b2")).status).toBe(200);
  });

  test("the timer sweeps on its own, and a sweep that fails is a warning, not an exit", async () => {
    const task = await newTask(ann.pass);
    await checkout(ann.pass, task.id, "run-timer");
    await expire(task.id);
    const lines: { level: LogLevel; line: string }[] = [];
    const log = createLogger("hub", (level, line) =>
      lines.push({ level, line }),
    );
    const listeners = createListeners();
    let poked = 0;
    listeners.add({
      member: annId,
      passHash: "x",
      poke: () => {
        poked += 1;
      },
      close: () => {},
      expireAt: () => {},
    });
    const sweeper = startTaskSweeper({
      database: hub.database,
      listeners,
      log,
      everyMs: 10,
    });
    try {
      for (let tries = 0; tries < 200; tries += 1) {
        if ((await row(task.id)).stage === "todo") break;
        await Bun.sleep(10);
      }
    } finally {
      sweeper.stop();
    }
    expect((await row(task.id)).stage).toBe("todo");
    expect(poked).toBeGreaterThanOrEqual(1);

    const broken = {
      transaction: () => Promise.reject(new Error("database gone")),
    } as unknown as HubDatabase;
    const failing = startTaskSweeper({
      database: broken,
      listeners,
      log,
      everyMs: 60_000,
    });
    await failing.sweep();
    failing.stop();
    expect(
      lines.some((entry) => entry.line.includes("task_sweep_failed")),
    ).toBe(true);
  });
});

describe("what a 라피 may write", () => {
  test("a 라피 cannot set done, on a task it holds or a new one, and the task is left as it was", async () => {
    const task = await newTask(ann.pass);
    await checkout(ann.pass, task.id, "run-done");
    const refused = await call(ann.pass, "PATCH", `/tasks/${task.id}`, {
      as: "bot",
      runId: "run-done",
      stage: "done",
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("laf:task_done_by_person");
    expect((await row(task.id)).stage).toBe("doing");
    const created = await call(ann.pass, "POST", "/tasks", {
      title: "Finished already",
      as: "bot",
      stage: "done",
    });
    expect(created.status).toBe(403);
    expect(created.body.code).toBe("laf:task_done_by_person");
    // A person sets it.
    const version = (await row(task.id)).version;
    const done = await call(ann.pass, "PATCH", `/tasks/${task.id}`, {
      version,
      stage: "done",
    });
    expect(done.status).toBe(200);
    expect((done.body.task as HubTask).doneAt).not.toBeNull();
  });

  test("a 라피 moves the task its run holds to blocked with one line, and the claim ends with the move", async () => {
    const task = await newTask(ann.pass);
    await checkout(ann.pass, task.id, "run-blocked");
    const notMine = await call(ann.pass, "PATCH", `/tasks/${task.id}`, {
      as: "bot",
      runId: "run-other",
      stage: "blocked",
    });
    expect(notMine.body.code).toBe("laf:task_not_held");
    const twoLines = await call(ann.pass, "PATCH", `/tasks/${task.id}`, {
      as: "bot",
      runId: "run-blocked",
      stage: "blocked",
      note: "first\nsecond",
    });
    expect(twoLines.body.field).toBe("note");
    const blocked = await call(ann.pass, "PATCH", `/tasks/${task.id}`, {
      as: "bot",
      runId: "run-blocked",
      stage: "blocked",
      note: "sign-in needed",
    });
    expect(blocked.status).toBe(200);
    expect((blocked.body.task as HubTask).checkout).toBeNull();
    const detail = (await call(ann.pass, "GET", `/tasks/${task.id}`))
      .body as unknown as HubTaskDetail;
    expect(detail.task.stage).toBe("blocked");
    expect(
      detail.notes.map((note) => [note.by, note.text, note.runId]),
    ).toEqual([[`bot:${annId}`, "sign-in needed", "run-blocked"]]);
  });
});

describe("a person's edit", () => {
  test("made against an older version is laf:task_stale and changes nothing; the current one goes through", async () => {
    const task = await newTask(ann.pass, { title: "Before" });
    await checkout(ben.pass, task.id, "run-in-between");
    const stale = await call(ann.pass, "PATCH", `/tasks/${task.id}`, {
      version: task.version,
      title: "After",
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({
      ok: false,
      code: "laf:task_stale",
      version: task.version + 1,
    });
    const unchanged = (await call(ann.pass, "GET", `/tasks/${task.id}`))
      .body as unknown as HubTaskDetail;
    expect(unchanged.task.title).toBe("Before");
    const fresh = await call(ann.pass, "PATCH", `/tasks/${task.id}`, {
      version: task.version + 1,
      title: "After",
    });
    expect(fresh.status).toBe(200);
    expect((fresh.body.task as HubTask).title).toBe("After");
    expect((fresh.body.task as HubTask).version).toBe(task.version + 2);
  });

  test("with no version is refused", async () => {
    const task = await newTask(ann.pass);
    const reply = await call(ann.pass, "PATCH", `/tasks/${task.id}`, {
      title: "No version",
    });
    expect(reply.status).toBe(400);
    expect(reply.body.field).toBe("version");
  });
});

describe("visibility", () => {
  test("a task kept to its maker is not listed, read, noted or taken by anybody else", async () => {
    const mine = await newTask(ann.pass, { visibility: "me" });
    const shared = await newTask(ann.pass, { visibility: "company" });
    const benList = (await call(ben.pass, "GET", "/tasks?limit=200"))
      .body as unknown as HubTaskList;
    const benIds = benList.tasks.map((task) => task.id);
    expect(benIds).toContain(shared.id);
    expect(benIds).not.toContain(mine.id);
    const annList = (await call(ann.pass, "GET", "/tasks?limit=200"))
      .body as unknown as HubTaskList;
    expect(annList.tasks.map((task) => task.id)).toContain(mine.id);
    expect((await call(ben.pass, "GET", `/tasks/${mine.id}`)).status).toBe(404);
    const claim = await checkout(ben.pass, mine.id, "run-peek");
    expect(claim.status).toBe(404);
    expect(claim.body.code).toBe("laf:hub_not_found");
    expect(
      (
        await call(ben.pass, "POST", `/tasks/${mine.id}/notes`, {
          text: "hello",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(ben.pass, "PATCH", `/tasks/${mine.id}`, {
          version: mine.version,
          title: "Taken over",
        })
      ).status,
    ).toBe(404);
    expect((await row(mine.id)).stage).toBe("todo");
  });

  test("a members task is seen by its members and its maker; events about it reach only them", async () => {
    const since = await headSeq();
    const task = await newTask(ann.pass, {
      visibility: "members",
      members: [benId],
    });
    expect(task.visibility).toBe(`task:${task.id}`);
    expect(task.members.sort()).toEqual([annId, benId].sort());
    expect((await call(ben.pass, "GET", `/tasks/${task.id}`)).status).toBe(200);
    expect((await call(cho.pass, "GET", `/tasks/${task.id}`)).status).toBe(404);
    const benEvents = (await sync(ben.pass, since)).events.filter(
      (event) => event.refId === task.id,
    );
    const choEvents = (await sync(cho.pass, since)).events.filter(
      (event) => event.refId === task.id,
    );
    expect(benEvents.map((event) => event.type)).toEqual(["task.changed"]);
    expect(choEvents).toEqual([]);
  });

  test("narrowing a task tells those who lose sight of it, and only its maker or an admin may narrow it", async () => {
    const task = await newTask(ann.pass, { visibility: "company" });
    const byOther = await call(ben.pass, "PATCH", `/tasks/${task.id}`, {
      version: task.version,
      visibility: "me",
    });
    expect(byOther.status).toBe(403);
    const since = await headSeq();
    const narrowed = await call(cho.pass, "PATCH", `/tasks/${task.id}`, {
      version: task.version,
      visibility: "me",
    });
    expect(narrowed.status).toBe(200);
    // The maker keeps it, not the admin who narrowed it.
    expect((narrowed.body.task as HubTask).visibility).toBe(`me:${annId}`);
    const benEvents = (await sync(ben.pass, since)).events.filter(
      (event) => event.refId === task.id,
    );
    expect(benEvents.map((event) => event.type)).toEqual(["task.changed"]);
    expect((await call(ben.pass, "GET", `/tasks/${task.id}`)).status).toBe(404);
  });

  test("task.assigned reaches the assigned member alone, and a task kept to its maker cannot be given to another", async () => {
    const since = await headSeq();
    const task = await newTask(ann.pass, {
      visibility: "company",
      assignee: `bot:${benId}`,
    });
    const assigned = async (pass: string) =>
      (await sync(pass, since)).events.filter(
        (event) => event.refId === task.id && event.type === "task.assigned",
      );
    expect(await assigned(ben.pass)).toHaveLength(1);
    expect(await assigned(ann.pass)).toHaveLength(0);
    expect(await assigned(cho.pass)).toHaveLength(0);
    const hidden = await call(ann.pass, "POST", "/tasks", {
      title: "Private",
      visibility: "me",
      assignee: `m:${benId}`,
    });
    expect(hidden.status).toBe(400);
    expect(hidden.body.field).toBe("assignee");
  });
});

describe("who is on a task", () => {
  test("on a members task, only its maker or an admin may give it to somebody not on it", async () => {
    const task = await newTask(ann.pass, {
      visibility: "members",
      members: [benId],
    });
    const byViewer = await call(ben.pass, "PATCH", `/tasks/${task.id}`, {
      version: task.version,
      assignee: `m:${choId}`,
    });
    expect(byViewer.status).toBe(403);
    expect((await call(cho.pass, "GET", `/tasks/${task.id}`)).status).toBe(404);
    // Somebody already on it may be given it by anybody who sees it.
    const toBen = await call(ben.pass, "PATCH", `/tasks/${task.id}`, {
      version: task.version,
      assignee: `bot:${benId}`,
    });
    expect(toBen.status).toBe(200);
    const byMaker = await call(ann.pass, "PATCH", `/tasks/${task.id}`, {
      version: (toBen.body.task as HubTask).version,
      assignee: `m:${choId}`,
    });
    expect(byMaker.status).toBe(200);
    expect((byMaker.body.task as HubTask).members.sort()).toEqual(
      [annId, benId, choId].sort(),
    );
    expect((await call(cho.pass, "GET", `/tasks/${task.id}`)).status).toBe(200);
  });

  test("leaving the company takes them off every task; an edit does not put them back, nor does coming back", async () => {
    const dee = {
      email: "dee@example.com",
      vmOrigin: "https://dee.example",
      pass: newPass(),
    };
    const deeId = (await putMember(hub, dee)).id;
    // One she made, and one she is given: an edit re-adds a maker and an assignee.
    const hers = await newTask(dee.pass, {
      visibility: "members",
      members: [annId],
    });
    const given = await newTask(ann.pass, {
      visibility: "members",
      assignee: `m:${deeId}`,
    });
    expect(given.members.sort()).toEqual([annId, deeId].sort());

    const since = await headSeq();
    await putMember(hub, { ...dee, state: "left" });
    for (const task of [hers, given]) {
      const read = await call(ann.pass, "GET", `/tasks/${task.id}`);
      expect((read.body.task as HubTask).members).toEqual([annId]);
      const edited = await call(ann.pass, "PATCH", `/tasks/${task.id}`, {
        version: (read.body.task as HubTask).version,
        title: "Edited after she left",
      });
      expect(edited.status).toBe(200);
      expect((edited.body.task as HubTask).members).toEqual([annId]);
    }
    // Those still on them hear it, so their boards redraw the members.
    const heard = (await sync(ann.pass, since)).events
      .filter((event) => event.type === "task.changed")
      .map((event) => event.refId);
    expect(heard).toContain(hers.id);
    expect(heard).toContain(given.id);

    const back = { ...dee, pass: newPass() };
    expect((await putMember(hub, back)).id).toBe(deeId);
    for (const task of [hers, given]) {
      expect((await call(back.pass, "GET", `/tasks/${task.id}`)).status).toBe(
        404,
      );
    }
    const listed = (await call(back.pass, "GET", "/tasks")).body as HubTaskList;
    expect(listed.tasks.map((task) => task.id)).not.toContain(hers.id);
  });
});

describe("the list and the trail", () => {
  test("pages newest first by cursor, and filters by stage", async () => {
    const made: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      made.push((await newTask(cho.pass, { visibility: "me" })).id);
    }
    const first = (await call(cho.pass, "GET", "/tasks?limit=2"))
      .body as unknown as HubTaskList;
    expect(first.tasks.map((task) => task.id)).toEqual([made[2], made[1]]);
    expect(first.next).not.toBeNull();
    const second = (
      await call(cho.pass, "GET", `/tasks?limit=2&cursor=${first.next}`)
    ).body as unknown as HubTaskList;
    expect(second.tasks.map((task) => task.id)).toContain(made[0]);
    const doing = (await call(cho.pass, "GET", "/tasks?stage=doing"))
      .body as unknown as HubTaskList;
    expect(doing.tasks.every((task) => task.stage === "doing")).toBe(true);
    expect((await call(cho.pass, "GET", "/tasks?stage=finished")).status).toBe(
      400,
    );
  });

  test("the trail names who did what to which task and never holds its words", async () => {
    const secretish = "Quarterly figures for the lender";
    const task = await newTask(ann.pass, {
      title: secretish,
      description: secretish,
    });
    await call(ann.pass, "POST", `/tasks/${task.id}/notes`, {
      text: secretish,
    });
    const rows = await hub.database.execute<Record<string, unknown>>(
      sql`select * from hub_audit where target = ${task.id}`,
    );
    expect(rows.map((entry) => entry.action).sort()).toEqual([
      "task.created",
      "task.noted",
    ]);
    expect(JSON.stringify(rows)).not.toContain("Quarterly");
  });
});
