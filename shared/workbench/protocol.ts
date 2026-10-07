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
 * And every answer proves who gave it (below, "WHO ANSWERS AT THE SOCKET'S PATH").
 *
 * In `shared/` because three things read it and no two of them share a workspace: the daemon
 * (`./daemon.ts`, which runs from this directory in whichever image compose names), the server's
 * client (`server/src/workbench/client.ts`) and the rehearsal that drives the real service
 * (`scripts/workbench-probe.ts`).
 */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
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

/*
 * WHO ANSWERS AT THE SOCKET'S PATH IS PROVEN, EVERY TIME.
 *
 * A script runs as the daemon's own user — the sweep that ends everything a run started reaches
 * "every process of this user" and nothing else, so they cannot be two — and so the directory the
 * daemon binds its socket in is the script's to write as well: it can remove the socket and bind a
 * listener of its own at the same path. Measured on the service, 2026-10-07: a script did; while
 * it ran, the server's `health()` was answered by it; and when its run was given up on with a
 * child of it sitting there, the run waiting behind — script and file — was handed to that child,
 * whose answer came back as the run (three times of three).
 *
 * No owner or mode keeps one's own user out of a directory, and a unix socket's peer credentials
 * say only that user (and no process id across two containers). So the daemon PROVES itself, with
 * a key a script cannot read: both sides are given it in their environment (`WORKBENCH_KEY`), the
 * daemon's environment is closed to a script because the daemon is undumpable (`./undumpable.ts`;
 * the rehearsal reads `/proc/1/environ` from a script and is refused), and a script is started
 * with an environment of its own that has none of it.
 *
 * THE KEY NEVER CROSSES THE SOCKET. Every request carries a number used once; every answer carries
 * an HMAC, under the key, of that number, the route, the status, the type and the very bytes of
 * the body. The server believes nothing that does not carry one — not a run, not a refusal, not
 * `/health` — and checks it over the bytes before it parses them. A listener without the key can
 * make none; one that passes the daemon's own answers along can pass only what the daemon said,
 * to the request it said it to. And the daemon says `busy` in that answer until everything a run
 * started has been ended and cleared up after, so "idle", proven, means nothing a script started
 * is alive to be listening anywhere: the server asks for exactly that before each run it sends
 * (`server/src/workbench/client.ts`).
 */

/** The variable both sides read the key from. Never a flag: a command line is anybody's to read. */
export const KEY_VARIABLE = "WORKBENCH_KEY";

/** The fewest characters a key may be: `openssl rand -hex 16` is thirty-two. */
export const KEY_MIN_LENGTH = 32;

/**
 * Whether a value may be a key: a string, and long enough. ITS LENGTH IS ALL THAT IS HELD HERE —
 * not what it is made of. Thirty-two of one letter passes, and would be a key in name only; a key
 * is as good as whoever minted it, which for a deployment is the fleet's tool and for a laptop is
 * whoever typed it.
 */
export const isKey = (value: unknown): value is string =>
  typeof value === "string" && value.length >= KEY_MIN_LENGTH;

/** The request header that carries the number used once. */
export const NONCE_HEADER = "x-laf-workbench-nonce";
/** The answer header that carries the proof. */
export const PROOF_HEADER = "x-laf-workbench-proof";

export const newNonce = (): string => randomBytes(16).toString("hex");

export const isNonce = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

/** What an answer is, as far as its proof covers it: all of it. */
export type Answered = {
  /** The request's method and path: `GET /health`, `POST /run`. */
  route: string;
  nonce: string;
  status: number;
  /** The `Content-Type` header, exactly; empty when there is none. */
  type: string;
  body: Uint8Array;
};

/** The proof of an answer: an HMAC-SHA256 under the key, in hex. */
export function proofOf(key: string, answered: Answered): string {
  const digest = createHash("sha256").update(answered.body).digest("hex");
  return createHmac("sha256", key)
    .update(
      [
        answered.route,
        answered.nonce,
        String(answered.status),
        answered.type,
        digest,
      ].join("\n"),
    )
    .digest("hex");
}

