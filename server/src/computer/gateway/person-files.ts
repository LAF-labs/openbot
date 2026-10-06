/**
 * A person and their Bot's folder: what is in it, one file's facts, and taking a file out.
 *
 * Apart from the acting calls for the reason `handovers.ts` is, and it is the same decision: none
 * of these goes through `govern`. The policy constrains what a BOT may do with its files — `acts.ts`
 * judges its reads, its listings and its writes — and the folder is kept for the person the Bot
 * works for. A rule able to keep somebody from the file their own Bot wrote for them would be the
 * boundary pointed the wrong way round. Whose Bot it is, is the routes' question
 * (`requireBotAccess`), asked before anything here runs.
 *
 * What IS recorded is a file leaving: who took which path out of which Bot's folder, and how big.
 * A reader checking that every way out of the folder leaves a row reads this and `uploadFile`.
 */
import {
  fileNameOf,
  inlineImageTypeOf,
  isHiddenPath,
} from "../../../../shared/workspace-files";
import type { AuditStore } from "../../audit";
import type { ComputerClient } from "../client";
import type { FileFacts, ListFilesResult } from "../schema";
import { workspacePathOf } from "./addresses";
import type { ActionActor } from "./caller";
import { writeFileDownloaded } from "./trail";

/** A file on its way to a person: its bytes, and what it may go out as. */
export type HandedFile = {
  /** The last part of its path; `file` for a path that names nothing a download can be called. */
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  /**
   * The picture type it is DRAWN as, when a preview was asked for and the file is one — by its name
   * and by how it starts, both (`inlineImageTypeOf`). Null is a download, which is every other case.
   */
  drawnAs: string | null;
};

export function createPersonFiles(deps: {
  /** The computer, addressed as the Bot whose folder it is. See `createComputerGateway`. */
  as: (botId: string) => ComputerClient;
  auditStore: AuditStore;
}) {
  const { as, auditStore } = deps;

  return {
    /**
     * The folder as a person is shown it: the Bot's own listing, less everything hidden.
     *
     * `.results/` is the runtime's filing of long tool results (`shared/spillover.ts`), not
     * something the Bot made for anybody. Taken out HERE, after the computer's walk, so the walk a
     * Bot's `computer_list_files` gets is unchanged — that folder is exactly where a cut result
     * tells the Bot its whole answer is. The cost is said rather than hidden: the walk still spends
     * its bound on what is then left out, and `truncated` is the computer's own word for that.
     *
     * A read, so no row.
     */
    async personFiles(botId: string, path?: string): Promise<ListFilesResult> {
      const listed = await as(botId).listFiles(path ? { path } : {});
      return {
        ...listed,
        entries: listed.entries.filter((entry) => !isHiddenPath(entry.path)),
      };
    },

    /**
     * Whether a path is a file in this Bot's folder, and how big. A read, so no row.
     *
     * Asked by the file card before it draws a button, and by a turn before it tells the Bot its
     * card is on screen (`turns/chat-tools.ts`) — the runtime checking a fact, not the Bot reading
     * a file, which is why that check is not a `computer_read_file` in the trail either.
     */
    fileFacts(botId: string, path: string): Promise<FileFacts> {
      return as(botId).statFile(path);
    },

    /**
     * A file's bytes, for the person to keep — or, where `preview` asked and the file is a picture,
     * to be drawn in the card.
     *
     * THE ROW IS WRITTEN HERE, BETWEEN THE BYTES ARRIVING AND THEIR BEING HANDED ON, and a trail
     * that will not take it fails the download: there is no path on which a file leaves as a file
     * and nothing says so. A preview writes none (see `computer.file_downloaded`), and whether this
     * IS a preview is decided here, from the bytes, rather than by the caller having asked for one —
     * `?inline=1` on a spreadsheet is a download, and is recorded as one.
     */
    async downloadFile(
      computerId: string,
      botId: string,
      actor: ActionActor,
      path: string,
      options: { preview?: boolean } = {},
    ): Promise<HandedFile> {
      /*
       * THE ROW NAMES THE FILE AS EVERY OTHER ROW ABOUT IT DOES. Nothing is decided here — this is
       * the person's own door — but the trail's rows about one file are found by its path, and a
       * Bot's rows carry the path in its one spelling since 2026-10-07 (`addresses.ts`,
       * `workspacePathOf`). So the download is asked for, named and recorded in that spelling too.
       */
      const file = workspacePathOf(path) ?? path;
      const bytes = await as(botId).downloadFile(file);
      const name = fileNameOf(file) || "file";
      const drawnAs = options.preview ? inlineImageTypeOf(name, bytes) : null;
      if (!drawnAs) {
        await writeFileDownloaded(auditStore, {
          botId,
          actor,
          computerId,
          filePath: file,
          bytes: bytes.byteLength,
        });
      }
      return { name, bytes, drawnAs };
    },
  };
}
