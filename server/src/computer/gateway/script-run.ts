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
  isRunPath,
  type ProductsRefusal,
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
 * A PATH THAT IS NOT WRITTEN THE ONE WAY EVERY READER READS IT IS REFUSED HERE TOO (`isRunPath`):
 * one with a space or a line's end at either end, which the policy would judge as written and the
 * Bot's computer would trim. Refused and not tidied — the script opens its file by the path it
 * was asked with — and, like the rest of what is refused here, with no row: nothing was read and
 * nothing decided, so there is nothing for the trail to say happened.
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
  const named = new Set<string>();
  for (const path of files) {
    if (!isRunPath(path) || named.has(path)) return invalid("files");
    named.add(path);
  }
  return null;
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
 * The most `made/` may hold before a run's files are no longer filed there.
 *
 * THE OWNER'S DECISION OF 2026-10-07: a total that refuses when it is reached, and nothing deleted
 * to make room — a file a person was handed last month is not something to remove behind them.
 * Nothing empties this folder today, by a Bot or by a person, so full is full until somebody with
 * the machine clears it; that is said in the fact (`laf:made_full`) and is the reason the number
 * is generous.
 *
 * THE NUMBER IS A PROPOSAL, NOT A MEASUREMENT: what a customer's disk has to spare was not known
 * when this was written (the design memo, "what I could not determine"). Two hundred megabytes is
 * twenty of the largest runs there can be (ten megabytes of files each) and years of the usual
 * ones (a sheet of a few hundred kilobytes a day).
 *
 * AND A SECOND BOUND COMES WITH HOW IT IS COUNTED. The computer describes a folder in at most five
 * hundred entries (`agent-computer/src/workspace.ts`, `listEntries`) and says when there was more.
 * A folder it cannot describe whole is one whose total nobody can state, and a total nobody can
 * state is not known to be under this — so that reads as full too (see `madeHeldBy`). Each run is
 * a folder and its files, so that is reached after some hundreds of runs whatever their size.
 */
export const MADE_MAX_BYTES = 200 * 1024 * 1024;

/**
 * `made/<day>-<id8>`: the folder one run's files are filed in, named by this server and never by
 * the script, which chooses only each file's own name.
 *
 * The day and eight characters, as an attachment's place is named (`attachments/files.ts`). The
 * eight are of the Bot's tool call where the caller named one, so that the SAME call made again
 * — which is what happens once a person has answered a question about it — names the same folder:
 * a question about one file is bound to that file's path (`approvals.ts`, `fingerprintOf`), and
 * an answer could never be spent on a path that had moved. A digest of the id rather than a piece
 * of it, because the id is whatever a model's provider wrote and this is a folder's name. A run
 * with no call behind it gets a folder of its own each time.
 */
export function madeDirectoryFor(at: Date, callId: string | undefined): string {
  const day = at.toISOString().slice(0, 10);
  const id8 = createHash("sha256")
    .update(callId ?? randomUUID())
    .digest("hex")
    .slice(0, 8);
  return `${MADE_DIRECTORY}/${day}-${id8}`;
}

/**
 * How many bytes `made/` holds, as the Bot's computer describes it — infinity when it cannot be
 * described whole.
 *
 * The runtime checking a fact for a bound of its own, as a turn asks a file's size before it says
 * a card is on screen (`person-files.ts`, `fileFacts`): no row, and not a Bot's listing — nothing
 * of it is handed to a Bot. A folder that is not there yet holds nothing.
 */
export async function madeHeldBy(computer: ComputerClient): Promise<number> {
  let listed: Awaited<ReturnType<ComputerClient["listFiles"]>>;
  try {
    listed = await computer.listFiles({ path: MADE_DIRECTORY });
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

/** A file that was not filed because `made/` is full, with what it would have come to. */
export function madeFull(held: number, bytes: number): ScriptNotRunError {
  return new ScriptNotRunError(MADE_FULL, {
    bytes,
    limit: MADE_MAX_BYTES,
    // A folder too large to describe has no figure to give.
    ...(Number.isFinite(held) ? { held } : {}),
  });
}
