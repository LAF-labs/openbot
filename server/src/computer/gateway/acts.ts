/**
 * The acting calls: each one names its tool and its subject, and hands the rest to `govern`.
 *
 * Thin on purpose, and kept apart from the decision so that they stay thin. Nothing in this file
 * decides anything: what a method may add is what the policy needs to know about its call — the key,
 * whether it submits, which file — and the one promise every call on a ref makes to the computer,
 * that the click lands on the control the policy judged and not on whatever the page renamed it to.
 *
 * ONE METHOD IS A SEQUENCE OF THEM. `runScript` is several acts in a row — the files a script is
 * handed, the run, the files it made — and each is still one call of `govern` with its own
 * decision and its own row. It decides nothing either; what it adds is the order.
 */
import { WORKBENCH_LIMITS } from "../../../../shared/workbench/protocol";
import {
  type AuditStore,
  MADE_NOT_A_FOLDER,
  SCRIPT_INPUTS_INVALID,
  WORKBENCH_FAILED,
  WORKBENCH_UNAVAILABLE,
} from "../../audit";
import { log } from "../../log";
import type { Workbench, WorkbenchFile } from "../../workbench/client";
import { BotIdRefusedError, isBotId } from "../bot-id";
import {
  COMPUTER_FAILED,
  type ComputerClient,
  ComputerUnavailableError,
  factOfError,
  STOPPED,
  WorkspaceRequestError,
} from "../client";
import type {
  ClickInput,
  KeyInput,
  ListFilesInput,
  ReadFileInput,
  ScrollInput,
  SwitchTabInput,
  TypeInput,
  UploadFileInput,
  WriteFileInput,
} from "../schema";
import {
  type ActionActor,
  ActionNeedsApprovalError,
  ActionRefusedError,
} from "./caller";
import type { Govern, JudgedElement } from "./govern";
import { RUN_SCRIPT_TOOL } from "./intent";
import {
  areProductNames,
  filesNamedBy,
  isNotAFolder,
  MADE_MAX_BYTES,
  madeDirectoryFor,
  madeFull,
  madeHeldBy,
  notRunFor,
  requestProblem,
  type ScriptProduct,
  ScriptNotRunError,
  type ScriptRun,
  type ScriptRunInput,
  scriptDigestOf,
} from "./script-run";
import { writeScriptFilesLeft, writeScriptFinished } from "./trail";

/**
 * An acting input as the computer must receive it: holding the action to the control THIS server
 * judged, and never to one the caller named.
 *
 * AUDIT A3, 2026-09-10: a button the snapshot called "저장" was renamed "결제하기" by the page after the
 * snapshot; the policy judged "저장", the click landed on 결제하기, and no approval card was shown. The
 * approval fingerprint already carried the element's name — what was missing was anything holding
 * the click to it. With `element` the computer refuses (`laf:label_changed`) when the control is
 * called something else by the time it acts, so a Bot has to look again and is judged, and asked, on
 * the name the control really has. An answer given for "저장" is never spent on "결제하기".
 *
 * The request shape and the wire shape are one type, so a caller could put an `element` on its own
 * call and have the click held to a label of its choosing. Whatever arrived is dropped; the
 * snapshot's answer, or nothing, goes out.
 */
function heldTo<I extends { element?: JudgedElement }>(
  input: I,
  judged: JudgedElement | undefined,
): I {
  const { element: _fromCaller, ...rest } = input;
  return (judged ? { ...rest, element: judged } : rest) as I;
}

