/**
 * The workbench service's entry: `bun /app/shared/workbench/main.ts --socket <path>`, as
 * `docker-compose.yml` starts it (`workbench`).
 *
 * FROM SOURCE, AND FROM `shared/`. Every other service runs a bundle its own Dockerfile built.
 * This one runs these few files as they are, and they import nothing but Bun, node's built-ins and
 * their neighbours in `shared/` (`tests/workbench-sweep.test.ts` holds them to it) — so the
 * service starts from ANY image that carries `shared/` and a Bun, which today is both the server's
 * and the computer's. Which of them it runs in is then one line of compose, and the language a
 * script is written in is `./runner.ts`.
 *
 * THERE IS NO FLAG THAT SKIPS THE CHECK. The converter's `--require-isolation` is a switch because
 * a laptop reads files in a child process without it; nothing here is worth running outside its
 * walls, and the sweep would refuse there whatever a flag said (`./sweep.ts`). So this file is
 * never started on a machine anybody works on, by a test or by hand: outside the container it
 * logs `workbench_not_isolated` and exits.
 */
import { dirname } from "node:path";
import { createLogger, reportCrashes } from "../log";
import {
  DaemonStartError,
  type QuitReason,
  startWorkbenchDaemon,
  type WorkbenchDaemon,
} from "./daemon";
import { WORKBENCH_LIMITS } from "./protocol";
import { RUNNER } from "./runner";
import {
  createSweep,
  isUndumpable,
  isWorn,
  otherProcesses,
  ptraceScope,
  readSandboxFacts,
  residentBytesOf,
  sandboxProblems,
} from "./sweep";
import { makeUndumpable } from "./undumpable";

/** The tmpfs compose mounts for the runs' directories. */
const WORK_ROOT = "/work";

/**
 * What a script can write to besides its own directory and the socket's: the shared-memory mount
 * and the message queues every container is given, both open to any user. Emptied after each run.
 */
const SCRATCH = ["/dev/shm", "/dev/mqueue"];

/**
 * What the whole run holds: every other process in the container, since the container holds
 * nothing but this daemon and one run. Summed generously — pages two processes share are counted
 * for both — which errs on the side of ending a run early.
 */
async function residentBytesOfTheRun(): Promise<number> {
  let total = 0;
  for (const pid of otherProcesses()) total += residentBytesOf(pid);
  return total;
}

async function main(): Promise<void> {
  const log = createLogger("workbench");
  reportCrashes(log);
  const at = process.argv.indexOf("--socket");
  const socketPath = at >= 0 ? process.argv[at + 1] : undefined;
  if (!socketPath) {
    log.error("workbench_refused", { reason: "no_socket" });
    process.exit(1);
  }
  const closed = await makeUndumpable();
  const facts = readSandboxFacts(WORK_ROOT);
  const problems = sandboxProblems(facts);
  if (problems.length > 0) {
    // Restarting into the same place changes nothing, but the loop is what `docker compose ps`
    // shows, and nothing is run meanwhile.
    log.error("workbench_not_isolated", {
      problems,
      uid: facts.uid,
      pid: facts.pid,
    });
    process.exit(1);
  }
  const missing = RUNNER.missing();
  if (missing.length > 0) {
    log.error("workbench_refused", { reason: "runner_incomplete", missing });
    process.exit(1);
  }
  let daemon: WorkbenchDaemon;
  try {
    daemon = startWorkbenchDaemon({
      socketPath,
      workRoot: WORK_ROOT,
      runner: RUNNER,
      problems: () => sandboxProblems(readSandboxFacts(WORK_ROOT)),
      sweep: createSweep(WORK_ROOT),
      scratch: SCRATCH.filter((place) => place !== dirname(socketPath)),
      worn: isWorn,
      memoryOf: residentBytesOfTheRun,
      log,
      quit: (reason: QuitReason) => process.exit(reason === "retired" ? 0 : 1),
    });
  } catch (error) {
    if (!(error instanceof DaemonStartError)) throw error;
    // What a previous life left beside the socket would not go. Not bound, so nothing is served
    // beside it; the loop is what `docker compose ps` shows, and this line says where to look.
    log.error("workbench_refused", { reason: error.reason });
    process.exit(1);
  }
  /*
   * Process 1 is sent only what it has a handler for, and `docker stop` sends this. A script can
   * send it too — it is the daemon's own user — and that ends the container under its own run,
   * with no sweep and nothing emptied. The work root and the processes go with the container; the
   * socket's directory does not, so it is emptied on the way out here and again by whichever
   * daemon starts next (`./daemon.ts`).
   */
  process.on("SIGTERM", () => {
    daemon.leave();
    process.exit(0);
  });
  log.info("workbench_listening", {
    // Which of the two keeps a script out of this process's memory, for whoever reads the log.
    undumpable: closed && isUndumpable() === true,
    ptraceScope: ptraceScope(),
    timeoutMs: WORKBENCH_LIMITS.timeoutMs,
    memoryBytes: WORKBENCH_LIMITS.memoryBytes,
  });
}

if (import.meta.main) void main();
