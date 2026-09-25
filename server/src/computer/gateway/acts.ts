/**
 * The acting calls: each one names its tool and its subject, and hands the rest to `govern`.
 *
 * Thin on purpose, and kept apart from the decision so that they stay thin. Nothing in this file
 * decides anything: what a method may add is what the policy needs to know about its call — the key,
 * whether it submits, which file — and the one promise every call on a ref makes to the computer,
 * that the click lands on the control the policy judged and not on whatever the page renamed it to.
 */
import type { ComputerClient } from "../client";
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
import type { ActionActor } from "./caller";
import type { Govern, JudgedElement } from "./govern";

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
}) {
  const { as, govern } = deps;

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
        (judged) => as(botId).uploadFile(heldTo(input, judged), signal),
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
        () => as(botId).readFile(input),
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
      return govern(
        computerId,
        "computer_list_files",
        botId,
        actor,
        {
          filePath: input.path ?? ".",
          ...(approvalId ? { approvalId } : {}),
        },
        () => as(botId).listFiles(input),
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
        () => as(botId).writeFile(input),
      );
    },
  };
}