export function createActs(deps: {
  /** The computer, addressed as the Bot that is asking. See `createComputerGateway`. */
  as: (computerId: string, botId?: string) => ComputerClient;
  govern: Govern;
  /** Where a script's ending is recorded, between the run and the files it made. */
  auditStore: AuditStore;
  /**
   * Where a script runs. Absent on a deployment that has none — every deployment, today: nothing
   * hands the server one (`main.ts`) — and `runScript` then refuses before it reads anything.
   */
  workbench?: Workbench | undefined;
  /** The clock a run's folder is dated by. A test moves it. */
  now?: () => Date;
  /** The most `made/` may hold. A test makes it small. */
  madeMaxBytes?: number;
}) {
  const { as, govern, auditStore, workbench } = deps;
  const now = deps.now ?? (() => new Date());
  const madeMaxBytes = deps.madeMaxBytes ?? MADE_MAX_BYTES;

  /**
   * One call files what its run made at a time.
   *
   * What `made/` holds is read once a call, before its first file, and added to as each is
   * filed. Two calls filing at once each read what was there before the other, and both filed
   * past what the folder may hold (until 2026-10-07; a run's worth over, each time). In this
   * process there is one of these and it is a queue: the next call reads the folder after the
   * one before has finished with it. In memory, which is the whole of it here — one API server
   * on one VM (docs/laf/deployment-model.md) — and it bounds what RUNS file: a Bot's own
   * `computer_write_file` into `made/` was never this bound's.
   */
  let filing: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const mine = filing.then(work, work);
    filing = mine.catch(() => undefined);
    return mine;
  };

  return {
    click(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: ClickInput,
      signal?: AbortSignal,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_click",
        botId,
        actor,
        {
          ref: input.ref,
          ...(signal ? { signal } : {}),
          ...(approvalId ? { approvalId } : {}),
        },
        (judged) => as(computerId, botId).click(heldTo(input, judged), signal),
      );
    },

    type(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: TypeInput,
      signal?: AbortSignal,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_type",
        botId,
        actor,
        {
          ref: input.ref,
          // Whether this call ends by pressing Enter, which is the third way into a form and the one
          // a rule about clicking and a rule about `key` both miss. The computer presses it itself,
          // so it never arrives here as an action of its own to be judged.
          submit: input.submit === true,
          // For its shape only: the high-risk check asks whether it is a card or ID number, and
          // nothing keeps it (see `govern`'s subject).
          typed: input.text,
          ...(signal ? { signal } : {}),
          ...(approvalId ? { approvalId } : {}),
        },
        (judged) => as(computerId, botId).type(heldTo(input, judged), signal),
      );
    },

    key(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: KeyInput,
      signal?: AbortSignal,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_key",
        botId,
        actor,
        // The key is part of the subject, so a rule can tell Enter from a letter. Form submission can
        // happen through a keypress as well as a click, so the policy context carries the key.
        {
          ref: input.ref,
          key: input.key,
          ...(signal ? { signal } : {}),
          ...(approvalId ? { approvalId } : {}),
        },
        // A keypress on a control is held to that control's label like a click; one on the page
        // itself resolves no ref, so there is nothing to hold it to.
        (judged) => as(computerId, botId).key(heldTo(input, judged), signal),
      );
    },

    scroll(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: ScrollInput,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_scroll",
        botId,
        actor,
        { ...(approvalId ? { approvalId } : {}) },
        () => as(computerId, botId).scroll(input),
      );
    },

    /**
     * Moving to another tab, governed as the read it is.
     *
     * It goes through the gateway rather than straight to the client for the audit row: which page a
     * Bot was on when it pressed something is the question every trail is read to answer, and a tab
     * change that left no row would make that unanswerable.
     */
    switchTab(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: SwitchTabInput,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_switch_tab",
        botId,
        actor,
        { ...(approvalId ? { approvalId } : {}) },
        () => as(computerId, botId).switchTab(input),
      );
    },

    /**
     * Handing a workspace file to a page.
     *
     * Its own intent, `upload`, and in the shipped policy's `ask` list. Everything else a Bot does
     * with a file stays inside its own workspace; this is the one call that takes something out of
     * it and gives it to somebody else's website, and the thing it hands over may be the 정산 내역
     * it wrote this morning.
     */
    uploadFile(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: UploadFileInput,
      signal?: AbortSignal,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_upload_file",
        botId,
        actor,
        {
          ref: input.ref,
          // The file is part of the subject, so a rule about which files may leave the workspace has
          // something to match on, and so the audit row names what was handed over.
          filePath: input.path,
          ...(signal ? { signal } : {}),
          ...(approvalId ? { approvalId } : {}),
        },
        // The file handed to the site is the one the rule was asked about: `path` is `govern`'s
        // reading of `input.path`, and nothing here reads that string a second time.
        (judged, path) =>
          as(computerId, botId).uploadFile(
            heldTo({ ...input, path: path ?? input.path }, judged),
            signal,
          ),
      );
    },

    /**
     * The file tools, governed like everything else.
     *
     * The read is governed too, unlike reading a page. A page was permitted when it was opened; the
     * workspace accumulates whatever a Bot has saved across every task it has ever run, so which of
     * those files it may read back is a real question for a deployment to be able to answer.
     */
    readFile(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: ReadFileInput,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_read_file",
        botId,
        actor,
        {
          filePath: input.path,
          ...(input.offset !== undefined || input.limit !== undefined
            ? { part: `${input.offset ?? 0}+${input.limit ?? ""}` }
            : {}),
          ...(approvalId ? { approvalId } : {}),
        },
        (_judged, path) =>
          as(computerId, botId).readFile({
            ...input,
            path: path ?? input.path,
          }),
      );
    },

    /**
     * Listing is governed too, and for the same reason the read is: what a Bot has accumulated over
     * every task it has run is worth being able to restrict. A rule denying a folder hides it from the
     * listing as well as from reads, which is the consistent answer.
     */
    listFiles(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: ListFilesInput,
      approvalId?: string,
    ) {
      /*
       * NO PATH IS THE WHOLE FOLDER, AND SO IS A BLANK ONE. The computer lists the whole folder
       * for a path that is blank (`agent-computer/src/workspace.ts`, `list`), and until 2026-10-07
       * a blank path was judged as no file at all: a routine's door hands a model's `path` on as
       * it was written, so `""` listed a folder that a rule about `.` denied, on a row that named
       * nothing (the second independent read). Both are judged as `.`, as no path always was, and
       * sent with no path at all.
       */
      const named = input.path !== undefined && input.path.trim() !== "";
      return govern(
        computerId,
        "computer_list_files",
        botId,
        actor,
        {
          filePath: named ? (input.path ?? ".") : ".",
          ...(approvalId ? { approvalId } : {}),
        },
        (_judged, path) =>
          as(computerId, botId).listFiles(
            named ? { ...input, path: path ?? "." } : {},
          ),
      );
    },

    writeFile(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: WriteFileInput,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_write_file",
        botId,
        actor,
        { filePath: input.path, ...(approvalId ? { approvalId } : {}) },
        (_judged, path) =>
          as(computerId, botId).writeFile({
            ...input,
            path: path ?? input.path,
          }),
      );
    },

    /**
     * A script the Bot wrote, run over files it names — and what the script made, filed.
     *
     * NOT YET OFFERED TO ANYBODY (2026-10-07): no tool names this and no turn calls it.
     *
     * ONE CALL IS THIS SEQUENCE, FLAT, AND THERE IS NO OTHER WAY IN. Each step that touches the
     * Bot's files or runs anything is its own call of `govern` — its own decision, its own row —
     * one after another, so the trail reads in the order things happened: what it read, that it
     * ran, how it ended, what it made. Never one `govern` around the lot: that would be one
     * decision about several different things, and a rule about which files a Bot may read or
     * which names it may write would not hold for a script.
     *
     * WHAT A PERSON'S ANSWER DOES HERE. A call is retried once with the one answer a person gave,
     * and that answer is handed to every decision below in turn. Only the decision it was given
     * for can spend it: a decision the policy simply allows never looks at it (`settle.ts`), and
     * one it was not given for leaves it where it is (`approvals.ts`, `consume` — a mismatch is
     * not burned). So a yes to the run cannot be spent on a read, nor on a file's name.
     *
     * THE COSTS OF THAT ORDER, SAID HERE. A run that is refused or asked about after its files
     * were read drops the bytes; the reads' rows stand, because the reads happened. And a call
     * made again once a question is answered reads the files again and runs the script again:
     * two rows a file, bounded by how many files a run may name.
     *
     * AND TWO MORE, WHICH A DEPLOYMENT MEETS ONLY WHERE ITS OWN RULES ASK ABOUT FILES. The policy
     * every deployment starts with asks about one thing here — the same RUN a fifth time — and
     * that is one question: a file read or filed for a run is not counted as a call of its own
     * (`forScript`), so nothing but the run can come round again. It was two, until 2026-10-07,
     * and no number of yeses ran the script again. ONE ANSWER A CALL: a call that meets a second
     * question (a rule that asks about a read and about the run, or about each of two files a
     * run made) has spent the first answer by then, and made again it is asked the first again.
     * "This once" gets such a call nowhere; one of the answers has to be for longer. And A
     * QUESTION ABOUT A FILE COMES AFTER THE FILES BEFORE IT WERE FILED: made again with the
     * answer, the same call names the same folder (`madeDirectoryFor`), the file that was asked
     * about is filed, and each one filed the first time is refused by the put as already there
     * (`laf:file_exists`), untouched. Whoever offers this to a Bot has both to settle first.
     */
    async runScript(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: ScriptRunInput,
      signal?: AbortSignal,
      approvalId?: string,
    ): Promise<ScriptRun> {
      /*
       * WHOSE RUN IT IS, HELD TO THE SHAPE A BOT'S ID HAS. Every other act reaches the computer's
       * client, which is the last place that refuses an id that is not one (`client.ts`, `send`);
       * a run that names no file and makes none never does. So it is checked here, first: every
       * row a run leaves, and every file it reads or files, is one Bot's by an id of that shape.
       */
      if (!isBotId(botId)) throw new BotIdRefusedError();
      /*
       * NOWHERE TO RUN IT: said at once, before a file is read or anything is decided. Reading a
       * person's files in order to run something that cannot run would be a read for nothing, and
       * a row saying a run was allowed where no run is possible would be a row about nothing.
       */
      if (!workbench) throw new ScriptNotRunError(WORKBENCH_UNAVAILABLE);
      // What can be refused without reading anything is, and leaves no row: see `requestProblem`.
      const problem = requestProblem(input);
      if (problem) throw problem;

      /** The script's SHA-256: what every row of this run says instead of the script. */
      const sha256 = scriptDigestOf(input.script);
      /** The caller's Stop and the one answer it may be carrying, for every decision below. */
      const carried = {
        ...(signal ? { signal } : {}),
        ...(approvalId ? { approvalId } : {}),
      };

      /*
       * 1. EACH FILE THE SCRIPT IS TO READ, READ AS THE BOT'S OWN READ IS: the same decision, the
       * same row, the same rules about paths (`readFile` above). Whole and as bytes, because a
       * workbook cannot be summed from the first of it as text. A refusal or a question about any
       * one of them ends the call here, before any code runs. `forScript` says whose read it is:
       * the row carries the digest, and the read is not counted as a call of its own — the run
       * is what comes round again, and the run is what is counted (`govern.ts`).
       *
       * ONE READING OF EACH PATH, AND IT IS `govern`'S. A call names a file however a model
       * writes one — `./data.csv`, `data//2026.csv`, `"data.csv "` — and none of that is judged
       * before this (`requestProblem`). The path a rule was asked about is the one handed back
       * to the act, and that string, not the one the call wrote, is what the computer is sent,
       * what the script's file is placed under, what the run is then identified by
       * (`script.files` below) and what the caller is told. A path with no one reading, or one
       * that is no path at all, ends the call here with its row: refused by `govern`'s floor,
       * or sent as written and refused by the computer — as the Bot's own read is.
       */
      const files: WorkbenchFile[] = [];
      let together = 0;
      // Each file once, however often and however differently it was named (`filesNamedBy`).
      for (const named of filesNamedBy(input)) {
        let path = named;
        const bytes = await govern(
          computerId,
          "computer_read_file",
          botId,
          actor,
          { filePath: named, forScript: sha256, ...carried },
          (_judged, judgedPath) => {
            path = judgedPath ?? named;
            return as(computerId, botId).fileBytes(path);
          },
        );
        /*
         * The one bound that cannot be seen before a file is read: what they come to together.
         * Held here, as each arrives, rather than left to the sandbox's client to refuse once all
         * eight are in hand — this is the API server's memory, and the next file is not read. No
         * row for it, as for any request over a bound; the reads that happened have theirs.
         */
        together += bytes.byteLength;
        if (together > WORKBENCH_LIMITS.filesBytes) {
          throw new ScriptNotRunError(SCRIPT_INPUTS_INVALID, {
            field: "files",
            limit: WORKBENCH_LIMITS.filesBytes,
          });
        }
        /*
         * STAGED UNDER THE PATH IT WAS JUDGED AND READ BY — AND NOTHING ELSE IS STAGED. This is
         * the invariant the rest leans on: the sandbox holds only files that were judged, each
         * under the one spelling a rule was asked about. So whatever string a script opens —
         * the `./data.csv` its call gave, `data//2026.csv`, a name its call never gave at all —
         * it cannot reach a file that was not judged, because there is no other file there. The
         * operating system resolves the script's own `./data.csv` to the `data.csv` staged
         * here. What it does not resolve is the little the reading took off that it would not:
         * white space at an end of the path, a slash after a file's name. A script that opens
         * exactly that fails on its own line, with the read already on the trail, and the
         * caller has been told the name its file is under (`files` on what it is handed back).
         */
        files.push({ path, bytes });
      }
      /** What a run is, to every reader that tells one from another: by the files AS READ. */
      const script = {
        sha256,
        bytes: Buffer.byteLength(input.script),
        files: files.map((file) => file.path),
      };

      /*
       * 2. THE RUN, and its act is the sandbox call and nothing else. The decision's row is
       * written before a byte is sent there; the caller's Stop ends the script through the same
       * signal. A run that produced no ending is thrown, so that `govern` writes it down as
       * allowed and not happened — unreachable, busy, stopped, or not vouched for.
       */
      const answer = await govern(
        computerId,
        RUN_SCRIPT_TOOL,
        botId,
        actor,
        {
          script,
          // Not saying a time is asking for the time a run gets: one call, said either way.
          timeoutMs: input.timeoutMs ?? WORKBENCH_LIMITS.timeoutMs,
          ...carried,
        },
        async () => {
          const answered = await workbench.run(
            {
              script: input.script,
              files,
              ...(input.timeoutMs === undefined
                ? {}
                : { timeoutMs: input.timeoutMs }),
            },
            signal,
          );
          if (!answered.ok) throw notRunFor(answered);
          /*
           * A file's name becomes part of a path below and a field of a row. The client has held
           * each to what a name may be already (`workbench/client.ts`, `runFrom`); this is the
           * place that composes the path not taking that on trust from whatever stands where the
           * client does. An answer with a name that is not one is not a run to vouch for.
           */
          if (!areProductNames(answered.products.map(({ name }) => name))) {
            throw new ScriptNotRunError(WORKBENCH_FAILED);
          }
          return answered;
        },
      );
      const { run } = answer;
      /** What the caller is handed: how it ended, what it printed, and what became of its files. */
      const ended = (products: ScriptProduct[]): ScriptRun => ({
        sha256: script.sha256,
        ending: run.ending,
        exitCode: run.exitCode,
        signal: run.signal,
        ms: run.ms,
        stdout: run.stdout,
        stderr: run.stderr,
        stdoutBytes: run.stdoutBytes,
        stderrBytes: run.stderrBytes,
        ...(run.productsRefused
          ? { productsRefused: run.productsRefused }
          : {}),
        skipped: run.skipped,
        files: script.files,
        products,
      });

      /*
       * 3. HOW IT ENDED, WRITTEN BEFORE ANY FILE IT MADE IS FILED. A trail that will not take
       * this row throws here, and then nothing below runs: no file enters the folder with nothing
       * saying where it came from — the rule a download keeps on the way out (`person-files.ts`).
       *
       * AND BEFORE THE CALL WAITS ON ANYTHING — its turn among the calls filing, or a word from
       * the computer. For one afternoon (2026-10-07) this row was written after the look at
       * `made/` below, so that it could say itself that nothing would be filed; a server that
       * stopped while that request waited, for as long as the computer's whole timeout, left a
       * run that had happened with a row saying it was allowed and none saying how it ended
       * (Codex, on that pull request). How a run ended is known here, and is written here.
       */
      await writeScriptFinished(auditStore, {
        toolName: RUN_SCRIPT_TOOL,
        botId,
        actor,
        computerId,
        script,
        ending: run.ending,
        exitCode: run.exitCode,
        signal: run.signal,
        ms: run.ms,
        stdoutBytes: run.stdoutBytes,
        stderrBytes: run.stderrBytes,
        products: answer.products.map((product) => ({
          name: product.name,
          bytes: product.bytes.byteLength,
        })),
        productsRefused: run.productsRefused,
        skipped: run.skipped,
      });
      const products: ScriptProduct[] = [];
      // A run that made nothing has nothing to wait its turn for.
      if (answer.products.length === 0) return ended(products);

      /*
       * 4. EACH FILE IT MADE, FILED AS THE BOT'S OWN WRITE IS DECIDED: a deployment's rules about
       * names and folders hold for what a script makes. To a folder this server named, by a put
       * that creates and never replaces (`client.ts`, `putFile`) — whatever a rule allows, nothing
       * that exists is written over.
       *
       * A FILE THAT IS NOT FILED DOES NOT TAKE THE OTHERS WITH IT, AND DOES NOT TAKE THE RUN. The
       * script ran; what it printed is the caller's whatever becomes of a file. So a rule that
       * refuses one name, a folder that is full, a computer that will not take a file: each is
       * said of that file, with its own row, and the next is tried. Two things do end the call —
       * a question, which is a pause the same call comes back from, and the caller's Stop.
       *
       * AND EVERY FILE THE ENDING NAMES IS SAID SOMETHING OF, SOMEWHERE (the second read of this
       * act, which found three ways one was not). A file that is tried has its decision and what
       * came of it. After the computer has stopped answering, each file left is still decided —
       * a rule about its name still refuses it — and its act fails at once with what the
       * computer said, undialled. Where the filing ends before a file is reached, by a Stop or
       * at a question, the files after that are named on one row (`writeScriptFilesLeft`). And
       * where no file can be filed at all because `made` is not a folder, that row names every
       * one of them and says so.
       */
      const directory = madeDirectoryFor(now(), {
        botId,
        threadId: actor.threadId,
        toolCallId: actor.toolCallId,
        sha256: script.sha256,
        files: script.files,
      });
      /**
       * The files nobody tried, on one row. An observation: a trail that will not take it is
       * logged, and never replaces what ended the call — or, where nothing did, what it returns.
       */
      const leave = async (
        left: readonly { name: string; bytes: Uint8Array }[],
        because: string,
      ) => {
        if (left.length === 0) return;
        try {
          await writeScriptFilesLeft(auditStore, {
            toolName: RUN_SCRIPT_TOOL,
            botId,
            actor,
            computerId,
            script,
            because,
            left: left.map((product) => ({
              name: product.name,
              bytes: product.bytes.byteLength,
            })),
          });
        } catch (error) {
          log.error("script_files_left_row_lost", {
            bot: botId,
            files: left.length,
            because,
            reason: error,
          });
        }
      };
      await oneAtATime(async () => {
        /** What `made/` holds, asked once and only when there is something to file. */
        let held: number | undefined;
        /** The computer stopped answering: what is left is not tried against it one by one. */
        let unreachable: string | undefined;
        /*
         * WHAT `made/` IS, ASKED BEFORE ANY FILE IS TRIED — for the one answer that settles
         * every file of this run and is about none of them: where the folder belongs there is a
         * FILE. Until 2026-10-07 that was found once for each file, each with a decision and a
         * failed row (`laf:file_wrong_kind`), for every run, for good, since nothing here removes
         * a file. One row says it of all of them instead, and nothing is tried.
         */
        // Not for a caller that has stopped: nothing will be filed, and nothing is dialled.
        if (!signal?.aborted) {
          try {
            held = await madeHeldBy(as(computerId, botId), signal);
          } catch (error) {
            /*
             * AND NOT WHERE THE CALLER STOPPED WHILE THE FOLDER WAS BEING DESCRIBED. The look
             * is handed the Stop and is ended by it — but an answer that was already on its
             * way when the Stop landed is still an answer, and is seen only now. A call
             * somebody stopped does not go on to return as one that completed (Codex, on the
             * pull request that added this): it falls to the first file below, where `govern`
             * ends it as every stopped call is ended, and the files are named as left by the
             * Stop.
             */
            if (isNotAFolder(error) && !signal?.aborted) {
              await leave(answer.products, MADE_NOT_A_FOLDER);
              for (const product of answer.products) {
                products.push({
                  name: product.name,
                  bytes: product.bytes.byteLength,
                  unfiled: MADE_NOT_A_FOLDER,
                });
              }
              return;
            }
            if (error instanceof ComputerUnavailableError) {
              unreachable = factOfError(error);
            }
            // Anything else is asked again by the first file's own act, and said of that file.
          }
        }
        for (const [index, product] of answer.products.entries()) {
          const size = product.bytes.byteLength;
          /*
           * COMPOSED HERE, AND READ ONCE LIKE ANY PATH: `govern` is handed the folder and the
           * name, and the computer is sent the path it hands back — which is also where the
           * caller is told the file is. A name the daemon hands back composes to a path that is
           * its own spelling (`isProductName`, and a test over the names); this does not rest on
           * it, and a path that had no one reading would be refused there, of this file alone.
           */
          const composed = `${directory}/${product.name}`;
          /** Whether `govern` reached this file's act: its decision is on the trail by then. */
          let decided = false;
          try {
            let path = composed;
            await govern(
              computerId,
              "computer_write_file",
              botId,
              actor,
              { filePath: composed, forScript: script.sha256, ...carried },
              async (_judged, judgedPath) => {
                decided = true;
                path = judgedPath ?? composed;
                // Decided, with its row — and not dialled again where a file before it found
                // the computer gone: the same fact, at once.
                if (unreachable)
                  throw new ComputerUnavailableError(unreachable);
                try {
                  held ??= await madeHeldBy(as(computerId, botId), signal);
                  if (held + size > madeMaxBytes) {
                    throw madeFull(held, size, madeMaxBytes);
                  }
                  const filed = await as(computerId, botId).putFile(
                    path,
                    product.bytes,
                  );
                  held += filed.bytes;
                  return filed;
                } catch (error) {
                  /*
                   * A FAILURE NOBODY NAMED IS STILL THIS FILE'S, AND IS SAID AS A FACT. A bug
                   * in putting one file — the first was a name that was half a character, at
                   * which the computer's client throws — used to leave this loop as itself: the
                   * failed row held an exception's words, the files after it were never tried
                   * and the caller was told nothing of a script that had run. It is that file
                   * not being kept, for a reason nobody named.
                   */
                  if (
                    error instanceof Error &&
                    error.message.startsWith("laf:")
                  ) {
                    throw error;
                  }
                  log.error("script_file_not_put", {
                    bot: botId,
                    reason: error,
                  });
                  throw new WorkspaceRequestError(COMPUTER_FAILED);
                }
              },
            );
            products.push({ name: product.name, bytes: size, path });
          } catch (error) {
            const asked = error instanceof ActionNeedsApprovalError;
            if (asked || signal?.aborted) {
              /*
               * THE CALL ENDS HERE, AND THE FILES IT DID NOT GET TO ARE NAMED. This one has its
               * own rows where anything was decided of it — the question, a refusal, an act
               * that was stopped — and is among those left where nothing was: a caller that
               * has stopped is not governed at all (`govern`).
               */
              const said =
                decided || asked || error instanceof ActionRefusedError;
              await leave(
                answer.products.slice(said ? index + 1 : index),
                asked ? error.code : STOPPED,
              );
              throw error;
            }
            /*
             * A fact about THIS file — the rule that refused its name, the folder being full, what
             * the computer said of it — is said of it, and the next is tried. Anything that is not
             * a fact came from `govern` itself, not from the act: a trail that would not take the
             * decision's row. That ends the call, rather than being reported as a file the
             * computer declined — nothing below it could be recorded either.
             */
            if (!(error instanceof Error && error.message.startsWith("laf:"))) {
              throw error;
            }
            const fact =
              error instanceof ActionRefusedError
                ? error.code
                : factOfError(error);
            if (error instanceof ComputerUnavailableError) unreachable = fact;
            products.push({ name: product.name, bytes: size, unfiled: fact });
          }
        }
      });

      return ended(products);
    },
  };
}
