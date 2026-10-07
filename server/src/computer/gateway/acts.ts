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
  SCRIPT_INPUTS_INVALID,
  WORKBENCH_FAILED,
  WORKBENCH_UNAVAILABLE,
} from "../../audit";
import type { Workbench, WorkbenchFile } from "../../workbench/client";
import { BotIdRefusedError, isBotId } from "../bot-id";
import {
  type ComputerClient,
  ComputerUnavailableError,
  factOfError,
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
import { writeScriptFinished } from "./trail";

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
  as: (botId: string) => ComputerClient;
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
        (judged) => as(botId).click(heldTo(input, judged), signal),
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
        (judged) => as(botId).type(heldTo(input, judged), signal),
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
        (judged) => as(botId).key(heldTo(input, judged), signal),
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
        () => as(botId).scroll(input),
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
        () => as(botId).switchTab(input),
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
          as(botId).uploadFile(
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
          as(botId).readFile({ ...input, path: path ?? input.path }),
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
          as(botId).listFiles(named ? { ...input, path: path ?? "." } : {}),
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
          as(botId).writeFile({ ...input, path: path ?? input.path }),
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
       * ONE READING OF EACH PATH, AND IT IS `govern`'S. The path a rule was asked about is the
       * one handed back to the act, and that string — not the one the call wrote — is what the
       * computer is sent, what the script's file is placed under, and what the run is then
       * identified by (`script.files` below). The two are the same string for every path that
       * gets this far (`requestProblem`); nothing here rests on that. A path with no one reading
       * does not get this far: `govern` refuses it, with its row, and that ends the call.
       */
      const files: WorkbenchFile[] = [];
      let together = 0;
      for (const named of input.files) {
        let path = named;
        const bytes = await govern(
          computerId,
          "computer_read_file",
          botId,
          actor,
          { filePath: named, forScript: sha256, ...carried },
          (_judged, judgedPath) => {
            path = judgedPath ?? named;
            return as(botId).fileBytes(path);
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
        { script, ...carried },
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
        products,
      });

      /*
       * 3. HOW IT ENDED, WRITTEN BEFORE ANY FILE IT MADE IS FILED. A trail that will not take
       * this row throws here, and then nothing below runs: no file enters the folder with nothing
       * saying where it came from — the rule a download keeps on the way out (`person-files.ts`).
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
       */
      const directory = madeDirectoryFor(now(), {
        botId,
        threadId: actor.threadId,
        toolCallId: actor.toolCallId,
        sha256: script.sha256,
        files: script.files,
      });
      const products: ScriptProduct[] = [];
      // A run that made nothing has nothing to wait its turn for.
      if (answer.products.length === 0) return ended(products);
      await oneAtATime(async () => {
        /** What `made/` holds, asked once and only when there is something to file. */
        let held: number | undefined;
        /** The computer stopped answering: what is left is not tried against it one by one. */
        let unreachable: string | undefined;
        for (const product of answer.products) {
          const size = product.bytes.byteLength;
          if (unreachable) {
            products.push({
              name: product.name,
              bytes: size,
              unfiled: unreachable,
            });
            continue;
          }
          /*
           * COMPOSED HERE, AND READ ONCE LIKE ANY PATH: `govern` is handed the folder and the
           * name, and the computer is sent the path it hands back — which is also where the
           * caller is told the file is. A name the daemon hands back composes to a path that is
           * its own spelling (`isProductName`, and a test over the names); this does not rest on
           * it, and a path that had no one reading would be refused there, of this file alone.
           */
          const composed = `${directory}/${product.name}`;
          try {
            let path = composed;
            await govern(
              computerId,
              "computer_write_file",
              botId,
              actor,
              { filePath: composed, forScript: script.sha256, ...carried },
              async (_judged, judgedPath) => {
                path = judgedPath ?? composed;
                held ??= await madeHeldBy(as(botId));
                if (held + size > madeMaxBytes) {
                  throw madeFull(held, size, madeMaxBytes);
                }
                const filed = await as(botId).putFile(path, product.bytes);
                held += filed.bytes;
                return filed;
              },
            );
            products.push({ name: product.name, bytes: size, path });
          } catch (error) {
            if (error instanceof ActionNeedsApprovalError) throw error;
            if (signal?.aborted) throw error;
            /*
             * A fact about THIS file — the rule that refused its name, the folder being full, what
             * the computer said of it — is said of it, and the next is tried. Anything that is not
             * a fact is a failure nobody named: a trail that would not take the decision's row, a
             * bug. That ends the call, rather than being reported as a file the computer declined.
             */
            if (!(error instanceof Error && error.message.startsWith("laf:"))) {
              throw error;
            }
            const unfiled =
              error instanceof ActionRefusedError
                ? error.code
                : factOfError(error);
            if (error instanceof ComputerUnavailableError)
              unreachable = unfiled;
            products.push({ name: product.name, bytes: size, unfiled });
          }
        }
      });

      return ended(products);
    },
  };
}
