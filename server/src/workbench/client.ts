/**
 * The API server's side of the workbench: hand it a script and the bytes it may read, get back how
 * the script ended, what it printed and the bytes of the files it made.
 *
 * NOTHING CALLS THIS YET. No tool, no gateway act, no turn: it is the pipe, laid before anything
 * is connected to it, so that the walls on the other end can be read and measured alone
 * (`shared/workbench/`, the `workbench` service in `docker-compose.yml`). What uses it today is its
 * own tests and the rehearsal that drives the real service (`scripts/workbench-probe.ts`).
 *
 * WHAT A CALLER OWES, since nothing here can check it: the bytes in `files` are whatever the caller
 * read, and reading a Bot's file for a Bot is the gateway's to judge and record. This sends what it
 * is given to a place with no network and brings back what that place answers.
 *
 * THE ANSWER IS READ AS UNTRUSTED AS THE SCRIPT. The daemon is on the far side of the wall, in the
 * one container where a stranger's code runs as the daemon's own user. So every field of its
 * report is checked for its type and against the same bounds the daemon was meant to hold, a
 * file's name is checked again here, and a report that says one thing while its parts say another
 * is `malformed` — never passed on in part.
 *
 * ONE RUN AT A TIME, FROM THIS SIDE TOO. The daemon refuses a second run while one is in progress;
 * this queues a few behind the one in flight so that two callers in one process do not meet that
 * refusal, and so that no request of this server's is ever on its way to the socket while a
 * script — which can reach the socket's file — is running.
 */
import type { Logger } from "../../../shared/log";
import {
  filePart,
  type InvalidField,
  isProductName,
  isRunPath,
  JOB_PART,
  type Job,
  type ProductsRefusal,
  REPORT_PART,
  type RunEnding,
  type RunReport,
  SCRIPT_PART,
  WORKBENCH_LIMITS,
} from "../../../shared/workbench/protocol";

/**
 * Why there is no run to report.
 *
 * - `unavailable` — nothing answers at the socket: the service is not running here.
 * - `busy` — it is running something, and enough is already waiting behind that.
 * - `invalid` — the request is not one the service takes; `field` says which part.
 * - `stopped` — the caller gave up, and the run was ended.
 * - `not_isolated` — the service found itself outside its walls and ran nothing.
 * - `failed` — the service could not vouch for the run, or went away during it.
 * - `malformed` — it answered, and the answer is not one this side will pass on.
 */
export type WorkbenchFailure =
  | "unavailable"
  | "busy"
  | "invalid"
  | "stopped"
  | "not_isolated"
  | "failed"
  | "malformed";

export type WorkbenchFile = { path: string; bytes: Uint8Array };
export type WorkbenchProduct = { name: string; bytes: Uint8Array<ArrayBuffer> };
export type WorkbenchRequest = {
  script: string;
  files: readonly WorkbenchFile[];
  timeoutMs?: number;
};

/** How a run ended: the daemon's report, with the files it names held beside it as bytes. */
export type WorkbenchRun = Omit<RunReport, "products">;

export type WorkbenchAnswer =
  | { ok: true; run: WorkbenchRun; products: WorkbenchProduct[] }
  | { ok: false; failure: WorkbenchFailure; field?: InvalidField };

export type Workbench = {
  /** Whether the service answers, and whether it is running something. Null when it does not. */
  health(): Promise<{ busy: boolean } | null>;
  run(
    request: WorkbenchRequest,
    signal?: AbortSignal,
  ): Promise<WorkbenchAnswer>;
};

type Limits = { [Bound in keyof typeof WORKBENCH_LIMITS]: number };

/** Runs that may wait behind the one in flight. Past it a caller is told `busy` at once. */
const WAITING = 4;

/**
 * What the daemon needs beyond the script's own time: the files across the socket, the sweep, the
 * files back, its directory removed. Past the script's bound plus this, the daemon is not well.
 */
const MARGIN_MS = 10_000;

