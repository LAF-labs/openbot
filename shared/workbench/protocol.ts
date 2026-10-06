/**
 * What the server and the workbench say to each other, and the bounds both hold a run to.
 *
 * THE WORKBENCH IS A FUNCTION OF WHAT IT IS SENT. A run is a script and the bytes of the files it
 * may read; what comes back is how it ended, what it printed and the bytes of the files it made.
 * Nothing else goes in and nothing else comes out: the service has no network and no volume but
 * the one its socket is on (`docker-compose.yml`, `workbench`), so there is no folder for a script
 * to damage and nowhere for what it read to go.
 *
 * HTTP over a unix socket, with Bun's own server and fetch (`unix:` on both), as the converter
 * speaks to the server (`server/src/attachments/converter-daemon.ts`) — and `multipart/form-data`
 * both ways, because both directions carry files. One part of JSON says what the other parts are;
 * each file is a part under a name that JSON gives it. A path or a file's name is never read off a
 * part's own `filename`: what that field means is whatever a parser decides, and these are names a
 * model and a script chose.
 *
 * In `shared/` because three things read it and no two of them share a workspace: the daemon
 * (`./daemon.ts`, which runs from this directory in whichever image compose names), the server's
 * client (`server/src/workbench/client.ts`) and the rehearsal that drives the real service
 * (`scripts/workbench-probe.ts`).
 */
import { ATTACHMENT_MAX_BYTES } from "../attachments";
import { HANDOFF_MAX_BYTES } from "../workspace-files";

/**
 * The bounds of one run. Every one is enforced by the daemon; the client holds a request to the
 * same numbers first, so that a run which could only be refused is not sent.
 *
 * PROPOSALS UNTIL MEASURED ON A VM. The converter's twenty seconds and 512 MB were measured on the
 * recommended 1-OCPU machine (`converter-process.ts`); these have been run on a laptop and on a CI
 * runner and on nothing a customer has.
 */
export const WORKBENCH_LIMITS = {
  /**
   * The script. Small, because a script is the ARGUMENT of a tool call, and an argument stays in
   * the conversation: every run's script is sent again with every later request until compaction
   * drops the call. A real script for a sheet is one to three kilobytes.
   */
  scriptBytes: 16 * 1024,
  /** How many files one run may be handed. */
  files: 8,
  /** One file: the largest a person may attach, so nothing they could hand over is too large to read. */
  fileBytes: ATTACHMENT_MAX_BYTES,
  /** All of them together. They are held in memory twice on the way in — the request, then the tmpfs. */
  filesBytes: 20 * 1024 * 1024,
  /** How long a run gets when the caller does not say. */
  timeoutMs: 20_000,
  /** And the most it may ask for. A routine's whole run is ten minutes (`routines/run.ts`). */
  timeoutCeilingMs: 60_000,
  /** The most a run's processes may hold resident, all of them together. */
  memoryBytes: 512 * 1024 * 1024,
  /** How many files a run may hand back. */
  products: 8,
  /** One of them: what a download hands a person, or a card would draw no button under it. */
  productBytes: HANDOFF_MAX_BYTES,
  /** All of them together. */
  productsBytes: 10 * 1024 * 1024,
  /**
   * How much of each of stdout and stderr is kept. Past it the stream is still read — a script
   * blocked on a full pipe would only hang until its time ran out — and counted, and dropped.
   */
  streamBytes: 256 * 1024,
} as const;

/** The form part that says what the others are. */
export const JOB_PART = "job";
/**
 * The form part that is the script — as bytes, like a file, not as a text field: a form may rewrite
 * a text field's line endings on the way, and a script is sent as it was written.
 */
export const SCRIPT_PART = "script";
/** The answer's part that says how the run ended and what the other parts are. */
export const REPORT_PART = "report";

/** One file a run may read: where the script finds it, and which part of the request holds it. */
export type JobFile = { path: string; part: string };

/** The JSON part of a request to `/run`. */
export type Job = {
  /** At most `timeoutCeilingMs`; absent is `timeoutMs`. */
  timeoutMs?: number;
  files: JobFile[];
};

/**
 * How a run ended.
 *
 * `exited` is the script's own ending, whatever status it left with. The other two are the
 * daemon's: it killed the run at a bound. A run the caller abandoned has no report at all — nobody
 * is there to read one.
 */
