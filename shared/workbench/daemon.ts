/**
 * The workbench's daemon: the sidecar a script is handed to, over a unix socket.
 *
 * It runs nothing itself. Each script goes to a fresh child (`./run.ts`) and the daemon answers
 * with how that ended. ONE AT A TIME, and a second request while one runs is refused, not queued:
 * "every other process in this container" is "what this run started" only while there is one run,
 * and that sentence is what the sweep after it stands on (`./sweep.ts`).
 *
 * WHAT A SCRIPT CAN REACH, BEING THE DAEMON'S OWN USER, AND WHAT IS DONE ABOUT EACH.
 *
 *  - The daemon itself, by a signal. It is process 1, which its own namespace cannot stop or kill;
 *    any signal that does land ends it, and the container with it (`./sweep.ts`).
 *  - The daemon's memory. Closed (`./undumpable.ts`), or the daemon does not start.
 *  - The socket. A script can connect to it — and is refused, because a run is in progress — and
 *    it can remove the file or put its own in its place. So after every run the daemon asks
 *    ITSELF, through the path, who answers there: if it is not this process, it stops, and compose
 *    starts a fresh one that binds again.
 *  - The few places besides its own directory that it can write to: the rest of the work root,
 *    the socket's directory, shared memory (`scratch`). Emptied after every run, so that one run
 *    cannot leave the next one a note.
 *  - What it can leave in the kernel rather than in a file — a dead child nobody waited for, a
 *    System V segment. Those only a fresh container clears, so the daemon asks after every run
 *    whether there are any (`worn`) and retires itself when there are.
 *
 * WHEN IN DOUBT IT STOPS. A sweep that refused or left something, a directory that would not go,
 * walls that are no longer what they were: the answer to that request is `laf:workbench_failed`
 * and the process ends. Its work directory is a tmpfs of the container's own, so ending is also
 * the one cleanup that cannot fail.
 *
 * HTTP over a unix socket with Bun's own server, as the converter's daemon is
 * (`server/src/attachments/converter-daemon.ts`); what is said over it is `./protocol.ts`.
 */
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createLogger, type Logger } from "../log";
import {
  type InvalidField,
  isRunPath,
  JOB_PART,
  productPart,
  REPORT_PART,
  SCRIPT_PART,
  WORKBENCH_LIMITS,
  type WorkbenchRefusal,
} from "./protocol";
import {
  emptyDirectory,
  emptyDirectorySync,
  removeTreeSync,
  RunAbandonedError,
  type RunInput,
  type RunJob,
  runScript,
  UnplaceableInputError,
  type WorkbenchLimits,
} from "./run";
import type { Runner } from "./runner";

/** Why the daemon is ending itself. `retired` is housekeeping; everything else is a refusal to go on. */
export type QuitReason =
  | "retired"
  | "not_isolated"
  | "run_failed"
  | "cleanup_failed"
  | "socket_replaced";

export type WorkbenchDaemon = {
  stop(): Promise<void>;
  /**
   * The service's own way out, for a signal it takes: stop listening and take everything beside the
   * socket along, the socket included — synchronously, because the process is ended on the line
   * after. Whatever a run in progress wrote into its work root goes with the container.
   */
  leave(): void;
};

/**
 * Why a daemon would not start: the one place a script's leavings outlive a container could not be
 * made empty. Named, so the loop compose shows says what to look at.
 */
export class DaemonStartError extends Error {
  constructor(
    readonly reason: "socket_directory_unclean" | "work_root_unclean",
  ) {
    super(reason);
    this.name = "DaemonStartError";
  }
}

const refusal = (
  code: WorkbenchRefusal,
  status: number,
  extra: Record<string, string> = {},
) => Response.json({ error: code, code, ...extra }, { status });

const invalid = (field: InvalidField) =>
  refusal("laf:workbench_request_invalid", 400, { field });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What a failure IS, without what it was about. The log's own rendering of an `Error` keeps its
 * message, and a filesystem error's message is the path it failed on — which here holds a name
 * somebody gave a file, or one a script chose. So this log gets the kind of error and its code,
 * and for the sweep's own two failures the facts they carry (which walls, how many survivors).
 */
function failureFacts(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { failure: typeof error };
  return {
    failure: error.name,
    ...("code" in error && typeof error.code === "string"
      ? { code: error.code }
      : {}),
    ...("problems" in error && Array.isArray(error.problems)
      ? { problems: error.problems.map(String) }
      : {}),
    ...("survivors" in error && Array.isArray(error.survivors)
      ? { survivors: error.survivors.length }
      : {}),
  };
}

