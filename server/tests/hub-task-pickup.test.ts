import { describe, expect, test } from "bun:test";
import {
  createTaskPickup,
  hearFrame,
  type TaskRun,
  type TaskRunOutcome,
  taskReport,
} from "../src/hub/task-pickup";
import { fakeTaskHub, LOCK_MS } from "./support/fake-task-hub";

/**
 * A task on the company board given to this member's 라피: taken once, worked, handed back to
 * `review` or `blocked` with one line naming the run — never `done` — and let go of.
 *
 * Against an in-memory board keeping the hub's claim rules (`support/fake-task-hub.ts`) and a run
 * that is a script, so what is checked is the pickup: who takes what, how often, and what the board
 * is told.
 */

const ME = "m_me";

/** A run that answers with `outcome`, counting the times it was started. */
function scripted(outcome: TaskRunOutcome) {
  const started: string[] = [];
  const run: TaskRun = async ({ task, runId }) => {
    started.push(`${task.id}:${runId}`);
    return outcome;
  };
  return { run, started };
}

let ids = 0;
const runIds = () => {
  ids += 1;
  return `run-${ids}`;
};

describe("a task given to this member's 라피", () => {
  test("is taken, run once, moved to review with a note naming the run, and let go of", async () => {
    const hub = fakeTaskHub();
    hub.add({ id: "t_1", assignee: `bot:${ME}` });
    const { run, started } = scripted({ kind: "done", steps: 2 });
    const pickup = createTaskPickup({
      http: hub.as(ME),
      memberId: () => ME,
      run,
      newRunId: () => "run-a",
    });

    pickup.heard({ type: "task.assigned", refId: "t_1" });
    await pickup.idle();

    expect(started).toEqual(["t_1:run-a"]);
    const task = hub.tasks.get("t_1");
    expect(task?.stage).toBe("review");
    expect(task?.checkout).toBeNull();
    expect(task?.notes).toEqual([
      {
        by: `bot:${ME}`,
        text: "laf:task_ran run:run-a steps:2",
        runId: "run-a",
      },
    ]);
    // The claim, the move, the release that finds the move already ended it, and the look after.
    expect(
      hub.requests.map(
        (request) => `${request.method ?? "GET"} ${request.path}`,
      ),
    ).toEqual([
      "GET /tasks/t_1",
      "POST /tasks/t_1/checkout",
      "PATCH /tasks/t_1",
      "POST /tasks/t_1/release",
      "GET /tasks/t_1",
    ]);
  });

  test("an action that needed a yes is blocked, with the topic and nothing of the call", async () => {
    const hub = fakeTaskHub();
    hub.add({ id: "t_2", assignee: `bot:${ME}` });
    const { run } = scripted({
      kind: "approval",
      topic: "browser/click@shop.example.com",
      steps: 3,
    });
    const pickup = createTaskPickup({
      http: hub.as(ME),
      memberId: () => ME,
      run,
      newRunId: () => "run-b",
    });

    pickup.heard({ type: "task.assigned", refId: "t_2" });
    await pickup.idle();

    expect(hub.tasks.get("t_2")?.stage).toBe("blocked");
    expect(hub.tasks.get("t_2")?.notes.map((note) => note.text)).toEqual([
      "laf:task_needs_approval run:run-b topic:browser/click@shop.example.com",
    ]);
  });

  test("a task given to somebody else's 라피 is not taken", async () => {
    const hub = fakeTaskHub();
    hub.add({ id: "t_3", assignee: "bot:m_other" });
    hub.add({ id: "t_4", assignee: `bot:${ME}` });
    const { run, started } = scripted({ kind: "done", steps: 1 });
    const pickup = createTaskPickup({
      http: hub.as(ME),
      memberId: () => ME,
      run,
      newRunId: runIds,
    });

    await pickup.scan();

    expect(started.map((one) => one.split(":")[0])).toEqual(["t_4"]);
    expect(hub.tasks.get("t_3")?.stage).toBe("todo");
    expect(
      hub.requests.some((request) => request.path === "/tasks/t_3/checkout"),
    ).toBe(false);
  });

  test("two VMs racing for one task: one runs it, the other is told it is taken and does not ask again", async () => {
    const hub = fakeTaskHub();
    hub.add({ id: "t_5", assignee: `bot:${ME}` });
    const first = scripted({ kind: "done", steps: 1 });
    const second = scripted({ kind: "done", steps: 1 });
    const a = createTaskPickup({
      http: hub.as(ME),
      memberId: () => ME,
      run: first.run,
      newRunId: () => "run-vm-a",
    });
    const b = createTaskPickup({
      http: hub.as(ME),
      memberId: () => ME,
      run: second.run,
      newRunId: () => "run-vm-b",
    });

    // Both hear the event, and both read the board, at once.
    a.heard({ type: "task.assigned", refId: "t_5" });
    b.heard({ type: "task.assigned", refId: "t_5" });
    await Promise.all([a.scan(), b.scan(), a.idle(), b.idle()]);

    expect([...first.started, ...second.started]).toHaveLength(1);
    const checkouts = hub.requests.filter((request) =>
      request.path.endsWith("/checkout"),
    );
    // Each VM asked once at most; whoever lost was told so and stopped.
    expect(checkouts.length).toBeLessThanOrEqual(2);
    expect(hub.tasks.get("t_5")?.stage).toBe("review");
    expect(hub.tasks.get("t_5")?.notes).toHaveLength(1);
  });

  test("a crash mid-run: the sweep frees the task, and the next boot runs it once — not again for the event replayed beside the board", async () => {
    const hub = fakeTaskHub();
    hub.add({ id: "t_6", assignee: `bot:${ME}` });
    // The first process takes the task and dies in the middle of its run: its run never returns
    // and nothing it would have done afterwards happens.
    let crashed: () => void = () => {};
    const dying = createTaskPickup({
      http: hub.as(ME),
      memberId: () => ME,
      run: ({ runId }) =>
        new Promise<TaskRunOutcome>(() => {
          crashed();
          void runId;
        }),
      newRunId: () => "run-dead",
      heartbeatMs: 60 * 60 * 1000,
    });
    const taken = new Promise<void>((resolve) => {
      crashed = resolve;
    });
    dying.heard({ type: "task.assigned", refId: "t_6" });
    await taken;
    expect(hub.tasks.get("t_6")?.stage).toBe("doing");

    // No beats come from a dead process. The claim runs out, and the hub's sweep frees it.
    hub.advance(LOCK_MS + 1);
    expect(hub.sweep()).toEqual(["t_6"]);
    expect(hub.tasks.get("t_6")?.stage).toBe("todo");

    // The next boot: the board read, and the event the old cursor had not passed, together.
    const next = scripted({ kind: "done", steps: 4 });
    const booted = createTaskPickup({
      http: hub.as(ME),
      memberId: () => ME,
      run: next.run,
      newRunId: runIds,
      // The dead run never settled: there is no finished run to report instead.
      unreported: async () => null,
    });
    booted.heard({ type: "task.assigned", refId: "t_6" });
    await booted.scan();
    booted.heard({ type: "task.changed", refId: "t_6" });
    await booted.idle();

    expect(next.started).toHaveLength(1);
    // And asked the board for it once: the second ask was held back here, not refused by the hub.
    expect(
      hub.requests.filter(
        (request) =>
          request.path === "/tasks/t_6/checkout" &&
          (request.body as { runId: string }).runId !== "run-dead",
      ),
    ).toHaveLength(1);
    expect(hub.tasks.get("t_6")?.stage).toBe("review");
    expect(hub.tasks.get("t_6")?.notes).toHaveLength(1);
  });

  test("a run that finished before the crash is reported, not run again", async () => {
    const hub = fakeTaskHub();
    hub.add({ id: "t_7", assignee: `bot:${ME}` });
    const { run, started } = scripted({ kind: "done", steps: 1 });
    const booted = createTaskPickup({
      http: hub.as(ME),
      memberId: () => ME,
      run,
      newRunId: () => "run-claim",
      // The ledger here says a run of this task finished and the board never heard of it.
      unreported: async ({ noted }) =>
        noted.has("run-finished")
          ? null
          : { runId: "run-finished", outcome: { kind: "done" } },
    });

    await booted.scan();

    expect(started).toEqual([]);
    expect(hub.tasks.get("t_7")?.stage).toBe("review");
    expect(hub.tasks.get("t_7")?.notes).toEqual([
      {
        by: `bot:${ME}`,
        text: "laf:task_ran run:run-finished",
        // Claimed under the finished run's own id, so the note's id is the run the ledger holds.
        runId: "run-finished",
      },
    ]);
  });

  test("a recovered run's task, given back to todo by a person, is worked — not reported again", async () => {
    const hub = fakeTaskHub();
    hub.add({ id: "t_10", assignee: `bot:${ME}` });
    const { run, started } = scripted({ kind: "done", steps: 1 });
    const pickup = createTaskPickup({
      http: hub.as(ME),
      memberId: () => ME,
      run,
      newRunId: () => "run-fresh",
      // The ledger's last row for the task stays the finished run until a new one is begun.
      unreported: async ({ noted }) =>
        started.length > 0 || noted.has("run-finished")
          ? null
          : { runId: "run-finished", outcome: { kind: "done" } },
    });
    await pickup.scan();
    expect(started).toEqual([]);
    expect(hub.tasks.get("t_10")?.stage).toBe("review");

    // A person sends it back to the 라피.
    const task = hub.tasks.get("t_10");
    if (task) {
      task.stage = "todo";
      task.version += 1;
    }
    pickup.heard({ type: "task.changed", refId: "t_10" });
    await pickup.idle();

    expect(started).toEqual(["t_10:run-fresh"]);
    expect(hub.tasks.get("t_10")?.notes.map((note) => note.text)).toEqual([
      "laf:task_ran run:run-finished",
      "laf:task_ran run:run-fresh steps:1",
    ]);
  });

  test("a claim taken from under the run stops it, tells the board nothing of it, and the task is looked at again", async () => {
    const hub = fakeTaskHub();
    hub.add({ id: "t_8", assignee: `bot:${ME}` });
    const started: string[] = [];
    const pickup = createTaskPickup({
      http: hub.as(ME),
      memberId: () => ME,
      run: ({ runId, signal }) => {
        started.push(runId);
        if (started.length > 1)
          return Promise.resolve({ kind: "done", steps: 1 });
        return new Promise<TaskRunOutcome>((resolve) => {
          // A person moves the task back to todo while the run works: the next beat is told it is
          // not held. The `task.changed` that move raised arrives while the task is still busy.
          const task = hub.tasks.get("t_8");
          if (task) {
            task.stage = "todo";
            task.checkout = null;
            task.version += 1;
          }
          pickup.heard({ type: "task.changed", refId: "t_8" });
          signal.addEventListener("abort", () => resolve({ kind: "lost" }));
        });
      },
      newRunId: () => `run-c${started.length + 1}`,
      heartbeatMs: 5,
    });

    pickup.heard({ type: "task.assigned", refId: "t_8" });
    await pickup.idle();

    // The cut-off run said nothing; the task, waiting again, was read again and worked.
    expect(started).toEqual(["run-c1", "run-c2"]);
    expect(hub.tasks.get("t_8")?.stage).toBe("review");
    expect(hub.tasks.get("t_8")?.notes.map((note) => note.text)).toEqual([
      "laf:task_ran run:run-c2 steps:1",
    ]);
  });

  test("a task a person sends back to todo before the run's beat sees it: the move refused is never reported later, and the task is worked again", async () => {
    const hub = fakeTaskHub();
    hub.add({ id: "t_12", assignee: `bot:${ME}` });
    // The ledger as `createUnreportedRuns` reads it: the task's last run, and whether it was lost.
    const ledger: { runId: string; lost: boolean }[] = [];
    const started: string[] = [];
    let made = 0;
    const pickup = createTaskPickup({
      http: hub.as(ME),
      memberId: () => ME,
      run: async ({ task, runId }) => {
        started.push(`${runId}:v${task.version}`);
        if (started.length === 1) {
          // A person edits it and sends it back to todo; the run finishes before its next beat.
          const held = hub.tasks.get("t_12");
          if (held) {
            held.stage = "todo";
            held.checkout = null;
            held.title = "고친 일";
            held.version += 1;
          }
          pickup.heard({ type: "task.changed", refId: "t_12" });
        }
        ledger.push({ runId, lost: false });
        return { kind: "done", steps: 1 };
      },
      unreported: async ({ noted }) => {
        const last = ledger.at(-1);
        return last && !last.lost && !noted.has(last.runId)
          ? { runId: last.runId, outcome: { kind: "done" } }
          : null;
      },
      refused: async (runId) => {
        const row = ledger.find((one) => one.runId === runId);
        if (row) row.lost = true;
      },
      newRunId: () => {
        made += 1;
        return `run-e${made}`;
      },
    });

    pickup.heard({ type: "task.assigned", refId: "t_12" });
    await pickup.idle();
    // The line comes back later and the board is read again: nothing is left to report.
    await pickup.scan();

    expect(started).toEqual(["run-e1:v2", "run-e2:v4"]);
    expect(hub.tasks.get("t_12")?.stage).toBe("review");
    expect(hub.tasks.get("t_12")?.notes.map((note) => note.text)).toEqual([
      "laf:task_ran run:run-e2 steps:1",
    ]);
  });

  test("a finished run that keeps losing its claim to the sweep is retried once, then the task is blocked with the fact — not run lap after lap", async () => {
    const hub = fakeTaskHub();
    hub.add({ id: "t_15", assignee: `bot:${ME}` });
    // The hub answers the claim and the move, but none of the run's beats reach it.
    hub.intercepting((request) =>
      request.path.endsWith("/heartbeat")
        ? { ok: false, status: null, code: "laf:hub_unreachable" }
        : undefined,
    );
    const started: string[] = [];
    let made = 0;
    const pickup = createTaskPickup({
      http: hub.as(ME),
      memberId: () => ME,
      run: async ({ runId }) => {
        started.push(runId);
        // The run outlives its claim, and the sweep frees the task before the run's move.
        if (started.length <= 4) {
          hub.advance(LOCK_MS + 1);
          hub.sweep();
        }
        return { kind: "done", steps: 1 };
      },
      unreported: async () => null,
      refused: async () => {},
      newRunId: () => {
        made += 1;
        return `run-f${made}`;
      },
    });

    pickup.heard({ type: "task.assigned", refId: "t_15" });
    await pickup.idle();

    expect(started).toEqual(["run-f1", "run-f2"]);
    expect(hub.tasks.get("t_15")?.stage).toBe("blocked");
    expect(hub.tasks.get("t_15")?.notes.map((note) => note.text)).toEqual([
      "laf:task_claim_lost run:run-f3",
    ]);
  });

  test("a refused run whose ledger could not be told is still not reported on the look after it", async () => {
    const hub = fakeTaskHub();
    hub.add({ id: "t_16", assignee: `bot:${ME}` });
    const started: string[] = [];
    let made = 0;
    const pickup = createTaskPickup({
      http: hub.as(ME),
      memberId: () => ME,
      run: async ({ runId }) => {
        started.push(runId);
        if (started.length === 1) {
          // A person sends it back to todo before the run's next beat.
          const held = hub.tasks.get("t_16");
          if (held) {
            held.stage = "todo";
            held.checkout = null;
            held.version += 1;
          }
        }
        return { kind: "done", steps: 1 };
      },
      // The ledger still names the first run as finished and unreported: writing it lost failed.
      unreported: async ({ noted }) =>
        started.length === 0 || noted.has("run-g1")
          ? null
          : { runId: "run-g1", outcome: { kind: "done" } },
      refused: async () => {
        throw new Error("database away");
      },
      newRunId: () => {
        made += 1;
        return `run-g${made}`;
      },
    });

    pickup.heard({ type: "task.assigned", refId: "t_16" });
    await pickup.idle();

    expect(started).toEqual(["run-g1", "run-g2"]);
    expect(hub.tasks.get("t_16")?.notes.map((note) => note.text)).toEqual([
      "laf:task_ran run:run-g2 steps:1",
    ]);
  });

  test("a task another member gave this 라피 is left as it is; one this member gave it is taken", async () => {
    const hub = fakeTaskHub();
    hub.add({ id: "t_13", assignee: `bot:${ME}`, assignedBy: "m_other" });
    hub.add({ id: "t_14", assignee: `bot:${ME}`, assignedBy: ME });
    const { run, started } = scripted({ kind: "done", steps: 1 });
    const pickup = createTaskPickup({
      http: hub.as(ME),
      memberId: () => ME,
      run,
      newRunId: runIds,
    });

    await pickup.scan();
    pickup.heard({ type: "task.assigned", refId: "t_13" });
    await pickup.idle();

    expect(started.map((one) => one.split(":")[0])).toEqual(["t_14"]);
    expect(hub.tasks.get("t_13")?.stage).toBe("todo");
    expect(hub.tasks.get("t_13")?.notes).toEqual([]);
    expect(
      hub.requests.some((request) => request.path === "/tasks/t_13/checkout"),
    ).toBe(false);
  });

  test("a task this process let go of itself is not taken again on the event its release raised", async () => {
    const hub = fakeTaskHub();
    hub.add({ id: "t_9", assignee: `bot:${ME}` });
    // The move does not reach the hub; the release after it does, and puts the task back to `todo`.
    hub.intercepting((request) =>
      request.method === "PATCH"
        ? { ok: false, status: null, code: "laf:hub_unreachable" }
        : undefined,
    );
    const { run, started } = scripted({ kind: "done", steps: 1 });
    const pickup = createTaskPickup({
      http: hub.as(ME),
      memberId: () => ME,
      run,
      newRunId: runIds,
    });
    pickup.heard({ type: "task.assigned", refId: "t_9" });
    await pickup.idle();
    expect(hub.tasks.get("t_9")?.stage).toBe("todo");

    // The release's own `task.changed`.
    pickup.heard({ type: "task.changed", refId: "t_9" });
    await pickup.idle();
    expect(started).toHaveLength(1);

    // A person's later change makes it waiting again, and it is taken.
    hub.intercepting(() => undefined);
    const task = hub.tasks.get("t_9");
    if (task) task.version += 1;
    pickup.heard({ type: "task.changed", refId: "t_9" });
    await pickup.idle();
    expect(started).toHaveLength(2);
    expect(hub.tasks.get("t_9")?.stage).toBe("review");
  });
});