export type RunEnding = "exited" | "timed_out" | "out_of_memory";

/** Why a run that exited with 0 handed nothing back although it left files in `out/`. */
export type ProductsRefusal = "too_many" | "too_large" | "too_large_together";

/** One file a run made: its name, its size, and which part of the answer holds it. */
export type ReportedProduct = { name: string; bytes: number; part: string };

/** The JSON part of an answer from `/run`. */
export type RunReport = {
  ending: RunEnding;
  /** The script's own status, where it exited by itself. */
  exitCode: number | null;
  /** The signal that ended it, where one did: the daemon's SIGKILL at a bound, or the script's own. */
  signal: string | null;
  /** From the script starting to its ending. */
  ms: number;
  /** What it printed, as far as `streamBytes`. */
  stdout: string;
  stderr: string;
  /** How much it printed in all, kept or not. */
  stdoutBytes: number;
  stderrBytes: number;
  /** The files it made, when it exited with 0 and they fit. Empty otherwise. */
  products: ReportedProduct[];
  /** Present when there were files and none came back. */
  productsRefused?: ProductsRefusal;
  /** How many things in `out/` were not files to hand back: a folder, a link, a hidden name. */
  skipped: number;
};

/**
 * Why a request got no report. Codes, in the shape every refusal across a service boundary here
 * has — `{ error: code, code }` — and never a sentence: nobody reads these but the server's client,
 * which says what a caller needs in its own terms (`WorkbenchFailure`).
 */
export type WorkbenchRefusal =
  /** A run is in progress, or the service is on its way out. It runs one script at a time. */
  | "laf:workbench_busy"
  /** The request is not a run this service takes; `field` says which part. */
  | "laf:workbench_request_invalid"
  /** The service is no longer where compose put it, and has refused to run anything. */
  | "laf:workbench_not_isolated"
  /** The run could not be cleaned up after, so the service is stopping rather than run another. */
  | "laf:workbench_failed"
  | "laf:workbench_route_unknown";

/** The part of a request a refusal is about. */
export type InvalidField = "job" | "script" | "files" | "timeoutMs";

/** A file part's name in a request: `file0`, `file1`, … */
export const filePart = (index: number) => `file${index}`;
/** A product part's name in an answer: `product0`, `product1`, … */
export const productPart = (index: number) => `product${index}`;

/**
 * How many folders deep a file's path may be, the file's own name included.
 *
 * The Bot's folder is two or three deep (`uploads/…`, `made/<day>/…`). Unbounded, a path's length
 * was the only limit, and 1,024 characters are five hundred folders: eight such files are four
 * thousand names of the 4,096 the work root has (`docker-compose.yml`), the next `mkdir` failed for
 * want of one, and the daemon took a failure it could not explain as its cue to stop — a
 * request's mistake answered by ending the service (the independent read, 2026-10-06).
 */
export const RUN_PATH_SEGMENTS = 16;

/**
 * Whether a path may name a file inside a run's directory: relative, made of real segments, and
 * going nowhere but down.
 *
 * The paths are the Bot's folder's own (`uploads/2026-10-06-1a2b3c4d-매출.xlsx`), kept as they are so
 * a script opens a file by the name the Bot knows it by. They were already confined once, by the
 * computer that read them; this is the daemon not taking that on trust, and the client not sending
 * what the daemon would refuse.
 */
export function isRunPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) {
    return false;
  }
  // A NUL ends a path in a C library; a backslash is a separator to some reader, somewhere.
  if (path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/")) return false;
  const segments = path.split("/");
  return (
    segments.length <= RUN_PATH_SEGMENTS &&
    segments.every(
      (segment) => segment !== "" && segment !== "." && segment !== "..",
    )
  );
}

/**
 * Whether a name a script gave a file is one that can be handed on: a single segment, visible, with
 * nothing in it that means something to a path or a terminal.
 */
export function isProductName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0) return false;
  if (new TextEncoder().encode(name).length > 255) return false;
  if (name.startsWith(".")) return false;
  // Control characters, the separators, and the character a name gets where its bytes were not text.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  return !/[\u0000-\u001f\u007f/\\�]/.test(name);
}
