/**
 * AFTER A RUN, NOTHING OF IT IS LEFT RUNNING — and the one call that makes it so.
 *
 * A script may start whatever it likes: a child that outlives it, a child of that child that left
 * its session. Killing the script's own process, as the converter kills a parser's
 * (`converter-process.ts`), leaves all of those, and a process that survives one run is there for
 * the next run's files. So when a run is over the daemon ends EVERY other process there is —
 * `kill(-1, SIGKILL)`, which the kernel applies to every process the caller may signal except the
 * caller itself and process 1. The service runs one script at a time (`./daemon.ts`), so "every
 * other process" and "what that run left" are the same set.
 *
 * THE DAEMON IS PROCESS 1 OF ITS CONTAINER, and that is a wall, not an accident of compose (no
 * `init:` there, on purpose). A script runs as the daemon's own user — there is no capability left
 * to become another — so it may signal the daemon. Process 1 is the one process the kernel will
 * not let its own namespace stop or kill: a SIGSTOP or SIGKILL sent from inside is dropped. Under
 * an init, a script could stop the daemon and then outlive its time with nobody left to end it.
 * Every other signal either has no handler here and is dropped the same way, or has one that ends
 * the daemon — and process 1 ending is the container ending, every process in it with it.
 *
 * What that costs: an orphan the sweep kills is handed to process 1, which is not an init and
 * waits for nobody, so it stays as a dead entry in the process table. They hold nothing but a
 * slot; {@link isWorn} counts them and the daemon retires itself — compose starts a fresh
 * container — before the slots run out.
 *
 * THAT SAME CALL, ANYWHERE ELSE, ENDS EVERYTHING ITS USER IS RUNNING. On a developer's machine it
 * is every window and every unsaved file; on a CI runner it is the job. It is safe in exactly one
 * place: a container that holds nothing but this daemon and one run. So the call is locked twice,
 * and neither lock can be opened from outside this file.
 *
 *  1. {@link sweepWith} reads where this process is — now, each time — and refuses, by throwing
 *     before anything else, unless every fact is the sandbox's: Linux, process 1, the sandbox's
 *     user, no interface but loopback, no capability, no new privileges, a read-only root, the
 *     work directory a tmpfs, and memory no other process may read. No machine anybody works on
 *     is all of those; no process anybody starts by hand is process 1.
 *  2. The function that makes the call ({@link killEveryOtherProcess}) is not exported, reads the
 *     same facts again for itself — the REAL ones, whatever `sweepWith` was handed — and then
 *     checks the platform, the user and its own pid once more in its own words. The only way to it
 *     is {@link createSweep}, and all a caller can tell that is which directory must be a tmpfs.
 *
 * A test drives `sweepWith` with its own facts and a call that only records itself. Nothing run on
 * a laptop or in CI reaches the real one: its only proof is the service in its container
 * (`scripts/workbench-probe.ts`), where a process a script left behind has to be gone.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import {
  filesystemAt,
  type IsolationFacts,
  isolationProblems,
  readIsolationFacts,
} from "../isolation";

/** The user compose runs the service as (`user: "65534:65534"`): nobody. */
export const SANDBOX_UID = 65534;

/** Where this process is, as far as running a stranger's script and sweeping after it needs. */
export type SandboxFacts = IsolationFacts & {
  platform: string;
  pid: number;
  /** The kind of filesystem mounted at the work directory. Null where nothing is mounted there. */
  workFilesystem: string | null;
  /**
   * Whether another process of this user is kept out of this one's memory — by this process
   * having made itself undumpable (`./undumpable.ts`), or by the host refusing a trace of anything
   * but one's own descendants (Yama, `ptrace_scope` 1 or more). Either holds the daemon against
   * the scripts it runs, which are its children and never its ancestors. Without one, a script
   * could write into the daemon and be there for every run after its own.
   */
  memoryKept: boolean;
};

/**
 * Whether this process is undumpable, read off `/proc`: the kernel hands the files under
 * `/proc/<pid>` to root when it is, and to the process's own user when it is not (proc(5)). Null
 * for root, whose files are root's either way, and off Linux.
 */
export function isUndumpable(): boolean | null {
  try {
    const self = process.getuid?.();
    if (self === undefined || self === 0) return null;
    return statSync("/proc/self/stat").uid === 0;
  } catch {
    return null;
  }
}

/** The host's rule about who may trace whom, or null where it has none. */
export function ptraceScope(): number | null {
  try {
    const value = Number.parseInt(
      readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim(),
      10,
    );
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Read where this process is. Reads only; safe anywhere. */
export function readSandboxFacts(workRoot: string): SandboxFacts {
  return {
    ...readIsolationFacts(),
    platform: process.platform,
    pid: process.pid,
    workFilesystem: filesystemAt(workRoot),
    memoryKept: isUndumpable() === true || (ptraceScope() ?? 0) >= 1,
  };
}

/**
 * What is not as compose says it should be, for a service that runs a stranger's script. Empty is
 * the sandbox. Asked before the daemon listens, before every run, and twice inside the sweep.
 */
export function sandboxProblems(facts: SandboxFacts): string[] {
  const problems = isolationProblems(facts);
  if (facts.platform !== "linux") problems.push("not_linux");
  if (facts.pid !== 1) problems.push("not_process_one");
  if (facts.uid !== SANDBOX_UID) problems.push("not_the_sandbox_user");
  if (facts.workFilesystem !== "tmpfs") problems.push("work_not_tmpfs");
  if (!facts.memoryKept) problems.push("memory_readable");
  return problems;
}

/** The sweep would not run here. Thrown before the call; nothing was signalled. */
export class SweepRefusedError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`sweep refused: ${problems.join(", ")}`);
    this.name = "SweepRefusedError";
  }
}

