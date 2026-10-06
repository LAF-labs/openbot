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
 * AND IT IS READ NO FURTHER THAN IT MAY BE LONG. Every lie the tests told at first was a lie of
 * shape; the independent read of 2026-10-06 pointed out that none was a lie of SIZE, and that the
 * answer was held whole (`formData()`, `json()`) before any of it was looked at. Measured then: a
 * fake that never stopped sending had 77 MB taken from it in the three seconds a short run is
 * given — by the API server, the one process on the VM. So every body is read in pieces against a
 * bound and let go of one piece past it (`bodyWithin`), as a file from the computer is
 * (`computer/client.ts`, `bytesWithin`), and only then parsed. And A REDIRECT IS AN ERROR: followed,
 * as it was — measured the same day, a 301 off the socket was followed to a TCP port and that
 * port's answer was passed on as the run — it is this server, which has a network, sent wherever
 * the far side of the wall says, with the files in hand on a 307.
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

/** A signal's name as the runtime says one (`SIGKILL`), and nothing longer or stranger. */
const SIGNAL_NAME = /^SIG[A-Z0-9]{2,10}$/;

/** A refusal's body and `/health`'s are a line of JSON. This is room for it and for nothing else. */
const SMALL_ANSWER_BYTES = 8 * 1024;

/**
 * The most a run's answer may be: the files, the report — two streams whose every kept byte may be
 * written as a six-character escape — and the form around them.
 */
const answerBytes = (limits: Limits): number =>
  limits.productsBytes + 12 * limits.streamBytes + 64 * 1024;

/**
 * A body, read no further than `most` bytes: in pieces, and let go of one piece past the bound.
 * Null when it was longer — nothing of it is kept — or when it broke off.
 *
 * LETTING GO IS HANGING UP (`hangUp`), not only ceasing to read. Measured 2026-10-06: with the
 * reader cancelled and the request left open, a fake that never stopped sending went on being
 * taken from — the runtime drains what it no longer hands on. Ending the request itself is what
 * stops the far side being read.
 */
async function bodyWithin(
  response: Response,
  most: number,
  hangUp: () => void,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const pieces: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > most) {
        hangUp();
        await reader.cancel().catch(() => undefined);
        return null;
      }
      pieces.push(value);
    }
  } catch {
    return null;
  }
  const whole = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    whole.set(piece, at);
    at += piece.byteLength;
  }
  return whole;
}

/** A small JSON answer, or null when it was not small or not JSON. */
async function smallJson(
  response: Response,
  hangUp: () => void,
): Promise<unknown> {
  const bytes = await bodyWithin(response, SMALL_ANSWER_BYTES, hangUp);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

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
  if (
    signal !== null &&
    !(typeof signal === "string" && SIGNAL_NAME.test(signal))
  ) {
    return null;
  }
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
  hangUp: () => void,
): Promise<Extract<WorkbenchAnswer, { ok: false }>> {
  const body = await smallJson(response, hangUp);
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
    // This side's own way of ending the request, for an answer that runs past its bound.
    const own = new AbortController();
    const hangUp = () => own.abort();
    let response: Response;
    try {
      response = await fetch("http://workbench/run", {
        method: "POST",
        unix: socketPath,
        body: form,
        redirect: "error",
        signal: AbortSignal.any([
          own.signal,
          bound,
          ...(signal ? [signal] : []),
        ]),
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
      const refused = await failureFrom(response, hangUp);
      log.warn("workbench_refused", {
        status: response.status,
        failure: refused.failure,
      });
      return refused;
    }
    // Read to the bound first, parsed second: a form is parsed from bytes this side already holds.
    const bytes = await bodyWithin(response, answerBytes(limits), hangUp);
    if (signal?.aborted) return { ok: false, failure: "stopped" };
    const answer = bytes
      ? await new Response(bytes, {
          headers: {
            "content-type": response.headers.get("content-type") ?? "",
          },
        })
          .formData()
          .catch(() => null)
      : null;
    const run = answer ? await runFrom(answer, limits) : null;
    if (!run) {
      log.warn("workbench_answer_malformed", { tooLong: bytes === null });
      return { ok: false, failure: "malformed" };
    }
    return run;
  };

  return {
    async health() {
      try {
        const own = new AbortController();
        const response = await fetch("http://workbench/health", {
          unix: socketPath,
          redirect: "error",
          signal: AbortSignal.any([own.signal, AbortSignal.timeout(2_000)]),
        });
        const body = await smallJson(response, () => own.abort());
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
      const stopped: WorkbenchAnswer = { ok: false, failure: "stopped" };
      if (signal?.aborted) return Promise.resolve(stopped);
      held += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        held -= 1;
      };
      /** Whether this run's turn has come. Before it, giving up is leaving a queue; after, ending a run. */
      let begun = false;
      let gone = false;
      const mine = last.then(async () => {
        begun = true;
        try {
          return gone ? stopped : await send(request, signal);
        } finally {
          release();
        }
      });
      last = mine.catch(() => undefined);
      if (!signal) return mine;
      /*
       * A caller that gives up while it WAITS is told now and gives its place back now — not when
       * the run ahead of it ends, which is when it used to learn it (2026-10-06: 602 ms behind a
       * 600 ms run). Its turn still comes and sends nothing. Once its run has begun, giving up is
       * the request's own signal's business: the daemon ends the script and `send` says `stopped`.
       */
      return new Promise<WorkbenchAnswer>((resolve, reject) => {
        const onAbort = () => {
          if (begun) return;
          gone = true;
          release();
          resolve(stopped);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        mine.then(resolve, reject).finally(() => {
          signal.removeEventListener("abort", onAbort);
        });
      });
    },
  };
}