/** A request's form as a run, or the part of it that is not one. Every bound is held here. */
async function readJob(
  form: FormData,
  limits: WorkbenchLimits,
): Promise<{ job: RunJob } | { field: InvalidField }> {
  const scriptPart = form.get(SCRIPT_PART);
  if (
    !(scriptPart instanceof Blob) ||
    scriptPart.size === 0 ||
    scriptPart.size > limits.scriptBytes
  ) {
    return { field: "script" };
  }
  const raw = form.get(JOB_PART);
  if (typeof raw !== "string") return { field: "job" };
  let job: unknown;
  try {
    job = JSON.parse(raw);
  } catch {
    return { field: "job" };
  }
  if (!isRecord(job) || !Array.isArray(job.files)) return { field: "job" };
  const timeoutMs = job.timeoutMs ?? limits.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > limits.timeoutCeilingMs
  ) {
    return { field: "timeoutMs" };
  }
  if (job.files.length > limits.files) return { field: "files" };
  const files: RunInput[] = [];
  const paths = new Set<string>();
  let together = 0;
  for (const entry of job.files) {
    if (
      !isRecord(entry) ||
      !isRunPath(entry.path) ||
      typeof entry.part !== "string" ||
      paths.has(entry.path)
    ) {
      return { field: "files" };
    }
    paths.add(entry.path);
    const part = form.get(entry.part);
    if (!(part instanceof Blob) || part.size > limits.fileBytes) {
      return { field: "files" };
    }
    together += part.size;
    if (together > limits.filesBytes) return { field: "files" };
    files.push({
      path: entry.path,
      bytes: new Uint8Array(await part.arrayBuffer()),
    });
  }
  return { job: { script: await scriptPart.text(), files, timeoutMs } };
}