describe("what a run leaves on the board", () => {
  test.each<
    [
      TaskRunOutcome & { kind: Exclude<TaskRunOutcome["kind"], "lost"> },
      string,
      string,
    ]
  >([
    [{ kind: "done", steps: 3 }, "review", "laf:task_ran run:r1 steps:3"],
    [
      { kind: "approval", topic: "tool/call@mail/send", steps: 2 },
      "blocked",
      "laf:task_needs_approval run:r1 topic:tool/call@mail/send",
    ],
    [{ kind: "login", steps: 1 }, "blocked", "laf:task_needs_login run:r1"],
    [{ kind: "person" }, "blocked", "laf:task_needs_person run:r1"],
    [
      { kind: "failed", code: "laf:run_timed_out", steps: 12 },
      "blocked",
      "laf:task_run_failed run:r1 code:laf:run_timed_out",
    ],
    [{ kind: "stopped", steps: 1 }, "blocked", "laf:task_run_stopped run:r1"],
  ])("%p → %s", (outcome, stage, note) => {
    expect(taskReport("r1", outcome)).toEqual({
      stage: stage as "review" | "blocked",
      note,
    });
  });

  test("one line, never longer than a 라피's note may be", () => {
    const { note } = taskReport("r1", {
      kind: "approval",
      topic: `a\nb${"x".repeat(900)}`,
    });
    expect(note.includes("\n")).toBe(false);
    expect(note.length).toBe(500);
    expect(note.startsWith("laf:task_needs_approval run:r1 topic:a b")).toBe(
      true,
    );
  });
});

