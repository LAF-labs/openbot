/**
 * A run of a script, in the gateway's terms: what one is asked with, what identifies it, the ways
 * it comes back without having run, and where what it made is filed.
 *
 * Beside `acts.ts` for the reason `intent.ts` and `addresses.ts` are beside `govern.ts`: these are
 * the spellings and the bounds, and `runScript` there is the sequence. Nothing in this file
 * decides whether a Bot may do anything — a rule is the policy's, asked by `govern`.
 *
 * NOTHING HERE IS OFFERED TO A BOT YET (2026-10-07). No tool names a run, no turn calls one, and
 * the server is handed no workbench (`main.ts` passes none): the act exists so that the boundary
 * it goes through can be read alone, before a model is in it.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  isProductName,
  type ProductsRefusal,
  RUN_PATH_CHARS,
  type RunEnding,
  WORKBENCH_LIMITS,
} from "../../../../shared/workbench/protocol";
import {
  type AuditFactCode,
  MADE_FULL,
  SCRIPT_INPUTS_INVALID,
  SCRIPT_TOO_LARGE,
  WORKBENCH_BUSY,
  WORKBENCH_FAILED,
  WORKBENCH_UNAVAILABLE,
} from "../../audit";
import type { WorkbenchAnswer } from "../../workbench/client";
import {
  type ComputerClient,
  ComputerUnavailableError,
  FILE_NOT_FOUND,
  factOfError,
  STOPPED,
} from "../client";
import { workspacePathOf } from "./addresses";

/** What a caller asks a run with. */
export type ScriptRunInput = {
  /** The whole program. It goes to the sandbox and nowhere else: no row, no log, no subject. */
  script: string;
  /** Paths in the Bot's folder. Only these exist for the script, each at this same path. */
  files: readonly string[];
  /** How long it may run. Absent is the sandbox's own default; never more than its ceiling. */
  timeoutMs?: number;
};

/**
 * One file a run handed back: filed at `path`, or not filed and `unfiled` says why — the rule
 * that refused its name, the folder being full, the computer not taking it. Never both.
 */
export type ScriptProduct = { name: string; bytes: number } & (
  | { path: string; unfiled?: undefined }
  | { path?: undefined; unfiled: string }
);

/**
 * How a run ended, for whoever asked for it.
 *
 * `stdout` and `stderr` are for that caller alone — a turn hands them to the model that wrote the
 * script. They are on no row of the trail and in no log line (`trail.ts`, `writeScriptFinished`).
 */
export type ScriptRun = {
  /** The script's SHA-256, as every row about this run carries it. */
  sha256: string;
  ending: RunEnding;
  exitCode: number | null;
  signal: string | null;
  ms: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  /** Present when the script left files and the sandbox handed none back: too many, too large. */
  productsRefused?: ProductsRefusal;
  /** How many things it left that were not files to hand back: a folder, a link, a hidden name. */
  skipped: number;
  /**
   * The files the script was handed, each by the path it was placed under: the one spelling of
   * the path the call named, which is the path the read's row names and the run's own row lists.
   * A script finds its file by this name, or by any name the operating system resolves to it
   * (`./data.csv` for `data.csv`); a caller that named `"data.csv "` is told here what it is.
   */
  files: string[];
  products: ScriptProduct[];
};

/**
 * The script did not run, or a file it made was not kept — as a fact.
 *
 * THE MESSAGE IS THE CODE, like every refusal that leaves this gateway (`caller.ts`), so that the
 * failure row `govern` writes holds a fact and never a sentence, and a caller words it for
 * whoever it is told to. `facts` are the numbers and names beside it: which part of the request,
 * how many bytes against which bound.
 */
export class ScriptNotRunError extends Error {
  /** One of the trail's own facts (`audit.ts`, the six about a script and where it runs). */
  readonly code: AuditFactCode;
  readonly facts: Readonly<Record<string, string | number>>;

  constructor(
    code: AuditFactCode,
    facts: Readonly<Record<string, string | number>> = {},
  ) {
    super(code);
    this.name = "ScriptNotRunError";
    this.code = code;
    this.facts = facts;
  }
}