/** Listen on `socketPath` and run what arrives. Returned so a test can stop it. */
export function startWorkbenchDaemon(options: {
  socketPath: string;
  /** Where each run's directory is made. A tmpfs of the container's own, in the service. */
  workRoot: string;
  runner: Runner;
  /** What is not as it must be about where this process is, read now. Empty is the sandbox. */
  problems: () => string[];
  /** End every process a run left. The service's is `createSweep` (`./sweep.ts`). */
  sweep: () => Promise<void>;
  /**
   * The places besides `workRoot` that a script can write to, emptied after every run. The
   * socket's own directory is always one of them.
   */
  scratch?: readonly string[];
  /**
   * Whether a run has left something that only a fresh container clears — asked after every run,
   * and a yes retires the daemon once that run is answered. The service's is `isWorn` (`./sweep.ts`).
   */
  worn?: () => boolean;
  memoryOf?: (pid: number) => Promise<number | null>;
  limits?: WorkbenchLimits;
  log?: Logger;
  /** The daemon will take no more runs. The service ends its process on this; called once. */
  quit: (reason: QuitReason) => void;
}): WorkbenchDaemon {
  const log = options.log ?? createLogger("workbench");
  const limits = options.limits ?? WORKBENCH_LIMITS;
  const socketDirectory = dirname(options.socketPath);
  const socketName = basename(options.socketPath);
  // Who this process is, to itself: what `/health` says, and what the daemon looks for when it
  // asks the socket's path who is behind it.
  const boot = randomBytes(12).toString("hex");
  let busy = false;
  let quitting = false;

  /**
   * Stop taking runs, and let the service end once what is being answered has left. A run that
   * ended well and is the daemon's last — it retired, its socket was taken — is still answered in
   * full: the listener closes at once, and the process is ended when the last answer is out, or
   * after a few seconds if nobody is taking it.
   */
  const quit = (reason: QuitReason) => {
    if (quitting) return;
    quitting = true;
    log[reason === "retired" ? "info" : "error"]("workbench_quitting", {
      reason,
    });
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      options.quit(reason);
    };
    const patience = setTimeout(leave, 5_000);
    void Promise.resolve()
      .then(() => server.stop())
      .catch(() => {})
      .then(() => {
        clearTimeout(patience);
        leave();
      });
  };

  /** Whether a request to the socket's path still reaches this process. */
  const answersAtItsPath = async () => {
    try {
      const response = await fetch("http://workbench/health", {
        unix: options.socketPath,
        signal: AbortSignal.timeout(2_000),
      });
      const body: unknown = await response.json();
      return isRecord(body) && body.boot === boot;
    } catch {
      return false;
    }
  };

  /**
   * What is done after every run that started, however it ended: every place a script could have
   * written is emptied — its own directory is already gone, and this is the rest of the work root,
   * which was its user's to write anywhere in. The two directories that are this user's own are
   * taken back first: a script may have closed them, and a socket directory left closed would
   * keep the next daemon from binding for as long as the volume lived.
   */
  const afterRun = async () => {
    try {
      for (const own of [options.workRoot, socketDirectory]) {
        await chmod(own, 0o700).catch(() => {});
      }
      await emptyDirectory(options.workRoot);
      // The socket's NAME is kept only while a socket is what it names: a script can put a file or
      // a whole directory there, and that is removed like anything else it left.
      const there = lstatSync(options.socketPath, { throwIfNoEntry: false });
      await emptyDirectory(
        socketDirectory,
        there?.isSocket() ? [socketName] : [],
      );
      for (const place of options.scratch ?? []) await emptyDirectory(place);
    } catch (error) {
      log.error("workbench_cleanup_failed", failureFacts(error));
      quit("cleanup_failed");
      return;
    }
    if (!(await answersAtItsPath())) {
      quit("socket_replaced");
      return;
    }
    if (options.worn?.()) quit("retired");
  };

  const run = async (request: Request): Promise<Response> => {
    const problems = options.problems();
    if (problems.length > 0) {
      log.error("workbench_not_isolated", { problems });
      quit("not_isolated");
      return refusal("laf:workbench_not_isolated", 503);
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return invalid("job");
    }
    const read = await readJob(form, limits);
    if ("field" in read) return invalid(read.field);
    const { job } = read;
    try {
      const outcome = await runScript(job, {
        workRoot: options.workRoot,
        runner: options.runner,
        limits,
        sweep: options.sweep,
        ...(options.memoryOf ? { memoryOf: options.memoryOf } : {}),
        signal: request.signal,
      });
      await afterRun();
      const { report } = outcome;
      // Facts only: never a path, a name, or a word of what a script said.
      log.info("workbench_run", {
        ending: report.ending,
        exitCode: report.exitCode,
        ms: report.ms,
        scriptBytes: Buffer.byteLength(job.script),
        files: job.files.length,
        products: report.products.length,
        ...(report.productsRefused
          ? { productsRefused: report.productsRefused }
          : {}),
        stdoutBytes: report.stdoutBytes,
        stderrBytes: report.stderrBytes,
      });
      const answer = new FormData();
      answer.set(REPORT_PART, JSON.stringify(report));
      outcome.products.forEach((bytes, index) => {
        answer.set(productPart(index), new Blob([bytes]));
      });
      return new Response(answer);
    } catch (error) {
      if (error instanceof UnplaceableInputError) return invalid("files");
      if (error instanceof RunAbandonedError) {
        await afterRun();
        log.info("workbench_run", { ending: "abandoned" });
        // Nobody is there to read this.
        return new Response(null, { status: 499 });
      }
      // The run may have left something behind, and nothing here can say it did not.
      log.error("workbench_run_failed", failureFacts(error));
      quit("run_failed");
      return refusal("laf:workbench_failed", 500);
    }
  };

  /*
   * A DAEMON STARTS WITH NOTHING BESIDE ITS SOCKET, WHATEVER IS THERE. The socket's volume is the
   * one place a script can write that outlives the container (the server mounts it too), and the
   * daemon does not always get to clean up after a run: a script can end process 1 with a signal
   * it takes, and the engine can end it for memory. So everything in that directory is a previous
   * life's — a stale socket, a note for the next run, a directory where the socket belongs, all of
   * it closed to its own user — and goes before anything is bound.
   *
   * Until 2026-10-06 this was `rmSync(socketPath, { force: true })`, which removes a file. A
   * script that left a DIRECTORY there was answered once, the daemon stopped as it should, and
   * every daemon compose started after it threw on that line — a loop that only removing the
   * volume by hand would have ended (the independent read; reproduced in
   * `tests/workbench-daemon.test.ts`). The work root is emptied the same way: in the service it is
   * a tmpfs as new as the container, and elsewhere it costs a listing.
   */
  for (const [place, reason] of [
    [socketDirectory, "socket_directory_unclean"],
    [options.workRoot, "work_root_unclean"],
  ] as const) {
    try {
      emptyDirectorySync(place);
    } catch {
      throw new DaemonStartError(reason);
    }
  }
  const server = Bun.serve({
    unix: options.socketPath,
    // The files, the script, and room for the form around them. Bun refuses more by itself.
    maxRequestBodySize: limits.filesBytes + limits.scriptBytes + 64 * 1024,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") {
        return Response.json({ status: "ok", busy, boot });
      }
      if (url.pathname !== "/run" || request.method !== "POST") {
        return refusal("laf:workbench_route_unknown", 404);
      }
      if (busy || quitting) return refusal("laf:workbench_busy", 503);
      busy = true;
      try {
        return await run(request);
      } finally {
        busy = false;
      }
    },
    error() {
      return refusal("laf:workbench_failed", 500);
    },
  });

  return {
    async stop() {
      await server.stop(true);
      removeTreeSync(options.socketPath);
    },
    leave() {
      quitting = true;
      void server.stop(true);
      try {
        emptyDirectorySync(socketDirectory);
      } catch {
        // The next daemon empties it before it binds, or says it could not.
      }
    },
  };
}
