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
 * AND WHAT IT SAYS ITS ANSWER IS, IS NOT TAKEN FROM IT. Two headers are the far side's to write and
 * decide what becomes of the bytes: `Content-Encoding`, which the runtime obeys by inflating inside
 * `fetch`, before the bound above has counted anything, and `Content-Type`, which picks the parser.
 * The second independent read measured both on this client (2026-10-06): 1.6 kB of brotli grew the
 * API server by 1.2 GB for three seconds, and thirteen megabytes called a url-encoded form by
 * 0.7 GB. So no encoding is asked for, the runtime is told to inflate nothing, and an answer that
 * names one is refused unread; a run is read only out of `multipart/form-data`, a refusal and
 * `/health` only out of JSON; and a form is looked over as bytes before it is parsed — no more
 * parts than a run can have, no part with more header than a part has — and holds no part its
 * report does not name.
 *
 * NOTHING IS BELIEVED WITHOUT ITS PROOF, AND NOTHING IS SENT BEFORE ONE. A script can put a listener
 * of its own where the daemon's socket was (`shared/workbench/protocol.ts`, "WHO ANSWERS AT THE
 * SOCKET'S PATH" — measured on the service: this client's `health()` was answered by a script, and
 * the run waiting behind one that was given up on was handed, script and file, to what that one
 * had left running). So every request carries a number used once, and an answer is believed only
 * with the daemon's proof over that number and its own bytes, checked before anything is parsed —
 * a run, a refusal and `/health` alike. And BEFORE A RUN IS SENT the path is asked who is there
 * and whether it is running anything: only a proven "idle" lets the script and the files go. The
 * daemon says busy until everything the run before started has been ended and cleared up after,
 * so that one answer is also what keeps the run behind an abandoned one from leaving while what
 * the abandoned one left is still alive to receive it. Between that answer and the run it lets go
 * nothing else can start a script: a script cannot — the daemon runs one at a time and they are
 * all ended — and this process is the deployment's one sender (one API server process per
 * deployment, `docs/laf/deployment-model.md`). A second sender would have to be told of the first.
 *
 * ONE RUN AT A TIME, FROM THIS SIDE TOO. The daemon refuses a second run while one is in progress;
 * this queues a few behind the one in flight so that two callers in one process do not meet that
 * refusal.
 */