/**
 * What is wrong with a request that can be seen without reading anything: null when nothing is.
 *
 * BEFORE ANY FILE IS READ AND BEFORE ANYTHING IS DECIDED, so a request that could only be refused
 * costs no read, opens no question and leaves no row — the way an argument of the wrong type
 * never reaches a tool. The sandbox's client holds a request to the same bounds again
 * (`workbench/client.ts`, `wrongPartOf`); what only it can see — the files' sizes together, once
 * they have been read — comes back from it as `invalid`, inside the governed run.
 *
 * NOTHING ABOUT HOW A PATH IS WRITTEN IS JUDGED HERE. A file a call names is a string of no
 * more than a path's length, and that is all this asks of it: every such string goes on to
 * `govern`, which reads a path once (`addresses.ts`, `workspacePathOf`) and leaves a row for
 * whatever comes of it. `./data.csv` and `"data.csv "` are judged, read and handed to the
 * script as `data.csv`; a path with no one reading (a backslash) is refused by the gateway's
 * floor; what is no path at all (`..`, an absolute path, a NUL, a blank) is judged as written
 * and refused by the computer it is sent to — the Bot's own read, in all three. On its first
 * rebase onto that reading this still refused the first and the last of those here, in
 * silence; reversed the same day (2026-10-07), before the change's second read: a refusal that
 * leaves nothing on the trail is what that reading was careful not to add — a spelling tried
 * against a denied file was invisible through a run, and a refused row through
 * `computer_read_file` — and `./data.csv` is how a model writes a file's name. The length is
 * held first because a row carries the string.
 *
 * `unknown` where a type says `string`: what arrives here will be a model's arguments.
 */
export function requestProblem(
  input: ScriptRunInput,
): ScriptNotRunError | null {
  const invalid = (field: "script" | "files" | "timeoutMs") =>
    new ScriptNotRunError(SCRIPT_INPUTS_INVALID, { field });
  const script: unknown = input.script;
  if (typeof script !== "string" || script.length === 0) {
    return invalid("script");
  }
  const bytes = Buffer.byteLength(script);
  if (bytes > WORKBENCH_LIMITS.scriptBytes) {
    return new ScriptNotRunError(SCRIPT_TOO_LARGE, {
      bytes,
      limit: WORKBENCH_LIMITS.scriptBytes,
    });
  }
  const { timeoutMs } = input;
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > WORKBENCH_LIMITS.timeoutCeilingMs)
  ) {
    return invalid("timeoutMs");
  }
  const files: unknown = input.files;
  if (!Array.isArray(files) || files.length > WORKBENCH_LIMITS.files) {
    return invalid("files");
  }
  for (const path of files) {
    if (typeof path !== "string" || path.length > RUN_PATH_CHARS) {
      return invalid("files");
    }
  }
  return null;
}

/**
 * The files a call names, each once: a file named twice — by one string, or by two spellings of
 * one path — is one file to read, to judge and to hand a script.
 *
 * WHY BEFORE `govern`, AND NOT LEFT TO IT. Each file is a decision of its own, and two decisions
 * about one file are bound to the same answer: where a rule asks about that file, the first
 * would spend the person's yes and the second ask again, on every attempt, and the call would
 * never get through. So two names for one file are told apart here, by the function `govern`
 * itself reads a path with — asked only WHETHER two strings are one file. What is judged, read
 * and handed on is still the string `govern` hands the act (`acts.ts`, `runScript`), and a
 * string that reading has no spelling for stands as it was written, as it does there.
 */
export function filesNamedBy(input: ScriptRunInput): string[] {
  const named = new Map<string, string>();
  for (const path of input.files) {
    const file = workspacePathOf(path) ?? path;
    if (!named.has(file)) named.set(file, path);
  }
  return [...named.values()];
}

/** A script's SHA-256, over the bytes it is sent as. What a row says instead of the script. */
export function scriptDigestOf(script: string): string {
  return createHash("sha256").update(script, "utf8").digest("hex");
}

/**
 * What a run that produced no ending is thrown as, so that `govern` records it as an act that
 * was allowed and did not happen.
 *
 * A caller that stopped is the computer's own `laf:stopped`, the same error and the same fact a
 * stopped click is — one name for one thing, and every reader already has words for it. The rest
 * are five of the client's words folded into three facts: for a person or an operator reading the
 * row, "not there" and "outside its walls" are one fact (nothing ran, and nothing will until the
 * service is seen to), and "could not vouch" and "answered something this side will not pass on"
 * are another (it may have run; this server will not say so). The client's own log line keeps
 * which it was (`workbench_unreachable`, `workbench_refused`, `workbench_answer_malformed`).
 */
