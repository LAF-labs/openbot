import {
  previewOf,
  spillPath,
  TOOL_RESULT_PREVIEW,
} from "../../../shared/spillover";
import type { WriteFileInput, WriteFileResult } from "./schema";

/**
 * Filing a long tool result on the Bot's computer, so the model is shown a preview instead.
 *
 * THE NARROW INTERNAL WRITE. It reaches the computer's file API directly, as the Bot, and never
 * through the gateway: this is not the Bot acting, it is the runtime keeping what the Bot was
 * already handed, and a policy question or an audit row saying "the Bot wrote a file" would be a
 * lie about who did what. It writes to one directory (`.results/`), to a name made from the tool
 * call's id, and nothing else — reading the file back is `computer_read_file`, which IS governed,
 * so a deployment that restricts what a Bot may read restricts this too.
 *
 * NOTHING TYPED REACHES THIS. A tool result is what the computer said back — a page's text, a
 * listing, an approval — and the results of typing carry no value by construction (`TypeInput`
 * is fingerprinted, `WriteFileResult` echoes no contents). The same rule as the audit trail and
 * the demonstration recorder: record that a thing happened and where, never what somebody typed.
 *
 * WHOLE THE FIRST TIME, A PREVIEW FROM THEN ON. The run that receives a result is the run that
 * needs it — the model just asked for that page — so it is forwarded whole while the write starts
 * in the background. Every later run resends the same result and only has to recognise it, and
 * that is where the preview and the path go. The write is in the background because AG-UI
 * middleware answers synchronously with an observable, and a preview that names a file the
 * computer has not yet confirmed would be a promise the model cannot cash: the preview is only
 * ever shown once the write has come back, and a failed write leaves the result whole.
 *
 * IN-PROCESS STATE, ON PURPOSE. What is on file is remembered here rather than asked of the
 * computer on every run (a `list` per tool message per run would cost more than the tokens it
 * saves). One server process per VM, see docs/laf/deployment-model.md; a restart forgets and
 * refiles once, which is idempotent.
 */

/** The one method this needs of the computer client, so a test can hand in a recorder. */
export type ResultFiler = {
  forBot(botId: string): {
    writeFile(input: WriteFileInput): Promise<WriteFileResult>;
  };
};

export type ResultSpill = {
  /**
   * What the endpoint is shown for one tool result: the text itself while it is short or not yet
   * on file, the preview and the path once it is.
   */
  forModel(botId: string, toolCallId: string, text: string): string;
  /** Resolves once every write started so far has landed or failed. For tests and shutdown. */
  settled(): Promise<void>;
};

/** How many filed results are remembered before the oldest are forgotten (and refiled if seen). */
const MOST_REMEMBERED = 10_000;

/** How long a failed write is left alone before the same result is tried again. */
const RETRY_AFTER_MS = 60_000;

export function createResultSpill(
  client: ResultFiler,
  options: { log?: (line: string) => void } = {},
): ResultSpill {
  const log = options.log ?? ((line: string) => console.warn(line));
  /** Insertion-ordered, so trimming it forgets the oldest. */
  const onFile = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const failedAt = new Map<string, number>();

  const file = (key: string, botId: string, path: string, text: string) => {
    const write = client
      .forBot(botId)
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
        log(
          `[spillover] ${botId} could not file ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, write);
  };

  return {
    forModel(botId, toolCallId, text) {
      if (text.length <= TOOL_RESULT_PREVIEW) return text;
      const path = spillPath(toolCallId);
      const key = `${botId}\n${path}`;
      if (onFile.has(key)) return previewOf(text, path);
      const lastFailure = failedAt.get(key);
      const coolingDown =
        lastFailure !== undefined && Date.now() - lastFailure < RETRY_AFTER_MS;
      if (!inFlight.has(key) && !coolingDown) file(key, botId, path, text);
      return text;
    },

    async settled() {
      await Promise.all([...inFlight.values()]);
    },
  };
}