import type { Logger } from "../../../shared/log";
import {
  filePart,
  type InvalidField,
  isProductName,
  isProven,
  isRunPath,
  JOB_PART,
  type Job,
  NONCE_HEADER,
  newNonce,
  PROOF_HEADER,
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
 * - `unavailable` — nothing answers at the socket, or what answers cannot prove it is the
 *   service: the service is not there to be sent anything.
 * - `busy` — it is running something, and enough is already waiting behind that; or it is still
 *   clearing up after a run and did not finish in the time it is given.
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
  /**
   * Whether the service answers — provably the service — whether it is running something, and the
   * name its daemon gave itself at start (another name is another daemon). Null when nothing
   * answers, or what answers cannot prove it is the service.
   */
  health(): Promise<{ busy: boolean; boot: string } | null>;
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
 * The same is what it is given to finish clearing up after the run before, when a run finds it
 * still busy with that.
 */
const MARGIN_MS = 10_000;

/** How long the daemon's own name may be: it is twenty-four characters of hex. */
const BOOT_LENGTH = 64;

/** What answers at the socket's path, asked to prove itself. */
type Knocked =
  /** The daemon, by its proof, and what it says of itself. */
  | { kind: "daemon"; busy: boolean; boot: string }
  /** Nothing: no socket there, or nobody behind it. */
  | { kind: "nobody" }
  /** Something that did not prove it is the daemon. */
  | { kind: "unproven" };

/** Wait `ms`, or until the caller gives up. */
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

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

/** What every request says of encodings: none. The runtime is told not to undo one either. */
const PLAIN = { "accept-encoding": "identity" } as const;

/** Whether an answer names an encoding. Any name is a lie: none was asked for, `identity` included. */
const isEncoded = (response: Response) =>
  response.headers.has("content-encoding");

/** A refusal's and `/health`'s type, as the daemon's runtime writes it. */
const JSON_TYPE = /^application\/json(?:;\s*charset=utf-8)?$/i;

const isJsonType = (type: string) => JSON_TYPE.test(type);

/**
 * A run's answer's type, with the line between its parts: seventy characters at most, of the ones
 * a boundary may be made of (RFC 2046) and none that means something to a pattern or a header.
 */
const FORM_TYPE =
  /^multipart\/form-data;\s*boundary=([0-9A-Za-z'()+_,.:=?-]{1,70})$/i;

/**
 * The most a part's own header lines may come to. The daemon's are a name and a type, a hundred
 * bytes or so; nothing a part is called here is longer than `product7`.
 */
const PART_HEADER_BYTES = 512;

/**
 * Whether a form's bytes are no more than `most` parts, each with a header that is short, and
 * closed — looked over as bytes, before anything is asked to parse them.
 *
 * The bound on an answer's length is not a bound on what a parser makes of it: thirteen megabytes
 * are two hundred thousand parts, or one part with thirteen megabytes of header. A line between
 * parts is found wherever its bytes are, which is how the parser finds one too.
 */
function isModestForm(
  bytes: Uint8Array<ArrayBuffer>,
  boundary: string,
  most: number,
): boolean {
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const line = Buffer.from(`--${boundary}`);
  let parts = 0;
  let at = body.indexOf(line);
  while (at !== -1) {
    const after = at + line.byteLength;
    // `--boundary--`: the form's end.
    if (body[after] === 0x2d && body[after + 1] === 0x2d) return true;
    parts += 1;
    if (parts > most) return false;
    const headersEnd = body.indexOf("\r\n\r\n", after);
    if (headersEnd === -1 || headersEnd - after > PART_HEADER_BYTES) {
      return false;
    }
    at = body.indexOf(line, headersEnd + 4);
  }
  return false;
}

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

/** Why an answer is not believed: what it said it was, how long it was, or that it proved nothing. */
type Disbelief = "encoded" | "type" | "too_long" | "unproven";

/**
 * An answer's bytes, once everything about it has been held to what it must be — in the order that
 * costs least: what it says it is, how long it is, and then, over the very bytes and before any
 * parser sees them, its proof. Otherwise the name of what was wrong with it.
 */
async function believed(
  key: string,
  asked: { route: string; nonce: string },
  response: Response,
  most: number,
  isType: (type: string) => boolean,
  hangUp: () => void,
): Promise<Uint8Array<ArrayBuffer> | Disbelief> {
  if (isEncoded(response)) {
    hangUp();
    return "encoded";
  }
  const type = response.headers.get("content-type") ?? "";
  if (!isType(type)) {
    hangUp();
    return "type";
  }
  const bytes = await bodyWithin(response, most, hangUp);
  if (!bytes) return "too_long";
  const proven = isProven(
    key,
    { ...asked, status: response.status, type, body: bytes },
    response.headers.get(PROOF_HEADER),
  );
  return proven ? bytes : "unproven";
}

/** Bytes that were believed, as the JSON they are; null when they are not JSON. */
function jsonOf(bytes: Uint8Array): unknown {
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
  // The report and the parts it names, each once, and nothing else: a part nobody named is not
  // ignored, it is an answer that says one thing and holds another.
  const named = new Set<unknown>(
    report.products.map((product: unknown) =>
      isRecord(product) ? product.part : null,
    ),
  );
  const held = [...answer.keys()];
  if (
    held.length !== 1 + named.size ||
    named.size !== report.products.length ||
    held.some((name) => name !== REPORT_PART && !named.has(name))
  ) {
    return null;
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

/** What a refusal's body — believed already — says, as this side's word for it. */
function failureFrom(body: unknown): Extract<WorkbenchAnswer, { ok: false }> {
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
   * What the daemon proves its answers under: the deployment's `WORKBENCH_KEY`, the same value the
   * service was started with. It is never sent, and never logged.
   */
  key: string;
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
  const { socketPath, key, log } = options;
  const limits = options.limits ?? WORKBENCH_LIMITS;
  const marginMs = options.marginMs ?? MARGIN_MS;

  /** Ask the path who is there. Believed only with a proof, like everything else it answers. */
  const knock = async (signal?: AbortSignal): Promise<Knocked> => {
    const asked = { route: "GET /health", nonce: newNonce() };
    const own = new AbortController();
    try {
      const response = await fetch("http://workbench/health", {
        unix: socketPath,
        headers: { ...PLAIN, [NONCE_HEADER]: asked.nonce },
        decompress: false,
        redirect: "error",
        signal: AbortSignal.any([
          own.signal,
          AbortSignal.timeout(2_000),
          ...(signal ? [signal] : []),
        ]),
      });
      const bytes = await believed(
        key,
        asked,
        response,
        SMALL_ANSWER_BYTES,
        isJsonType,
        () => own.abort(),
      );
      if (typeof bytes === "string" || !response.ok)
        return { kind: "unproven" };
      const body = jsonOf(bytes);
      return isRecord(body) &&
        body.status === "ok" &&
        typeof body.busy === "boolean" &&
        typeof body.boot === "string" &&
        body.boot.length <= BOOT_LENGTH
        ? { kind: "daemon", busy: body.busy, boot: body.boot }
        : { kind: "unproven" };
    } catch (error) {
      return neverConnected(error) ? { kind: "nobody" } : { kind: "unproven" };
    }
  };

  /**
   * Wait for the daemon, proven, to say it is running nothing — or say why a run cannot be sent.
   *
   * Nothing there is `unavailable` at once: a deployment without the service must not make every
   * caller wait. Something there that is busy, or that cannot prove itself, is asked again for as
   * long as the daemon is given to clear up after a run: busy is what it says while it ends what a
   * run that was given up on had started, and unproven is what such a thing looks like from here
   * until it has been ended.
   */
  const idle = async (
    signal: AbortSignal | undefined,
  ): Promise<WorkbenchFailure | null> => {
    const patience = performance.now() + marginMs;
    for (let wait = 20; ; wait = Math.min(wait * 2, 250)) {
      if (signal?.aborted) return "stopped";
      const there = await knock(signal);
      if (signal?.aborted) return "stopped";
      if (there.kind === "daemon" && !there.busy) return null;
      if (there.kind === "nobody") {
        log.warn("workbench_unreachable", {
          failure: "unavailable",
          reason: "nobody",
        });
        return "unavailable";
      }
      if (performance.now() >= patience) {
        const failure = there.kind === "daemon" ? "busy" : "unavailable";
        log.warn("workbench_unreachable", { failure, reason: there.kind });
        return failure;
      }
      await pause(wait, signal);
    }
  };
  /** The run in flight and those behind it. */
  let held = 0;
  let last: Promise<unknown> = Promise.resolve();

  const send = async (
    request: WorkbenchRequest,
    signal: AbortSignal | undefined,
  ): Promise<WorkbenchAnswer> => {
    if (signal?.aborted) return { ok: false, failure: "stopped" };
    // Who is there, proven, and that it is running nothing — before a byte of the run leaves.
    const cannot = await idle(signal);
    if (cannot) return { ok: false, failure: cannot };
    const asked = { route: "POST /run", nonce: newNonce() };
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
        headers: { ...PLAIN, [NONCE_HEADER]: asked.nonce },
        decompress: false,
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
      /*
       * A refusal is the daemon's word only with its proof, like anything else. One without —
       * the runtime's own 413 for a body over the daemon's bound is one, sent before the daemon
       * saw the request — says only that there was no run.
       */
      const refusal = await believed(
        key,
        asked,
        response,
        SMALL_ANSWER_BYTES,
        isJsonType,
        hangUp,
      );
      const refused: Extract<WorkbenchAnswer, { ok: false }> =
        typeof refusal === "string"
          ? { ok: false, failure: "failed" }
          : failureFrom(jsonOf(refusal));
      log.warn("workbench_refused", {
        status: response.status,
        failure: refused.failure,
        ...(typeof refusal === "string" ? { disbelieved: refusal } : {}),
      });
      return refused;
    }
    /** Not an answer this side passes on, and why — by a name, never by anything it held. */
    const malformed = (
      reason:
        | "encoded"
        | "not_a_form"
        | "too_long"
        | "unproven"
        | "form"
        | "report",
    ): WorkbenchAnswer => {
      log.warn("workbench_answer_malformed", { reason });
      return { ok: false, failure: "malformed" };
    };
    const type = response.headers.get("content-type") ?? "";
    const boundary = FORM_TYPE.exec(type)?.[1];
    // What it says it is, its length, its proof — and only then is a byte of it parsed.
    const bytes = await believed(
      key,
      asked,
      response,
      answerBytes(limits),
      () => boundary !== undefined,
      hangUp,
    );
    if (signal?.aborted) return { ok: false, failure: "stopped" };
    if (typeof bytes === "string") {
      return malformed(bytes === "type" ? "not_a_form" : bytes);
    }
    if (!boundary) return malformed("not_a_form");
    // The report, and a part for each file a run may hand back.
    if (!isModestForm(bytes, boundary, 1 + limits.products)) {
      return malformed("form");
    }
    const answer = await new Response(bytes, {
      headers: { "content-type": type },
    })
      .formData()
      .catch(() => null);
    if (!answer) return malformed("form");
    return (await runFrom(answer, limits)) ?? malformed("report");
  };

  return {
    async health() {
      const there = await knock();
      return there.kind === "daemon"
        ? { busy: there.busy, boot: there.boot }
        : null;
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