export function notRunFor(
  answer: Extract<WorkbenchAnswer, { ok: false }>,
): Error {
  switch (answer.failure) {
    case "stopped":
      return new ComputerUnavailableError(STOPPED);
    case "busy":
      return new ScriptNotRunError(WORKBENCH_BUSY);
    case "invalid":
      return new ScriptNotRunError(SCRIPT_INPUTS_INVALID, {
        field: answer.field ?? "job",
      });
    case "unavailable":
    case "not_isolated":
      return new ScriptNotRunError(WORKBENCH_UNAVAILABLE);
    case "failed":
    case "malformed":
      return new ScriptNotRunError(WORKBENCH_FAILED);
  }
}

/** Whether every name a run gave a file is one a file may have here, and no two are the same. */
export function areProductNames(names: readonly unknown[]): boolean {
  return names.every(isProductName) && new Set(names).size === names.length;
}

/** Where a run's files go in the Bot's folder. Not hidden: a person is shown this folder. */
export const MADE_DIRECTORY = "made";

/**
 * The most `made/` may hold, in bytes, before a run's files are no longer filed there — ONE OF THE
 * TWO BOUNDS THE FOLDER REALLY HAS, AND NOT THE ONE THAT BITES FIRST.
 *
 * THE OWNER'S DECISION OF 2026-10-07: a total that refuses when it is reached, and nothing deleted
 * to make room — a file a person was handed last month is not something to remove behind them.
 * Nothing empties this folder today, by a Bot or by a person, so full is full until somebody with
 * the machine clears it; that is said in the fact (`laf:made_full`).
 *
 * THE OTHER BOUND IS HOW IT IS COUNTED, AND IT IS THE SMALLER. The only thing that can say what a
 * folder holds is the Bot's computer, and it describes a folder in so many entries and says when
 * there was more (`agent-computer/src/workspace.ts`, `listEntries`: five hundred). A folder it
 * cannot describe whole has no total anybody can state, and one that cannot be stated is not
 * known to be under this — so that reads as full too (`madeHeldBy`). Every run is a folder and
 * its files. MEASURED over the computer's own workspace (the independent read of 2026-10-07, and
 * `workbench-gateway.test.ts`): a folder of one-file runs takes 251 of them and refuses the
 * 252nd, at 2,259 bytes — seventy-five kilobytes in the reader's run — of the two hundred
 * megabytes below. The comment here once said "years". For runs that make one file it is two
 * hundred and fifty-one runs, whatever their size.
 *
 * WHAT COUNTING IT PROPERLY TAKES, and why it is not here: the computer totalling a folder itself
 * — a route in `agent-computer`, which is an image and another change — or a way for `made/` to
 * be emptied. Until one of those, this is not yet the owner's total: it is that total OR the
 * listing's length, whichever is met first, and whoever offers a run to a Bot has that to settle
 * before a person's 252nd file is refused for good.
 *
 * THE NUMBER ITSELF IS A PROPOSAL, NOT A MEASUREMENT: what a customer's disk has to spare was not
 * known when it was written. Two hundred megabytes is twenty of the largest runs there can be
 * (ten megabytes of files each).
 */
export const MADE_MAX_BYTES = 200 * 1024 * 1024;

/**
 * `made/<day>-<id8>`: the folder one run's files are filed in, named by this server and never by
 * the script, which chooses only each file's own name.
 *
 * The day and eight characters, as an attachment's place is named (`attachments/files.ts`).
 *
 * THE EIGHT ARE OF THE CALL, SO THAT THE SAME CALL MADE AGAIN NAMES THE SAME FOLDER — which is
 * what happens once a person has answered a question about it: a question about one file is
 * bound to that file's path (`approvals.ts`, `fingerprintOf`), and an answer could never be spent
 * on a path that had moved.
 *
 * AND A CALL IS MORE THAN THE ID ITS PROVIDER GAVE IT. The eight were a digest of the tool call's
 * id alone until 2026-10-07, and some providers name every call `call_1`: two different runs
 * that day shared a folder, and the second one's file was refused as already there. A call is the
 * Bot, the conversation, the id, the script and the files it names (in one order, as an answer
 * about it is bound) — all of them the same when a call is made again, and not all the same for
 * two calls unless they are the same run of the same script in the same conversation, whose
 * files are the same files. A digest, because half of that is whatever a model's provider wrote
 * and this is a folder's name.
 *
 * WHAT IS LEFT, SAID. A caller that names no call gets a folder of its own each time — there is
 * nothing to tell "again" from "another" by — so a question about a file it made can never be
 * answered into the same path; whoever wires a caller passes the call's id. And the day is the
 * clock's: a call made again across midnight UTC names another folder, and a question about its
 * file is asked once more. A question is open for ten minutes.
 */