/** Whether `proof` is the proof of this answer under this key. */
export function isProven(
  key: string,
  answered: Answered,
  proof: unknown,
): boolean {
  if (typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return timingSafeEqual(
    Buffer.from(proofOf(key, answered), "hex"),
    Buffer.from(proof, "hex"),
  );
}

/** A request's route as a proof names it. */
export const routeOf = (request: { method: string; url: string }): string =>
  `${request.method} ${new URL(request.url).pathname}`;

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

/** How long a file's path may be, in characters. */
export const RUN_PATH_CHARS = 1024;

/**
 * Whether a path may name a file inside a run's directory: relative, made of real segments, and
 * going nowhere but down.
 *
 * The paths are the Bot's folder's own (`uploads/2026-10-06-1a2b3c4d-매출.xlsx`), kept as they are so
 * a script opens a file by the name the Bot knows it by. They were already confined once, by the
 * computer that read them; this is the daemon not taking that on trust, and the client not sending
 * what the daemon would refuse.
 *
 * AND WRITTEN THE ONE WAY EVERY READER OF IT READS IT. A path named for a run has three readers.
 * Two of them are handed ONE reading of it, by the gateway, since 2026-10-07: a rule, and the
 * Bot's computer (`server/src/computer/gateway/addresses.ts`, `workspacePathOf` — the ends
 * trimmed, `.` and empty segments gone, the same string judged and sent). The third is the
 * daemon, which places the bytes at the path it is sent, AS IT IS SENT — and what the gateway
 * sends it is that same reading: a file is staged under the path it was judged and read by,
 * however its call wrote it (`./data.csv` is staged as `data.csv`, which is the file a script's
 * own `./data.csv` opens). So everything refused here is something that reading has already
 * changed (white space at either end, an empty or a `.` segment), refused (a backslash) or
 * seen the computer refuse (`..`, an absolute path, a NUL): no such path comes from the gateway,
 * and this is the daemon not taking that on trust, and the client not sending what the daemon
 * would refuse. The one thing here that reading does not make true of a path is how deep it
 * goes (`RUN_PATH_SEGMENTS`). `server/tests/workbench-gateway.test.ts` holds both: what a
 * spelled path is staged under passes this, over a few thousand spellings; and a file too deep
 * is read, and then is not a run.
 *
 * WHAT THIS WAS FOUND BY. Before that date a rule judged a path as it was written and the
 * computer trimmed it, and a path ending in a space was a path here: a rule about
 * `private/payroll.csv`, about its name or about its extension did not match
 * `"private/payroll.csv "`, the computer read the file the rule was written to keep, and its
 * bytes went to a script — measured over the computer's real workspace, 22 of 32 pairs of a rule
 * and such a spelling (the independent read of the script act). What closes that now is the
 * reading, not this function: the rule is asked about the file the spelling names, and refuses.
 */
export function isRunPath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > RUN_PATH_CHARS
  ) {
    return false;
  }
  // A NUL ends a path in a C library; a backslash is a separator to some reader, somewhere.
  if (path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/")) return false;
  // Whitespace at either end, of every kind a trim removes: a space, a tab, a line's end, a
  // no-break or an ideographic space. The gateway's reading trims; the daemon's does not.
  if (path !== path.trim()) return false;
  const segments = path.split("/");
  return (
    segments.length <= RUN_PATH_SEGMENTS &&
    segments.every(
      (segment) => segment !== "" && segment !== "." && segment !== "..",
    )
  );
}

/**
 * What a file's name may not hold, beyond a separator: what would make the name mean something to
 * a path or a terminal, and what would make it DRAW as a name it is not.
 *
 * - C0 and C1 controls and DEL, and the character a name gets where its bytes were not text.
 * - Bidirectional overrides and isolates (U+202A–U+202E, U+2066–U+2069): `invoice<RLO>fdp.exe`
 *   draws as `invoiceexe.pdf`. A file a script made is shown by its name on the trail's page and
 *   on the card that hands it to a person, and the script chose that name.
 * - Zero-width characters and the byte-order mark (U+200B–U+200F, U+2060–U+2065, U+FEFF), which
 *   make two names that look the same different.
 *
 * The classes a person's own attachment has taken out of its name
 * (`server/src/attachments/files.ts`), less the one that is about saving a file on Windows: a
 * download's name is the browser's to make safe for the disk it lands on.
 */
const UNNAMEABLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff/\\\ufffd]/;

/**
 * Whether a name a script gave a file is one that can be handed on: a single segment, visible, with
 * nothing in it that means something to a path or a terminal, or that draws as another name.
 *
 * AND NOTHING A TRIM WOULD CHANGE, for the reason a path has none (`isRunPath`): the name becomes
 * the end of a path the server composes (`made/<day>-<id8>/<name>`) and the gateway reads once
 * (`workspacePathOf`). That reading does not REFUSE a name ending in a space — the space is the
 * end of the whole path, and it is trimmed: `"tool2.exe "` is filed as `tool2.exe`, a name the
 * script did not give and may have given to another file; and a name of three spaces is read as
 * the path of the folder its run's files go in, and written there as a FILE (which it was, until
 * 2026-10-07 — when a rule also judged the name as written, and `"tool2.exe "` was no `exe` to
 * it). So this stands in front of the composition, and what passes it composes to a path that
 * is its own spelling (held by a test, over the names here). Refused here, a file of such a name
 * is not handed back: the daemon counts it among what it skipped, and an answer that names one
 * is not one the client or the gateway passes on.
 *
 * A BACKSLASH IS THE ONE THING HERE THE GATEWAY'S OWN FLOOR REFUSES TOO: a path with one in it
 * has no one reading (`hasNoOneReading`), since the computer wrote it as a letter and read it as
 * a separator. Refused here first, at the source, so a file so named is never read out of the
 * sandbox at all.
 */
export function isProductName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0) return false;
  if (new TextEncoder().encode(name).length > 255) return false;
  if (name.startsWith(".")) return false;
  if (name !== name.trim()) return false;
  return !UNNAMEABLE.test(name);
}