/** The call was made and something is still running. The service must not take another run. */
export class SweepIncompleteError extends Error {
  constructor(readonly survivors: readonly number[]) {
    super(`sweep left ${survivors.length} process(es) running`);
    this.name = "SweepIncompleteError";
  }
}

export type SweepParts = {
  /** Where this process is, read now. */
  facts: () => SandboxFacts;
  /** The call itself. */
  killAll: () => void;
  /** Every other process still running here, by pid. */
  others: () => number[];
  /** How long what was signalled is given to be gone. */
  settleMs?: number;
};

/** A killed process is gone within a scheduler tick or two; this is a bound, not a wait. */
const SETTLE_MS = 2_000;

/**
 * The sweep, with every part of it handed in: refuse unless this is the sandbox, make the call,
 * and do not come back until nothing else is running — or say what still is.
 *
 * The check after the call is what makes "nothing is left" a thing the service knows rather than
 * assumes: if the runtime's `kill` ever did not mean what it means today, the next run would not
 * start beside what the last one left.
 */
export async function sweepWith(parts: SweepParts): Promise<void> {
  const problems = sandboxProblems(parts.facts());
  if (problems.length > 0) throw new SweepRefusedError(problems);
  parts.killAll();
  const deadline = Date.now() + (parts.settleMs ?? SETTLE_MS);
  for (;;) {
    const left = parts.others();
    if (left.length === 0) return;
    if (Date.now() >= deadline) throw new SweepIncompleteError(left);
    await Bun.sleep(10);
  }
}

/** Every other process in this process's view, with the one-letter state `/proc` gives it. */
function othersWithState(): { pid: number; state: string }[] {
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return [];
  }
  const found: { pid: number; state: string }[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    try {
      // `pid (name) state …`, and a name may hold spaces and brackets of its own: the state is the
      // first field after the LAST closing bracket.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const after = stat.lastIndexOf(")") + 2;
      found.push({ pid, state: stat.slice(after, after + 1) });
    } catch {
      // Gone between the listing and the read.
    }
  }
  return found;
}

/**
 * Every other process that can still run: every pid under `/proc` but this one, less the ones that
 * have already died and only hold their entry.
 */
export function otherProcesses(): number[] {
  return othersWithState()
    .filter(({ state }) => state !== "Z" && state !== "X")
    .map(({ pid }) => pid);
}

/** How many have died and still hold an entry, because process 1 here waits for nobody. */
function deadProcesses(): number {
  return othersWithState().filter(({ state }) => state === "Z").length;
}

/**
 * How many dead entries process 1 may be left holding before the daemon retires. Each is a slot
 * out of the container's `pids_limit` (128) and nothing else; an ordinary script leaves none.
 */
const RETIRE_AT_DEAD = 32;

/** How many System V objects — segments, queues, semaphore sets — this container's kernel holds. */
function systemVObjects(): number {
  let objects = 0;
  for (const kind of ["shm", "msg", "sem"]) {
    try {
      // One heading, then a line for each.
      const lines = readFileSync(`/proc/sysvipc/${kind}`, "utf8").trim();
      objects += Math.max(0, lines.split("\n").length - 1);
    } catch {
      // No such table in this kernel: nothing of that kind can be left.
    }
  }
  return objects;
}

/**
 * Whether a run has left something in the kernel that nothing here can take away, so that the
 * daemon should end and let compose start a fresh container — a new process table, a new IPC
 * namespace. Two things can be: dead children process 1 never waited for, once enough have piled
 * up; and ANY System V object, because a segment outlives every process that made it, holds
 * memory this container is charged for, and is somewhere one run could leave the next a note.
 */
export function isWorn(): boolean {
  return deadProcesses() >= RETIRE_AT_DEAD || systemVObjects() > 0;
}

/**
 * THE CALL. Not exported — see the top of this file.
 *
 * It reads where it is for itself, so that what `sweepWith` was told cannot be what lets it
 * through; and then says the three facts that matter most once more, written out rather than
 * shared with the judgement above. A second lock that the same mistake opens is one lock.
 */
function killEveryOtherProcess(workRoot: string): void {
  const problems = sandboxProblems(readSandboxFacts(workRoot));
  if (problems.length > 0) throw new SweepRefusedError(problems);
  if (
    process.platform !== "linux" ||
    process.pid !== 1 ||
    process.getuid?.() !== SANDBOX_UID ||
    process.geteuid?.() !== SANDBOX_UID
  ) {
    throw new SweepRefusedError(["not_the_sandbox"]);
  }
  try {
    process.kill(-1, "SIGKILL");
  } catch (error) {
    // NOBODY ELSE WAS THERE, which is how nearly every run ends: the kernel answers a signal to
    // "everybody" that reached nobody with ESRCH, and the runtime throws it. Measured on the
    // first run of the real service (2026-10-06, the rehearsal on Linux): a script that left
    // nothing behind was reported as a sweep that failed, and the daemon stopped. Whether anything
    // is in fact still running is not decided here — `sweepWith` looks, after this returns.
    if (
      !(error instanceof Error && "code" in error && error.code === "ESRCH")
    ) {
      throw error;
    }
  }
}

/**
 * The sweep the service runs: the real reading of where this process is, the real call, the real
 * listing of what is left. `workRoot` says which mount must be a tmpfs and is all a caller can say.
 */
export function createSweep(workRoot: string): () => Promise<void> {
  return () =>
    sweepWith({
      facts: () => readSandboxFacts(workRoot),
      killAll: () => killEveryOtherProcess(workRoot),
      others: otherProcesses,
    });
}