export function madeDirectoryFor(
  at: Date,
  call: {
    botId: string;
    /** The conversation, where the call came from one. */
    threadId?: string | undefined;
    /** The Bot's tool call. Absent, the folder is this attempt's alone. */
    toolCallId?: string | undefined;
    /** The script's SHA-256, and the files it names. */
    sha256: string;
    files: readonly string[];
  },
): string {
  const day = at.toISOString().slice(0, 10);
  /*
   * AS THE TUPLE IT IS, NOT AS ITS PARTS RUN TOGETHER. These were joined with a NUL, and two of
   * them are whatever a provider wrote: a conversation `t` with a call `x<NUL>c` and a
   * conversation `t<NUL>x` with a call `c` were one string, so one folder, and the second run's
   * file was refused as already there (the second read of this act). JSON says where each part
   * ends; nothing was offered a run yet, so no folder made the old way is anybody's.
   */
  const whose =
    call.toolCallId === undefined
      ? randomUUID()
      : JSON.stringify([
          call.botId,
          call.threadId ?? "",
          call.toolCallId,
          call.sha256,
          [...call.files].sort(),
        ]);
  const id8 = createHash("sha256").update(whose).digest("hex").slice(0, 8);
  return `${MADE_DIRECTORY}/${day}-${id8}`;
}

/**
 * How many bytes `made/` holds, as the Bot's computer describes it — infinity when it cannot be
 * described whole. "Truncated" is the computer's own word and this side takes it as said: how
 * many entries make a listing too long is the computer's to know (`MADE_MAX_BYTES` above has
 * what that comes to, measured).
 *
 * The runtime checking a fact for a bound of its own, as a turn asks a file's size before it says
 * a card is on screen (`person-files.ts`, `fileFacts`): no row, and not a Bot's listing — nothing
 * of it is handed to a Bot. A folder that is not there yet holds nothing.
 */
export async function madeHeldBy(
  computer: ComputerClient,
  /** The caller's Stop: it ends the look, as it ends a put (`laf:stopped`). */
  signal?: AbortSignal,
): Promise<number> {
  let listed: Awaited<ReturnType<ComputerClient["listFiles"]>>;
  try {
    listed = await computer.listFiles({ path: MADE_DIRECTORY }, signal);
  } catch (error) {
    if (factOfError(error) === FILE_NOT_FOUND) return 0;
    throw error;
  }
  if (listed.truncated) return Number.POSITIVE_INFINITY;
  return listed.entries.reduce(
    (held, entry) => held + (entry.kind === "file" ? (entry.bytes ?? 0) : 0),
    0,
  );
}

/**
 * Whether what stopped `made/` being read is that it is not a folder: where the folder belongs
 * there is a FILE (the computer's `laf:file_wrong_kind`, of a listing). Then no file of any run
 * can be filed, and nothing here removes a file — it is so until somebody with the machine moves
 * what is there. Told apart from the computer not answering because it is not about this moment:
 * one row says it of every file of the run (`MADE_NOT_A_FOLDER`), instead of a failed row each.
 */
export function isNotAFolder(error: unknown): boolean {
  return factOfError(error) === "laf:file_wrong_kind";
}

/** A file that was not filed because `made/` holds all it may, with what it would have come to. */
export function madeFull(
  held: number,
  bytes: number,
  limit: number,
): ScriptNotRunError {
  return new ScriptNotRunError(MADE_FULL, {
    bytes,
    limit,
    // A folder that could not be described whole has no figure to give.
    ...(Number.isFinite(held) ? { held } : {}),
  });
}
