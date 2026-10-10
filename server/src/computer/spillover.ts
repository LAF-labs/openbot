import {
  previewOf,
  spillPath,
  TOOL_RESULT_CUT,
} from "../../../shared/spillover";
import {
  type FileScope,
  MAIN_SCOPE,
  placedForWrite,
  projectFolder,
} from "../../../shared/file-scope";
import { log } from "../log";
import type { WriteFileInput, WriteFileResult } from "./schema";

/**
 * Cutting a long tool result once, where the server first sees it, and filing the whole of it on
 * the Bot's computer.
 *
 * THE CUT IS A PURE FUNCTION OF THE RESULT (agent-harness-design row 8). What the model is shown
 * for a result is decided by its length alone — whole at or under `TOOL_RESULT_CUT`, the head and
 * the path over it — on the first run that carries it and on every run after, so a result is
 * final when produced and the conversation behind it stays byte for byte what the provider cached.
 * It used to be whole on the first run and a 1,500-character preview from the next, which rewrote
 * every long result one step after the provider had cached it: a ten-step browsing question read
 * 54% of its prompt from cache (eval:cache, 2026-09-25).
 *
 * THE NARROW INTERNAL WRITE. The whole is filed on the computer directly, as the Bot, and never
 * through the gateway: this is not the Bot acting, it is the runtime keeping what the Bot was
 * already handed, and a policy question or an audit row saying "the Bot wrote a file" would be a
 * lie about who did what. It writes to one directory (`.results/`), to a name made from the tool
 * call's id, and nothing else — reading the file back is `computer_read_file`, which IS governed.
 *
 * NOTHING TYPED REACHES THIS. A tool result is what the computer said back — a page's text, a
 * listing, an approval — and the results of typing carry no value by construction (`TypeInput`
 * is fingerprinted, `WriteFileResult` echoes no contents). The same rule as the audit trail's
 * fingerprint: record that a thing happened and where, never what somebody typed.
 *
 * The write is in the background because AG-UI middleware answers synchronously with an
 * observable; it lands in milliseconds, long before a model has read the preview and asked for the
 * file. A failed write is logged and tried again the next time the result is seen — the preview
 * does not change on its account, because a preview that depended on the write would be a result
 * rewritten under the cache.
 *
 * IN-PROCESS STATE, ON PURPOSE. What is on file is remembered here rather than asked of the
 * computer on every run. One server process per VM, see docs/laf/deployment-model.md; a restart
 * forgets and refiles once, which is idempotent.
 */

/** The one method this needs of the computer client, so a test can hand in a recorder. */
export type ResultFiler = {
  forBot(
    botId: string,
    inBrowser?: string | null,
    as?: FileScope,
  ): {
    writeFile(input: WriteFileInput): Promise<WriteFileResult>;
  };
};

export type ResultSpill = {
  /**
   * What the endpoint is shown for one tool result: the text itself while it is within the bound,
   * the head and the path when it is over — the same answer every time it is asked.
   */
  forModel(
    botId: string,
    toolCallId: string,
    text: string,
    /** The conversation the result is in: a project's is filed in the project's own folder. */
    threadId?: string,
  ): string;
  /** Resolves once every write started so far has landed or failed. For tests and shutdown. */
  settled(): Promise<void>;
  /** The same, for the writes into one project's folder: what deleting the project waits on. */
  settledFor(projectId: string): Promise<void>;
};

/** How many filed results are remembered before the oldest are forgotten (and refiled if seen). */
const MOST_REMEMBERED = 10_000;

/** How long a failed write is left alone before the same result is tried again. */
const RETRY_AFTER_MS = 60_000;

export function createResultSpill(
  client: ResultFiler,
  options: {
    log?: (line: string) => void;
    /** Whose files a thread's run may touch (`channels/thread-projects.ts`). Absent: the main folder's. */
    scopeOfThread?: (threadId: string | undefined) => FileScope;
  } = {},
): ResultSpill {
  const say =
    options.log ??
    ((line: string) => log.warn("spillover_not_filed", { message: line }));
  /** Insertion-ordered, so trimming it forgets the oldest. */
  const onFile = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const failedAt = new Map<string, number>();

  const file = (
    key: string,
    botId: string,
    path: string,
    text: string,
    scope: FileScope,
  ) => {
    const write = client
      .forBot(botId, undefined, scope)
      .writeFile({ path, contents: text })
      .then(() => {
        onFile.add(key);
        failedAt.delete(key);
        if (onFile.size > MOST_REMEMBERED) {
          const oldest = onFile.values().next().value;
          if (oldest !== undefined) onFile.delete(oldest);
        }
      })
      .catch((error: unknown) => {
        failedAt.set(key, Date.now());
        say(
          `[spillover] ${botId} could not file ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, write);
  };

  return {
    forModel(botId, toolCallId, text, threadId) {
      if (text.length <= TOOL_RESULT_CUT) return text;
      /*
       * A PROJECT'S RESULT IS FILED IN THE PROJECT'S FOLDER, and the line that closes the cut
       * names it there: the whole of a result is the conversation's own words, and it goes when
       * the project does (`shared/file-scope.ts`). The same place every time it is asked — a
       * thread is a project's for as long as it exists.
       */
      const scope = options.scopeOfThread?.(threadId) ?? MAIN_SCOPE;
      const path =
        placedForWrite(scope, spillPath(toolCallId)) ?? spillPath(toolCallId);
      const key = `${botId}\n${path}`;
      const lastFailure = failedAt.get(key);
      const coolingDown =
        lastFailure !== undefined && Date.now() - lastFailure < RETRY_AFTER_MS;
      if (!onFile.has(key) && !inFlight.has(key) && !coolingDown) {
        file(key, botId, path, text, scope);
      }
      return previewOf(text, path);
    },

    async settled() {
      await Promise.all([...inFlight.values()]);
    },

    async settledFor(projectId) {
      const folder = `${projectFolder(projectId)}/`;
      await Promise.all(
        [...inFlight]
          .filter(([key]) => (key.split("\n")[1] ?? "").startsWith(folder))
          .map(([, write]) => write),
      );
    },
  };
}
