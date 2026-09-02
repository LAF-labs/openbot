import { useFrontendTool } from "@copilotkit/react-core/v2";
import { toolResultText } from "@shared/prompt/tool-results.ko";
import { computerTool } from "@shared/tools/computer";
import { asStandardSchema } from "@shared/tools/standard-schema";
import { ApprovalRequest } from "@/components/channels/approval-request";
import { ToolLine } from "@/components/channels/tool-line";
import { ComputerView } from "@/components/computer/computer-view";
import {
  type ControlState,
  readControl,
} from "@/components/computer/take-the-wheel";
import {
  allowanceScopeOf,
  closeQuestion,
  openQuestion,
  pauseFrom,
  waitForApproval,
} from "@/lib/approvals";
import { t } from "@/lib/i18n";
import { useActiveBotHolder } from "./active-bot";
import { reportComputerActivity } from "./computer-activity";

/**
 * Frontend registrations for computer tools, including inline rendering and policy-refusal display.
 *
 * The names, descriptions and schemas come from `shared/tools/computer.ts` — the same objects the
 * server's unattended loop and the eval pack hand to a model. Only the handler and the transcript
 * line are written here, because only those two are about a browser being open.
 *
 * TWO READERS, TWO LANGUAGES, ONE FACT. What a tool hands back carries a `code`; the sentence the
 * MODEL reads comes from `shared/prompt/tool-results.ko.ts`, and the words a PERSON reads on the
 * transcript line come from `t()`. They are not the same sentence — one says what to do next and
 * the other says what happened — and the code is what keeps them from drifting apart.
 */

/** What every computer call returns to the model: either the result, or a reason it did not happen. */
type ToolOutcome = Record<string, unknown> & { ok: boolean };

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
 * What a refused or failed call says on the transcript line, in Korean.
 *
 * English keys because that is how `t()` works here, and a table rather than literals because the
 * value arrives as a code at runtime. `t(variable)` is invisible to the i18n coverage test, so this
 * table is walked by one of its own (`app/tests/tool-result-codes.test.ts`).
 */
const OUTCOME_LABELS: Record<string, string> = {
  "laf:human_has_control": "A person has the computer",
  "laf:stopped": "Stopped",
  "laf:person_declined": "A person declined that",
  "laf:computer_unreachable": "The Bot's computer could not be reached",
  "laf:nobody_answered": "Nobody answered in time",
  "laf:request_cancelled": "The request was cancelled",
};

/** The words for a line, from the code where there is one and from the server's text otherwise. */
function labelForCode(code: unknown, fallback: unknown): string | undefined {
  const known = typeof code === "string" ? OUTCOME_LABELS[code] : undefined;
  if (known) return t(known);
  return typeof fallback === "string" && fallback.trim() ? fallback : undefined;
}

/** One outcome, carrying the fact and the sentence the model reads for it. */
function refusal(code: string, extra: Record<string, unknown> = {}) {
  return { ok: false as const, code, reason: toolResultText(code), ...extra };
}

/**
 * What the SDK hands a running tool call, as much of it as this file needs.
 *
 * Passed around whole rather than unpicked into an abort signal, because the id matters as much as
 * the abort does: it is what lets a question about this call be drawn on this call's line and
 * nowhere else. Optional throughout, because the SDK's context argument is optional and a handler
 * that destructures it unconditionally throws on any call that omits it.
 */
type ToolCallContext = { signal?: AbortSignal; toolCall?: { id?: string } };

/**
 * Human-assistance wait window. Long enough for a user to return, finite so the run can unblock.
 */
const WAIT_FOR_PERSON_MS = 10 * 60_000;

/** How often the waiting handler asks whether the person has answered yet. */
const WAIT_POLL_MS = 1_000;

/** Hold the tool call open until the human control/secret prompt is answered, cancelled, or expires. */
async function waitForPerson(
  botId: string,
  done: (state: ControlState) => boolean,
  signal: AbortSignal | undefined,
  giveUpAfterMs = WAIT_FOR_PERSON_MS,
): Promise<"answered" | "gave up" | "cancelled"> {
  const deadline = Date.now() + giveUpAfterMs;
  while (Date.now() < deadline) {
    // Stop must actually stop, including out of a wait. The SDK aborts this when a person presses it.
    if (signal?.aborted) return "cancelled";
    const read = await readControl(botId).catch(() => null);
    if (read?.state && done(read.state)) return "answered";
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  return "gave up";
}

/**
 * The same request, carrying an answer.
 *
 * Rebuilt rather than mutated, because every acting route is a POST of one JSON object and the
 * approval is one more field on it. Sending the identical arguments matters: the server binds an
 * approval to a fingerprint of the action, so a retry that differed in any way it hashes would be
 * refused as a different action, which is exactly what that binding is for.
 */
function withApproval(
  init: RequestInit | undefined,
  approvalId: string,
): RequestInit {
  const sent =
    typeof init?.body === "string"
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : {};
  return {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...sent, approvalId }),
  };
}

