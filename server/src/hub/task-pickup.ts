/**
 * A task on the company board given to this member's 라피 (`bot:<member>`), or to a sub-Bot this VM
 * runs (`job:<id>`): taken, worked, and handed back for a person to look at.
 *
 * A SUB-BOT'S TASK IS ITS RUNNER'S (lafi-dev-design §6, the `job:<id>` row). `task.assigned` for a
 * job reaches everybody who can see the task, so every VM hears it and exactly one acts: the one
 * where a routine is linked to the job AND whose member the hub names the job's runner now
 * (`jobs.ts`, `routineFor`). It runs as that routine — its instruction, its Bot, its limits — and
 * against the job's day as well as the task's (`task-run.ts`). After `job.moved` takes the job
 * away, the link is gone here and the next task is the new runner's.
 *
 * THE SHAPE (lafi-dev-design §6). `task.assigned` names a task given to this member — and at boot,
 * and every time the line comes back, the board is read for tasks already given and still waiting.
 * For each, one run: `POST /tasks/:id/checkout {runId}` — the hub's one conditional UPDATE, which of
 * any number of runs asking at once tells exactly one yes. The rest are `laf:task_taken`, and a run
 * told that stops: it does not ask again, because a second ask can only be answered the same way.
 * While the run works it beats every two minutes, inside the hub's five-minute claim. It ends with
 * one `PATCH {stage, note}` — `review` when the Bot finished, `blocked` when it stopped for a person
 * (an approval, a sign-in) or did not finish — and the claim is let go of whatever happened. Never
 * `done`: whether work is finished is a person's judgement, and the hub refuses it from a Bot.
 *
 * WHAT KEEPS ONE TASK TO ONE RUN.
 * - Between VMs (two processes holding the same member's pass): the hub's checkout. Only one wins.
 * - Inside this process: a task being looked at is not looked at again until that is over, so the
 *   boot's read and an event replayed from before a restart, arriving together, make one run.
 * - Across a restart: a run that FINISHED here — its ledger row settled — and whose move never
 *   reached the hub (the process died between the two, or the hub was away) is not run again when
 *   the sweep puts the task back. It is reported: the task is taken under a fresh claim and moved
 *   with the finished run's id (`unreported`). A run cut off mid-way never settled, and is run again
 *   — the work was not done.
 * - A task this process let go of itself (`release`, which puts a `doing` task back to `todo`) is
 *   not taken again on the event that release raises: what it was left at is remembered by
 *   version, and only a later change — a person's, the sweep's — makes it waiting again.
 *
 * A CRASH IS THE HUB'S TO CLEAN UP. A process that dies holding a task stops beating; the hub's
 * sweep frees the claim within a minute of it running out and says so (`task.changed`), and the
 * board read at the next boot finds it waiting. A claim is never taken back from a run this process
 * does not know, because a second process holding the same pass may be alive and working on it.
 *
 * THE NOTE IS FACTS. One line: what became of the run, its id, and for a stop the topic — the kind
 * of action and where — never the call's arguments, which are what a person would have been shown
 * to decide on and may hold what the Bot was about to send.
 */
import { randomUUID } from "node:crypto";
import type { HubEvent } from "../../../shared/hub/protocol";
import { log } from "../log";
import type { HubHttp } from "./http";
import type { HubFrame } from "./link";
import {
  HUB_TASK_BOT_NOTE_MAX,
  HUB_TASK_CODES,
  HUB_TASK_HEARTBEAT_MS,
  HUB_TASK_PAGE,
  HUB_TASK_PATHS,
  type HubTaskView,
  readTaskDetail,
  readTaskPage,
  taskClaimBody,
  taskMoveBody,
} from "./wire";

/** How a task's run ended, as far as the board is told. */
export type TaskRunOutcome =
  /** The Bot finished: a person looks at what it did. */
  | { kind: "done"; steps?: number }
  /** An action it reached needs a person's yes. `topic` is its kind and where, never its content. */
  | { kind: "approval"; topic: string; steps?: number }
  /** A site needs a sign-in nobody saved. */
  | { kind: "login"; steps?: number }
  /** It stopped for a person, and which kind is no longer known (a run reported after a restart). */
  | { kind: "person"; steps?: number }
  /** It did not finish: the model failed, the time ran out. `code` is the fact. */
  | { kind: "failed"; code: string; steps?: number }
  /** A person stopped it (`모두 멈추기`). */
  | { kind: "stopped"; steps?: number }
  /** The claim went from under it: a person moved the task, or the sweep freed it. Nothing is said. */
  | { kind: "lost" };