const ENDINGS: ReadonlySet<unknown> = new Set<RunEnding>([
  "exited",
  "timed_out",
  "out_of_memory",
]);
const PRODUCT_REFUSALS: ReadonlySet<unknown> = new Set<ProductsRefusal>([
  "too_many",
  "too_large",
  "too_large_together",
]);
const FIELDS: ReadonlySet<unknown> = new Set<InvalidField>([
  "job",
  "script",
  "files",
  "timeoutMs",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The part of a request the daemon would refuse, found before anything is sent. */
function wrongPartOf(
  request: WorkbenchRequest,
  limits: Limits,
): InvalidField | null {
  const scriptBytes = Buffer.byteLength(request.script);
  if (scriptBytes === 0 || scriptBytes > limits.scriptBytes) return "script";
  if (
    request.timeoutMs !== undefined &&
    (!Number.isInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > limits.timeoutCeilingMs)
  ) {
    return "timeoutMs";
  }
  if (request.files.length > limits.files) return "files";
  const paths = new Set<string>();
  let together = 0;
  for (const file of request.files) {
    if (!isRunPath(file.path) || paths.has(file.path)) return "files";
    paths.add(file.path);
    if (file.bytes.byteLength > limits.fileBytes) return "files";
    together += file.bytes.byteLength;
  }
  return together > limits.filesBytes ? "files" : null;
}

/** The daemon's report and its parts as a run, or null when any of it is not what it must be. */
async function runFrom(
  answer: FormData,
  limits: Limits,
): Promise<Extract<WorkbenchAnswer, { ok: true }> | null> {
  const raw = answer.get(REPORT_PART);
  if (typeof raw !== "string") return null;
  let report: unknown;
  try {
    report = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(report)) return null;
  const { ending, exitCode, signal, stdout, stderr, productsRefused } = report;
  if (!ENDINGS.has(ending)) return null;
  if (exitCode !== null && !Number.isInteger(exitCode)) return null;
  if (signal !== null && typeof signal !== "string") return null;
  if (
    !isCount(report.ms) ||
    !isCount(report.stdoutBytes) ||
    !isCount(report.stderrBytes) ||
    !isCount(report.skipped)
  ) {
    return null;
  }
  // Kept text is at most `streamBytes` bytes, and no character is less than a byte.
  if (typeof stdout !== "string" || stdout.length > limits.streamBytes) {
    return null;
  }
  if (typeof stderr !== "string" || stderr.length > limits.streamBytes) {
    return null;
  }
  if (productsRefused !== undefined && !PRODUCT_REFUSALS.has(productsRefused)) {
    return null;
  }
  if (!Array.isArray(report.products)) return null;
  if (report.products.length > limits.products) return null;
  // Files come back from a script that ended by itself with 0, and from no other.
  const mayHandBack = ending === "exited" && exitCode === 0;
  if (!mayHandBack && (report.products.length > 0 || productsRefused)) {
    return null;
  }
  if (productsRefused && report.products.length > 0) return null;
  const products: WorkbenchProduct[] = [];
  const names = new Set<string>();
  let together = 0;
  for (const product of report.products) {
    if (!isRecord(product) || typeof product.part !== "string") return null;
    const { name, bytes } = product;
    if (!isProductName(name) || names.has(name)) return null;
    names.add(name);
    if (!isCount(bytes) || bytes > limits.productBytes) return null;
    together += bytes;
    if (together > limits.productsBytes) return null;
    const part = answer.get(product.part);
    // What the report says a file is, and what arrived, are the same size or neither is believed.
    if (!(part instanceof Blob) || part.size !== bytes) return null;
    products.push({ name, bytes: new Uint8Array(await part.arrayBuffer()) });
  }
  return {
    ok: true,
    run: {
      ending: ending as RunEnding,
      exitCode: exitCode as number | null,
      signal: signal as string | null,
      ms: report.ms,
      stdout,
      stderr,
      stdoutBytes: report.stdoutBytes,
      stderrBytes: report.stderrBytes,
      ...(productsRefused
        ? { productsRefused: productsRefused as ProductsRefusal }
        : {}),
      skipped: report.skipped,
    },
    products,
  };
}

/** What a refusal's body says, as this side's word for it. */
async function failureFrom(
  response: Response,
): Promise<Extract<WorkbenchAnswer, { ok: false }>> {
  const body: unknown = await response.json().catch(() => null);
  const code = isRecord(body) ? body.code : null;
  if (code === "laf:workbench_busy") return { ok: false, failure: "busy" };
  if (code === "laf:workbench_not_isolated") {
    return { ok: false, failure: "not_isolated" };
  }
  if (code === "laf:workbench_request_invalid" && isRecord(body)) {
    return {
      ok: false,
      failure: "invalid",
      ...(FIELDS.has(body.field) ? { field: body.field as InvalidField } : {}),
    };
  }
  // Bun's own answer to a body over the daemon's bound, before the daemon saw it.
  if (response.status === 413) {
    return { ok: false, failure: "invalid", field: "files" };
  }
  return { ok: false, failure: "failed" };
}

/** Whether a failed request never reached anybody: no socket there, or nobody behind it. */
function neverConnected(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const said = `${error.name} ${"code" in error ? String(error.code) : ""}`;
  return /FailedToOpenSocket|ConnectionRefused|ECONNREFUSED|ENOENT/.test(said);
}

export function createWorkbench(options: {
  /** The service's socket (`/run/laf-workbench/workbench.sock` in a deployment). */
  socketPath: string;
  /**
   * Where a refusal or an answer that could not be believed is written: the log of whoever holds
   * this client. Handed in rather than imported, so that the rehearsal can hold one without
   * becoming the server (`../log` reports this process's crashes as the server's).
   */
  log: Logger;
  /** The bounds a request is held to before it is sent. A test makes them small. */
  limits?: Limits;
  /** See `MARGIN_MS`. A test shortens it. */
  marginMs?: number;
}): Workbench {
  const { socketPath, log } = options;
  const limits = options.limits ?? WORKBENCH_LIMITS;
  const marginMs = options.marginMs ?? MARGIN_MS;
  /** The run in flight and those behind it. */
  let held = 0;
  let last: Promise<unknown> = Promise.resolve();

  const send = async (
    request: WorkbenchRequest,
    signal: AbortSignal | undefined,
  ): Promise<WorkbenchAnswer> => {
    if (signal?.aborted) return { ok: false, failure: "stopped" };
    const form = new FormData();
    const job: Job = {
      ...(request.timeoutMs === undefined
        ? {}
        : { timeoutMs: request.timeoutMs }),
      files: request.files.map((file, index) => ({
        path: file.path,
        part: filePart(index),
      })),
    };
    form.set(JOB_PART, JSON.stringify(job));
    form.set(SCRIPT_PART, new Blob([request.script]));
    request.files.forEach((file, index) => {
      // A copy on a plain ArrayBuffer: the part's type wants one.
      form.set(filePart(index), new Blob([new Uint8Array(file.bytes)]));
    });
    const bound = AbortSignal.timeout(
      (request.timeoutMs ?? limits.timeoutMs) + marginMs,
    );
    let response: Response;
    try {
      response = await fetch("http://workbench/run", {
        method: "POST",
        unix: socketPath,
        body: form,
        signal: signal ? AbortSignal.any([signal, bound]) : bound,
      });
    } catch (error) {
      if (signal?.aborted) return { ok: false, failure: "stopped" };
      const failure = neverConnected(error) ? "unavailable" : "failed";
      log.warn("workbench_unreachable", {
        failure,
        reason: error instanceof Error ? error.name : "unknown",
      });
      return { ok: false, failure };
    }
    if (!response.ok) {
      const refused = await failureFrom(response);
      log.warn("workbench_refused", {
        status: response.status,
        failure: refused.failure,
      });
      return refused;
    }
    const answer = await response.formData().catch(() => null);
    const run = answer ? await runFrom(answer, limits) : null;
    if (!run) {
      log.warn("workbench_answer_malformed", {});
      return { ok: false, failure: "malformed" };
    }
    return run;
  };

  return {
    async health() {
      try {
        const response = await fetch("http://workbench/health", {
          unix: socketPath,
          signal: AbortSignal.timeout(2_000),
        });
        const body: unknown = await response.json();
        return response.ok &&
          isRecord(body) &&
          body.status === "ok" &&
          typeof body.busy === "boolean"
          ? { busy: body.busy }
          : null;
      } catch {
        return null;
      }
    },
    run(request, signal) {
      const wrong = wrongPartOf(request, limits);
      if (wrong) {
        return Promise.resolve({ ok: false, failure: "invalid", field: wrong });
      }
      if (held > WAITING)
        return Promise.resolve({ ok: false, failure: "busy" });
      held += 1;
      const mine = last.then(async () => {
        try {
          return await send(request, signal);
        } finally {
          held -= 1;
        }
      });
      last = mine.catch(() => undefined);
      return mine;
    },
  };
}