/**
 * One computer call, including the pause where a person is asked about it.
 *
 * The waiting lives here rather than in each tool's handler so that a tool cannot be added without
 * it: an acting route that met an ask rule and got back a bare failure would report to the model
 * that the action was impossible, when in fact nobody had been asked yet.
 */
async function callComputer(
  botId: string,
  path: string,
  init?: RequestInit,
  call: ToolCallContext = {},
): Promise<ToolOutcome> {
  const signal = call.signal;
  const outcome = await sendToComputer(botId, path, init, signal);
  if (outcome.awaitingApproval !== true) return outcome;

  const approvalId = String(outcome.approvalId ?? "");
  // Put in front of the person on this call's own line rather than left to be found. The id is what
  // ties the card to the action it is about; see lib/approvals.ts for why anything looser gets it
  // wrong.
  const toolCallId = call.toolCall?.id ?? "";
  openQuestion(toolCallId, {
    approvalId,
    botId,
    question: String(outcome.question ?? outcome.reason ?? ""),
    rule: typeof outcome.rule === "string" ? outcome.rule : null,
    scope: allowanceScopeOf(outcome.scope),
  });
  try {
    const answer = await waitForApproval(botId, approvalId, signal);
    if (answer === "granted") {
      // Sent once, not through this function again. A second ask on the retry would mean the approval
      // did not fit the action, and looping on that would hold the turn open until the deadline instead
      // of telling the model something it can act on.
      return sendToComputer(
        botId,
        path,
        withApproval(init, approvalId),
        signal,
      );
    }
    if (answer === "cancelled") {
      return refusal("laf:stopped", { stopped: true });
    }
    return answer === "declined"
      ? refusal("laf:person_declined", { refused: true })
      : refusal("laf:nobody_answered");
  } finally {
    // However the wait ended, nothing should still be offering buttons for it. A run that was
    // stopped leaves its question open on the server for the rest of its ten minutes, and a card
    // that outlived its own call would be collecting consent nobody is waiting for.
    closeQuestion(toolCallId);
  }
}

async function sendToComputer(
  botId: string,
  path: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  // Announce before the call so the screen can open while the action is running.
  reportComputerActivity(botId);
  let response: Response;
  try {
    response = await fetch(`/api/computers/${botId}${path}`, {
      credentials: "include",
      // Abort cancels the request and prevents later actions, but cannot undo browser work already executing.
      ...(signal ? { signal } : {}),
      ...init,
    });
  } catch (error) {
    // An abort is a stopped run, not a computer failure.
    if (error instanceof DOMException && error.name === "AbortError") {
      return refusal("laf:stopped", { stopped: true });
    }
    return refusal("laf:computer_unreachable");
  }

  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  if (!response.ok) {
    // Read before anything else a 409 can mean. The other two, stale refs and a person holding the
    // wheel, are conditions the model reacts to; this one it must not see at all, because the caller
    // above is going to wait and then send the very same request again.
    const pause = response.status === 409 ? pauseFrom(body) : null;
    if (pause) {
      return {
        ok: false,
        awaitingApproval: true,
        // Spread, not copied field by field. `pauseFrom` owns the shape, so a field added to the
        // reply reaches the card without this file being edited — which is the failure that
        // happened here: the scope was added at both ends and dropped in the middle, with every
        // test on both sides green.
        ...pause,
        reason:
          (body?.error as string) ?? "Somebody is being asked about that.",
      };
    }
    /*
     * The computer answers with a fact code where it has one — `laf:human_has_control` is the
     * whole of the sentence the container used to ship — so the words the model reads are chosen
     * here, in Korean, rather than by a service that has never heard of a locale. Anything that is
     * not a code is passed through: an English sentence from somewhere upstream reaching the
     * person is a regression, and it is visible rather than swallowed.
     */
    const said = typeof body?.error === "string" ? body.error : "";
    const code = said.startsWith("laf:") ? said : undefined;
    return {
      ok: false,
      ...(code ? { code } : {}),
      reason: code ? toolResultText(code) : said || "That did not work.",
      // Preserve refusal/stale-ref/control distinctions for the model's next step.
      ...(response.status === 403
        ? { refused: true, rule: body?.rule ?? null }
        : {}),
      ...(response.status === 409
        ? body?.humanHasControl === true
          ? { humanHasControl: true }
          : { staleRefs: true }
        : {}),
    };
  }

  return { ok: true, ...(body ?? {}) };
}