/** The sub-Bot a task was given to, and the routine on this VM that it runs as. */
export type TaskJob = { id: string; routineId: string };

export type TaskRun = (input: {
  task: HubTaskView;
  /** Given to a sub-Bot this VM runs; absent for a task given to this member's 라피. */
  job?: TaskJob;
  /** The claim's id on the hub, which is also the run's id here (the ledger, the thread). */
  runId: string;
  /** Aborted when the claim is lost. */
  signal: AbortSignal;
}) => Promise<TaskRunOutcome>;

/** A run of this task that finished here and that no note on the board names. */
export type UnreportedRun = (input: {
  taskId: string;
  noted: ReadonlySet<string>;
}) => Promise<{ runId: string; outcome: TaskRunOutcome } | null>;

export type TaskPickupOptions = {
  http: HubHttp;
  /** This VM's member id on the hub, from the last `/me` that answered; null before one did. */
  memberId: () => string | null;
  run: TaskRun;
  /** The sub-Bots this VM runs (`jobs.ts`). Absent: a task given to a job is never taken here. */
  jobs?: { routineFor(jobId: string): Promise<string | null> };
  unreported?: UnreportedRun;
  heartbeatMs?: number;
  newRunId?: () => string;
};

export type TaskPickup = {
  /** An event off the hub's line. Only the task's are looked at. */
  heard(event: Pick<HubEvent, "type" | "refId">): void;
  /** Read the board for tasks given to this 라피 and still waiting. At boot, and when the line is back. */
  scan(): Promise<void>;
  /** Whatever is being looked at or run now, settled. For a test, and for leaving. */
  idle(): Promise<void>;
};

/** One line, cut to what the hub takes from a Bot. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > HUB_TASK_BOT_NOTE_MAX
    ? flat.slice(0, HUB_TASK_BOT_NOTE_MAX)
    : flat;
}

/**
 * The note a finished run leaves, and the stage it moves the task to. Facts with a code first, so a
 * board can put them into words — the surface owns the sentence, as everywhere in this product.
 */
export function taskReport(
  runId: string,
  outcome: Exclude<TaskRunOutcome, { kind: "lost" }>,
): { stage: "review" | "blocked"; note: string } {
  const run = `run:${runId}`;
  switch (outcome.kind) {
    case "done":
      return {
        stage: "review",
        note: oneLine(`laf:task_ran ${run}${stepsOf(outcome)}`),
      };
    case "approval":
      return {
        stage: "blocked",
        note: oneLine(`laf:task_needs_approval ${run} topic:${outcome.topic}`),
      };
    case "login":
      return {
        stage: "blocked",
        note: oneLine(`laf:task_needs_login ${run}`),
      };
    case "person":
      return {
        stage: "blocked",
        note: oneLine(`laf:task_needs_person ${run}`),
      };
    case "failed":
      return {
        stage: "blocked",
        note: oneLine(`laf:task_run_failed ${run} code:${outcome.code}`),
      };
    case "stopped":
      return {
        stage: "blocked",
        note: oneLine(`laf:task_run_stopped ${run}`),
      };
  }
}

/** How many steps the run took, where that is known (a run reported after a restart is not). */
const stepsOf = (outcome: { steps?: number }) =>
  outcome.steps === undefined ? "" : ` steps:${outcome.steps}`;

/** The job a task is given to (`job:<id>`), or null. */
export function jobOf(assignee: string | null): string | null {
  if (!assignee?.startsWith("job:")) return null;
  const id = assignee.slice("job:".length);
  return id ? id : null;
}

const TASK_EVENTS: ReadonlySet<string> = new Set([
  "task.assigned",
  "task.changed",
]);