describe("what the line delivers", () => {
  test("a task's event is looked at, another kind is not, and the line coming up reads the board", async () => {
    const hub = fakeTaskHub();
    hub.add({ id: "t_10", assignee: `bot:${ME}` });
    hub.add({ id: "t_11", assignee: `bot:${ME}` });
    const { run, started } = scripted({ kind: "done", steps: 1 });
    const pickup = createTaskPickup({
      http: hub.as(ME),
      memberId: () => ME,
      run,
      newRunId: runIds,
    });
    const at = new Date(0).toISOString();

    hearFrame(pickup, {
      kind: "hub.member.changed",
      seq: 1,
      refId: "t_11",
      actor: null,
      at,
    });
    await pickup.idle();
    expect(started).toEqual([]);

    hearFrame(pickup, {
      kind: "hub.task.assigned",
      seq: 2,
      refId: "t_10",
      actor: "m_boss",
      at,
    });
    await pickup.idle();
    expect(started.map((one) => one.split(":")[0])).toEqual(["t_10"]);

    await hearFrame(pickup, {
      kind: "hub.status",
      state: "connected",
      code: null,
      workspace: null,
      member: null,
      since: at,
    });
    expect(started.map((one) => one.split(":")[0])).toEqual(["t_10", "t_11"]);
  });
});
