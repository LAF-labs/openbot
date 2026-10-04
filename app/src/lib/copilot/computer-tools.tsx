import { useFrontendTool } from "@copilotkit/react-core/v2";
import { computerTool } from "@shared/tools/computer";
import { asStandardSchema } from "@shared/tools/standard-schema";
import { ApprovalRequest } from "@/components/channels/approval-request";
import { ToolLine } from "@/components/channels/tool-line";
import { HelpCard } from "@/components/computer/help-card";
import { didNotWork, labelForCode, outcomeOf } from "@/lib/computer/browsing";
import { t } from "@/lib/i18n";

/**
 * Frontend registrations for computer tools: what the turn is told this window can draw, and the
 * transcript line each call is drawn as.
 *
 * The names, descriptions and schemas come from `shared/tools/computer.ts` — the same objects the
 * server's unattended loop and the eval pack hand to a model. A conversation hands them to the
 * server with each message (`buildFrontendTools`, `server-channel-chat.tsx`) and the turn offers
 * the Bot the same ones.
 *
 * NO HANDLERS. Each registration here used to carry one: the Bot asked for a click, its run ended,
 * and this window made the click through `/api/computers/…` and started the next run with the
 * result — waiting on the person's 허용 or on the wheel coming back where the call needed one. The
 * server carries the calls out since v0.5.7 (`server/src/turns/chat-tools.ts`), and the window that
 * did was removed 2026-10-05; nothing calls a frontend tool's handler any more, and CopilotKit does
 * not need one to list a tool or draw its line.
 *
 * TWO READERS, TWO LANGUAGES, ONE FACT. What a tool hands back carries a `code`; the sentence the
 * MODEL reads comes from `shared/prompt/tool-results.ko.ts`, and the words a PERSON reads on the
 * transcript line come from `t()`. They are not the same sentence — one says what to do next and
 * the other says what happened — and the code is what keeps them from drifting apart.
 */

/**
 * A tool's name, description and schema, straight from the catalogue.
 *
 * Throws on a name the catalogue does not have, at first render rather than at the first call: a
 * tool registered under a name nothing describes is a tool the model is handed with an empty
 * contract, and that failure is silent everywhere else.
 */
function fromCatalogue<T extends Record<string, unknown>>(name: string) {
  const tool = computerTool(name);
  if (!tool) {
    throw new Error(`No computer tool named ${name} is in the catalogue.`);
  }
  return {
    name: tool.name,
    description: tool.description,
    parameters: asStandardSchema<T>(tool.parameters),
  };
}

/**
 * A compact transcript line that distinguishes policy refusals from ordinary failures.
 *
 * While the action is still running it also carries the place a question about it appears. The card
 * belongs on the line for the action it is about, in sequence, rather than somewhere else on the
 * screen: a person deciding whether to allow a click wants to see what the Bot did to get there.
 */
function ActionLine({
  toolCallId,
  label,
  detail,
  running,
  refused,
  failed,
}: {
  /**
   * Which call this line is reporting.
   *
   * The card shows a question only when this exact call raised one, so a line for an action nobody
   * was asked about stays a line. Passing the Bot instead would draw whatever that Bot happened to
   * be waiting on, which on a second turn is somebody else's abandoned question.
   */
  toolCallId?: string;
  label: string;
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
}) {
  return (
    <>
      <ApprovalRequest toolCallId={toolCallId} />
      <ToolLine
        detail={detail}
        failed={failed}
        label={label}
        refused={refused}
        running={running}
      />
    </>
  );
}

export function ComputerTools() {
  /*
   * THE BROWSER CALLS HAVE NO `render`. The transcript folds calls in a row into one browsing task
   * and draws it as one card (`chat-messages.ts` → `browsing-card.tsx`), with each call's line and
   * any question about it inside. A render here would never be asked for. The workspace's file calls
   * and the two requests for a person still draw their own.
   */
  useFrontendTool(fromCatalogue<{ url: string }>("computer_navigate"));

  useFrontendTool(
    fromCatalogue<{ whole?: boolean; from?: string }>("computer_read"),
  );

  useFrontendTool(fromCatalogue<Record<string, never>>("computer_snapshot"));

  useFrontendTool(
    fromCatalogue<{
      ref: string;
      snapshotId: number;
      text: string;
      submit?: boolean;
    }>("computer_type"),
  );

  useFrontendTool(
    fromCatalogue<{ ref: string; snapshotId: number }>("computer_click"),
  );

  useFrontendTool(
    fromCatalogue<{ key: string; ref?: string; snapshotId?: number }>(
      "computer_key",
    ),
  );

  useFrontendTool({
    ...fromCatalogue<{ label: string; ref: string; snapshotId: number }>(
      "computer_request_secret",
    ),
    // A card in the conversation with the masked box, where the Bot asked — never a pop-up. It is
    // not told whose computer: this closure is drawn through a memo and would hand it a stale
    // holder, so the card reads the declared Bot itself (`help-card.tsx`). The same below.
    render: ({ args, result, status, toolCallId }) => (
      <HelpCard
        kind="secret"
        result={result}
        said={typeof args?.label === "string" ? args.label : undefined}
        status={status}
        toolCallId={toolCallId}
      />
    ),
  });

  useFrontendTool({
    ...fromCatalogue<{ reason: string }>("computer_request_help"),
    // A card in the conversation: 직접 하기, 다 했어요, 건너뛰기 (`help-card.tsx`).
    render: ({ args, result, status, toolCallId }) => (
      <HelpCard
        kind="help"
        result={result}
        said={typeof args?.reason === "string" ? args.reason : undefined}
        status={status}
        toolCallId={toolCallId}
      />
    ),
  });

  useFrontendTool({
    ...fromCatalogue<{ path?: string }>("computer_list_files"),
    render: ({ result, status, toolCallId }) => {
      const outcome = outcomeOf(result);
      const entries = Array.isArray(outcome.entries) ? outcome.entries : [];
      return (
        <ActionLine
          toolCallId={toolCallId}
          running={status !== "complete"}
          label={t("Listed files")}
          detail={
            outcome.refused === true || didNotWork(outcome)
              ? labelForCode(outcome.code, outcome.reason)
              : entries.length
                ? entries.length === 1
                  ? t("1 item in the workspace")
                  : t("{count} items in the workspace", {
                      count: entries.length,
                    })
                : t("nothing saved yet")
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    ...fromCatalogue<{ path: string; offset?: number; limit?: number }>(
      "computer_read_file",
    ),
    render: ({ args, result, status, toolCallId }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          toolCallId={toolCallId}
          running={status !== "complete"}
          label={t("Read file")}
          detail={
            outcome.refused === true
              ? labelForCode(outcome.code, outcome.reason)
              : typeof args?.path === "string"
                ? args.path
                : undefined
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    ...fromCatalogue<{ path: string; contents: string; append?: boolean }>(
      "computer_write_file",
    ),
    render: ({ args, result, status, toolCallId }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          toolCallId={toolCallId}
          running={status !== "complete"}
          label={args?.append === true ? t("Added to file") : t("Saved file")}
          // Show the path, never file contents.
          detail={
            outcome.refused === true
              ? labelForCode(outcome.code, outcome.reason)
              : typeof args?.path === "string"
                ? args.path
                : undefined
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool(fromCatalogue<{ index: number }>("computer_switch_tab"));

  useFrontendTool(
    fromCatalogue<{ ref: string; snapshotId: number; path: string }>(
      "computer_upload_file",
    ),
  );

  useFrontendTool(fromCatalogue<{ deltaY?: number }>("computer_scroll"));

  return null;
}