export function createTaskPickup(options: TaskPickupOptions): TaskPickup {
  const heartbeatMs = options.heartbeatMs ?? HUB_TASK_HEARTBEAT_MS;
  const newRunId = options.newRunId ?? randomUUID;
  /** Tasks being looked at or run in this process. Added before the first await. */
  const busy = new Map<string, Promise<void>>();
  /** The version this process left a task at when it let go of it. See the module comment. */
  const leftAt = new Map<string, number>();

  const key = () => `task-${randomUUID()}`;

  /** The claim is let go of. A `laf:task_not_held` is a claim the move already ended: not news. */
  const release = async (taskId: string, runId: string) => {
    const answer = await options.http.request({
      method: "POST",
      path: HUB_TASK_PATHS.release(taskId),
      body: taskClaimBody(runId),
      idempotencyKey: key(),
      run: runId,
      origin: "job",
    });
    if (answer.ok) {
      const released = readTaskDetail(answer.body);
      if (released) leftAt.set(taskId, released.task.version);
      return;
    }
    if (answer.code !== HUB_TASK_CODES.notHeld) {
      // The sweep frees it within a minute of the claim running out.
      log.warn("hub_task_not_released", { task: taskId, code: answer.code });
    }
  };

  const report = async (
    taskId: string,
    claimRunId: string,
    workRunId: string,
    outcome: Exclude<TaskRunOutcome, { kind: "lost" }>,
  ): Promise<boolean> => {
    const { stage, note } = taskReport(workRunId, outcome);
    const answer = await options.http.request({
      method: "PATCH",
      path: HUB_TASK_PATHS.move(taskId),
      body: taskMoveBody({ runId: claimRunId, stage, note }),
      idempotencyKey: key(),
      run: claimRunId,
      origin: "job",
    });
    if (answer.ok) {
      const moved = readTaskDetail(answer.body);
      if (moved) leftAt.set(taskId, moved.task.version);
      log.info("hub_task_moved", { task: taskId, run: workRunId, stage });
      return true;
    }
    log.warn("hub_task_not_moved", {
      task: taskId,
      run: workRunId,
      stage,
      code: answer.code,
    });
    return false;
  };

  /**
   * Whether the task is waiting to be taken and might be this VM's: given to this 라피, or to a job
   * (whether the job is this VM's is asked after, by `runsAs` — it takes a read).
   */
  const waiting = (task: HubTaskView, me: string) =>
    (task.assignee === `bot:${me}` ||
      (options.jobs !== undefined && jobOf(task.assignee) !== null)) &&
    task.stage === "todo" &&
    task.checkout === null &&
    (leftAt.get(task.id) ?? -1) < task.version;

  /** What this VM runs the task as: its 라피 (`{}`), a sub-Bot it runs, or nothing (null). */
  const runsAs = async (
    task: HubTaskView,
    me: string,
  ): Promise<{ job?: TaskJob } | null> => {
    if (task.assignee === `bot:${me}`) return {};
    const jobId = jobOf(task.assignee);
    if (!jobId || !options.jobs) return null;
    const routineId = await options.jobs.routineFor(jobId);
    return routineId ? { job: { id: jobId, routineId } } : null;
  };

  const work = async (taskId: string, seen?: HubTaskView): Promise<void> => {
    const me = options.memberId();
    if (!me) return;
    if (seen && !waiting(seen, me)) return;
    // Read again, with its notes: an event names a task and never carries it.
    const read = await options.http.request({
      path: HUB_TASK_PATHS.task(taskId),
      retry: false,
    });
    if (!read.ok) {
      if (read.code !== "laf:hub_not_found") {
        log.warn("hub_task_not_read", { task: taskId, code: read.code });
      }
      return;
    }
    const detail = readTaskDetail(read.body);
    if (!detail || !waiting(detail.task, me)) return;
    const as = await runsAs(detail.task, me);
    if (!as) return;

    const noted = new Set(
      detail.notes
        .map((note) => note.runId)
        .filter((run): run is string => run !== null),
    );
    const finished = options.unreported
      ? await options.unreported({ taskId, noted }).catch((error: unknown) => {
          log.warn("hub_task_ledger_not_read", {
            task: taskId,
            reason: error instanceof Error ? error.name : "unknown",
          });
          return null;
        })
      : null;

    const runId = newRunId();
    const claim = await options.http.request({
      method: "POST",
      path: HUB_TASK_PATHS.checkout(taskId),
      body: taskClaimBody(runId),
      idempotencyKey: key(),
      run: runId,
      origin: "job",
    });
    if (!claim.ok) {
      // Taken by another run, or no longer waiting. Not asked again.
      log.info("hub_task_not_taken", { task: taskId, code: claim.code });
      return;
    }
    const claimed = readTaskDetail(claim.body)?.task ?? detail.task;
    log.info("hub_task_taken", { task: taskId, run: runId });

    try {
      if (finished) {
        // The work is done already; only the board was never told.
        if (finished.outcome.kind !== "lost") {
          await report(taskId, runId, finished.runId, finished.outcome);
        }
        return;
      }

      const lost = new AbortController();
      let beating = false;
      const beat = async () => {
        if (beating || lost.signal.aborted) return;
        beating = true;
        try {
          const answer = await options.http.request({
            method: "POST",
            path: HUB_TASK_PATHS.heartbeat(taskId),
            body: taskClaimBody(runId),
            idempotencyKey: key(),
            run: runId,
            origin: "job",
            retry: false,
          });
          // A hub that did not answer is beaten again in two minutes; the claim outlasts one miss.
          if (!answer.ok && answer.code === HUB_TASK_CODES.notHeld) {
            log.info("hub_task_lost", { task: taskId, run: runId });
            lost.abort();
          }
        } finally {
          beating = false;
        }
      };
      const timer = setInterval(() => void beat(), heartbeatMs);
      let outcome: TaskRunOutcome;
      try {
        outcome = await options.run({
          task: claimed,
          ...as,
          runId,
          signal: lost.signal,
        });
      } catch (error) {
        log.error("hub_task_run_crashed", {
          task: taskId,
          run: runId,
          reason: error instanceof Error ? error.name : "unknown",
        });
        outcome = { kind: "failed", code: "laf:turn_failed", steps: 0 };
      } finally {
        clearInterval(timer);
      }
      if (lost.signal.aborted || outcome.kind === "lost") return;
      await report(taskId, runId, runId, outcome);
    } finally {
      // Always: after a move this is `laf:task_not_held` and says nothing; otherwise it frees the
      // task now rather than when the sweep finds its claim run out.
      await release(taskId, runId);
    }
  };

  const consider = (taskId: string, seen?: HubTaskView): Promise<void> => {
    const current = busy.get(taskId);
    if (current) return current;
    const going = work(taskId, seen)
      .catch((error: unknown) => {
        log.error("hub_task_pickup_failed", {
          task: taskId,
          reason: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => {
        busy.delete(taskId);
      });
    busy.set(taskId, going);
    return going;
  };

  return {
    heard(event) {
      if (!TASK_EVENTS.has(event.type) || !event.refId) return;
      void consider(event.refId);
    },

    async scan() {
      if (!options.memberId()) return;
      let cursor: string | null = null;
      const started: Promise<void>[] = [];
      // A board is a few hundred tasks at most; the pages stop when the hub says there are no more.
      for (let page = 0; page < 50; page += 1) {
        const answer = await options.http.request({
          path: HUB_TASK_PATHS.waiting(HUB_TASK_PAGE, cursor),
          retry: false,
        });
        if (!answer.ok) {
          log.warn("hub_tasks_not_read", { code: answer.code });
          break;
        }
        const read = readTaskPage(answer.body);
        if (!read) break;
        for (const task of read.tasks) started.push(consider(task.id, task));
        if (!read.next) break;
        cursor = read.next;
      }
      await Promise.all(started);
    },

    async idle() {
      while (busy.size > 0) {
        await Promise.allSettled([...busy.values()]);
      }
    },
  };
}

/**
 * What the line delivers, as the pickup hears it (`main.ts`): an event names a task to look at, and
 * the line coming up — at boot, and after every drop — is when the board is read for what was given
 * while nothing was listening.
 */
export function hearFrame(
  pickup: TaskPickup | undefined,
  frame: HubFrame,
): Promise<void> {
  if (!pickup) return Promise.resolve();
  if ("state" in frame) {
    return frame.state === "connected" ? pickup.scan() : Promise.resolve();
  }
  pickup.heard({ type: frame.kind.slice("hub.".length), refId: frame.refId });
  return Promise.resolve();
}