/** What a computer tool's render can read back out of its own result. */
type ComputerOutcome = {
  ok?: boolean;
  stopped?: boolean;
  humanHasControl?: boolean;
  entries?: unknown[];
  refused?: boolean;
  /** The fact, where there is one. The transcript line's words come from this, not from `reason`. */
  code?: string;
  reason?: string;
  staleRefs?: boolean;
  elements?: unknown[];
  element?: { role?: string; name?: string };
};

/**
 * Parse the SDK-render result string so the transcript can distinguish success, refusal, and failure.
 */
function outcomeOf(result: string | undefined): ComputerOutcome {
  if (!result) return {};
  try {
    const parsed = JSON.parse(result) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as ComputerOutcome)
      : {};
  } catch {
    // Runtime stringifies thrown handlers as "Error: <message>".
    return result.startsWith("Error:")
      ? { ok: false, reason: result.slice("Error:".length).trim() }
      : {};
  }
}

/**
 * The label of the element an action touched, as the gateway resolved it server-side.
 *
 * Not taken from the model's arguments: those carry only a ref. The server looked the element up in
 * the snapshot it took itself, which is the same value it wrote to the audit trail, so the transcript
 * and the audit row name the thing identically.
 */
function labelOf(result: string | undefined): string | undefined {
  const element = (outcomeOf(result) as { element?: { name?: unknown } })
    .element;
  const name = element?.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
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

/** Whether a result is an ordinary failure rather than a refusal, so the two can render differently. */
function didNotWork(outcome: ComputerOutcome): boolean {
  return outcome.ok === false && outcome.refused !== true;
}

export function ComputerTools() {
  const bot = useActiveBotHolder();

  useFrontendTool({
    ...fromCatalogue<{ url: string }>("computer_navigate"),
    handler: async ({ url }: { url: string }, call: ToolCallContext = {}) => {
      const result = await callComputer(
        bot.current,
        "/navigate",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        },
        call,
      );
      return result.ok
        ? {
            ok: true,
            title: result.title,
            url: result.url,
            text: result.text,
            truncated: result.truncated,
          }
        : result;
    },
    render: ({ status, toolCallId }) => (
      <div className="my-2">
        {/*
         * Above the screen rather than through ActionLine, because opening a page draws the live
         * view instead of a line. A question about where the Bot is about to go still belongs
         * beside it.
         */}
        <ApprovalRequest toolCallId={toolCallId} />
        <ComputerView computerId={bot.current} active={status !== "complete"} />
      </div>
    ),
  });

  useFrontendTool({
    ...fromCatalogue<Record<string, never>>("computer_read"),
    handler: async () => callComputer(bot.current, "/read"),
    render: () => null,
  });

  useFrontendTool({
    ...fromCatalogue<Record<string, never>>("computer_snapshot"),
    handler: async () =>
      callComputer(bot.current, "/snapshot", { method: "POST" }),
    // Snapshot renders a count only; navigate owns the screen view.
    render: ({ result, status }) => {
      const outcome = outcomeOf(result);
      const elements = Array.isArray(outcome.elements) ? outcome.elements : [];
      return (
        <ActionLine
          running={status !== "complete"}
          label={t("Read the page")}
          detail={
            elements.length
              ? `${elements.length} thing${elements.length === 1 ? "" : "s"} it can act on`
              : undefined
          }
        />
      );
    },
  });

  useFrontendTool({
    ...fromCatalogue<{
      ref: string;
      snapshotId: number;
      text: string;
      submit?: boolean;
    }>("computer_type"),
    handler: async (
      input: {
        ref: string;
        snapshotId: number;
        text: string;
        submit?: boolean;
      },
      call: ToolCallContext = {},
    ) =>
      callComputer(
        bot.current,
        "/type",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
      ),
    render: ({ args, result, status, toolCallId }) => (
      <ActionLine
        toolCallId={toolCallId}
        running={status !== "complete"}
        label={t("Filled in")}
        detail={
          // Never show typed values; identify only the target field.
          labelOf(result) ??
          (typeof args?.ref === "string" ? args.ref : undefined)
        }
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
      />
    ),
  });

  useFrontendTool({
    ...fromCatalogue<{ ref: string; snapshotId: number }>("computer_click"),
    handler: async (
      input: { ref: string; snapshotId: number },
      call: ToolCallContext = {},
    ) =>
      callComputer(
        bot.current,
        "/click",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
      ),
    render: ({ args, result, status, toolCallId }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          toolCallId={toolCallId}
          running={status !== "complete"}
          label={t("Clicked")}
          detail={
            // Show refusal reason instead of an internal element ref.
            outcome.refused === true
              ? labelForCode(outcome.code, outcome.reason)
              : (labelOf(result) ??
                (typeof args?.ref === "string" ? args.ref : undefined))
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    ...fromCatalogue<{ key: string; ref?: string; snapshotId?: number }>(
      "computer_key",
    ),
    handler: async (
      input: {
        key: string;
        ref?: string;
        snapshotId?: number;
      },
      call: ToolCallContext = {},
    ) =>
      callComputer(
        bot.current,
        "/key",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
      ),
    render: ({ args, result, status, toolCallId }) => (
      <ActionLine
        toolCallId={toolCallId}
        running={status !== "complete"}
        label={t("Pressed")}
        detail={typeof args?.key === "string" ? args.key : undefined}
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
      />
    ),
  });

  useFrontendTool({
    ...fromCatalogue<{ label: string; ref: string; snapshotId: number }>(
      "computer_request_secret",
    ),
    handler: async (
      input: { label: string; ref: string; snapshotId: number },
      call: ToolCallContext = {},
    ) => {
      const botId = bot.current;
      const asked = await callComputer(
        botId,
        "/control/secret",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
      );
      if (!asked.ok) return asked;

      // Completion is `secretWanted` clearing; the value never returns to the model.
      const outcome = await waitForPerson(
        botId,
        (state) => state.secretWanted === undefined,
        call.signal,
      );
      const code =
        outcome === "answered"
          ? "laf:secret_entered"
          : outcome === "cancelled"
            ? "laf:request_cancelled"
            : "laf:secret_not_entered";
      return { ok: true, code, result: toolResultText(code) };
    },
    // Rendered by ComputerView as a masked prompt.
    render: () => null,
  });

  useFrontendTool({
    ...fromCatalogue<{ reason: string }>("computer_request_help"),
    handler: async (input: { reason: string }, call: ToolCallContext = {}) => {
      const botId = bot.current;
      const asked = await callComputer(
        botId,
        "/control/request",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
      );
      if (!asked.ok) return asked;

      // Resolved when the wheel is back with the Bot and no help request remains outstanding.
      const outcome = await waitForPerson(
        botId,
        (state) => state.holder === "bot" && !state.requested,
        call.signal,
      );
      const code =
        outcome === "answered"
          ? "laf:control_returned"
          : outcome === "cancelled"
            ? "laf:request_cancelled"
            : "laf:nobody_took_control";
      return { ok: true, code, result: toolResultText(code) };
    },
    // Rendered by ComputerView as the take-the-wheel prompt.
    render: () => null,
  });

  useFrontendTool({
    ...fromCatalogue<{ path?: string }>("computer_list_files"),
    handler: async (input: { path?: string }, call: ToolCallContext = {}) =>
      callComputer(
        bot.current,
        "/files/list",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input ?? {}),
        },
        call,
      ),
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
    ...fromCatalogue<{ path: string }>("computer_read_file"),
    handler: async (input: { path: string }, call: ToolCallContext = {}) =>
      callComputer(
        bot.current,
        "/files/read",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
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
    handler: async (
      input: {
        path: string;
        contents: string;
        append?: boolean;
      },
      call: ToolCallContext = {},
    ) =>
      callComputer(
        bot.current,
        "/files/write",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
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

  useFrontendTool({
    ...fromCatalogue<{ deltaY?: number }>("computer_scroll"),
    handler: async (input: { deltaY?: number }, call: ToolCallContext = {}) =>
      callComputer(
        bot.current,
        "/scroll",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
      ),
    render: ({ result, status, toolCallId }) => (
      <ActionLine
        toolCallId={toolCallId}
        running={status !== "complete"}
        label={t("Scrolled")}
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
      />
    ),
  });

  return null;
}
