import { useFrontendTool } from "@copilotkit/react-core/v2";
import { toolResultText } from "@shared/prompt/tool-results.ko";
import { computerTool } from "@shared/tools/computer";
import {
  computerReplyOutcome,
  navigationOutcome,
} from "@shared/tools/computer-reply";
import { asStandardSchema } from "@shared/tools/standard-schema";
import { ApprovalRequest } from "@/components/channels/approval-request";
import { ToolLine } from "@/components/channels/tool-line";
import { HelpCard } from "@/components/computer/help-card";
import {
  type ControlState,
  readControl,
} from "@/components/computer/take-the-wheel";
import {
  allowanceScopeOf,
  askSubjectOf,
  closeQuestion,
  type OpenQuestion,
  openQuestion,
  pauseFrom,
  waitForApproval,
  withdrawApproval,
} from "@/lib/approvals";
import { didNotWork, labelForCode, outcomeOf } from "@/lib/computer/browsing";
import { takeSkip } from "@/lib/computer/help-skips";
import { t } from "@/lib/i18n";
import {
  activeConversationHeaders,
  activeConversationId,
  useActiveBotHolder,
} from "./active-bot";
import { STEP_HANDED_OVER, STEP_HANDED_OVER_EVENT } from "./stranded-steps";

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
type ToolCallContext = {
  signal?: AbortSignal;
  toolCall?: { id?: string };
  /**
   * The question this call is already waiting on, when a window is carrying on a step another
   * window raised it for (`lib/copilot/stranded-steps.ts`). The call then does not ask the computer
   * again — that would open a second question — but waits on this one and sends the action once
   * it is allowed, exactly as the window that raised it would have.
   */
  resume?: OpenQuestion;
};

/**
 * The header naming the Bot's tool call a request carries out, beside the conversation's. Mirrors
 * `TOOL_CALL_HEADER` in `server/src/computer/gateway/caller.ts`: with it a question the call raises
 * names its step, and every window of the conversation can draw it and carry it on.
 */
const TOOL_CALL_HEADER = "x-openbot-tool-call-id";

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
  call: ToolCallContext,
  giveUpAfterMs = WAIT_FOR_PERSON_MS,
): Promise<"answered" | "gave up" | "cancelled" | "skipped"> {
  const deadline = Date.now() + giveUpAfterMs;
  while (Date.now() < deadline) {
    // Stop must actually stop, including out of a wait. The SDK aborts this when a person presses it.
    if (call.signal?.aborted) return "cancelled";
    // Read before the computer: a skip also hands back, which the computer reports as done.
    if (takeSkip(call.toolCall?.id)) return "skipped";
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
  const threadId = activeConversationId();
  const step: StepHere = { threadId: threadId ?? "", asking: false };
  if (threadId) {
    stepsHere.add(step);
    listenForLeavingSteps();
  }
  try {
    return await takeStep(botId, path, init, call, step);
  } finally {
    stepsHere.delete(step);
  }
}

/** A step this window is making for a conversation, and whether it is waiting on a question. */
type StepHere = { threadId: string; asking: boolean };
const stepsHere = new Set<StepHere>();

/**
 * THE WINDOW IS GOING AWAY MID-STEP. A step waiting on a question outlives it — the question is
 * held on the server and the next window carries it on (`lib/approvals.ts` lets go of it). Any
 * other step dies with the window, and the server is told so on the way out: otherwise the run
 * that handed it over read `waiting` for ten minutes, and every other window was told the task was
 * still going on (`server/src/runner/laf-runner.ts`, `abandonStep`).
 */
let leavingSteps = false;
function listenForLeavingSteps(): void {
  if (leavingSteps || typeof window === "undefined") return;
  leavingSteps = true;
  window.addEventListener("pagehide", (event) => {
    if (event.persisted) return;
    const told = new Set<string>();
    for (const step of stepsHere) {
      if (step.asking || told.has(step.threadId)) continue;
      told.add(step.threadId);
      void fetch(
        `/api/copilotkit/threads/${encodeURIComponent(step.threadId)}/step-abandoned`,
        { method: "POST", credentials: "include", keepalive: true },
      ).catch(() => {});
    }
  });
}

async function takeStep(
  botId: string,
  path: string,
  init: RequestInit | undefined,
  call: ToolCallContext,
  step: StepHere,
): Promise<ToolOutcome> {
  const signal = call.signal;
  const toolCallId = call.toolCall?.id ?? "";
  const outcome = call.resume
    ? undefined
    : await sendToComputer(botId, path, init, signal, toolCallId);
  if (outcome && outcome.awaitingApproval !== true) return outcome;

  const question: OpenQuestion = call.resume ?? {
    approvalId: String(outcome?.approvalId ?? ""),
    botId,
    // The facts, not a sentence: the card writes the Korean. See lib/approvals.ts.
    subject: askSubjectOf(outcome?.subject),
    rule: typeof outcome?.rule === "string" ? outcome.rule : null,
    scope: allowanceScopeOf(outcome?.scope),
    // The conversation, where "for this conversation" is on offer: the same card every other window
    // draws off the server's record (`questionFromRecord`), third button included.
    ...(typeof outcome?.threadId === "string" && outcome.threadId
      ? { threadId: outcome.threadId }
      : {}),
    expiresAt: typeof outcome?.expiresAt === "string" ? outcome.expiresAt : "",
  };
  const approvalId = question.approvalId;
  // Put in front of the person on this call's own line rather than left to be found. The id is what
  // ties the card to the action it is about; see lib/approvals.ts for why anything looser gets it
  // wrong.
  openQuestion(toolCallId, question);
  step.asking = true;
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
        toolCallId,
      );
    }
    if (answer === "handed over") {
      // This window's copy of the thread is behind the one that took the step; it fetches it.
      window.dispatchEvent(new Event(STEP_HANDED_OVER_EVENT));
      throw new Error(STEP_HANDED_OVER);
    }
    if (answer === "cancelled") {
      // Nobody is waiting for this answer any more; no window should go on offering buttons for it.
      void withdrawApproval(botId, approvalId);
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
  toolCallId?: string,
): Promise<ToolOutcome> {
  let response: Response;
  try {
    response = await fetch(`/api/computers/${botId}${path}`, {
      credentials: "include",
      // Abort cancels the request and prevents later actions, but cannot undo browser work already executing.
      ...(signal ? { signal } : {}),
      ...init,
      // Which conversation this action belongs to, so a question it raises can be answered "for
      // this conversation". Merged under the caller's own headers, never over them.
      headers: {
        ...activeConversationHeaders(),
        // Which of the Bot's calls, so a question it raises names its step (see TOOL_CALL_HEADER).
        ...(toolCallId ? { [TOOL_CALL_HEADER]: toolCallId } : {}),
        ...(init?.headers ?? {}),
      },
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
        // Never seen by anybody in the ordinary case — the caller above waits and sends the same
        // request again — but a Korean sentence rather than the code if a caller ever reports it.
        reason: toolResultText("laf:awaiting_approval"),
      };
    }
    // The rest of the mapping is shared with the turns the server owns (`computer-reply.ts`).
    return computerReplyOutcome(response.status, body);
  }

  // The facts the browser noticed, put into the words the model reads (`computer-reply.ts`).
  return computerReplyOutcome(response.status, body);
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
  const bot = useActiveBotHolder();

  /*
   * THE BROWSER CALLS HAVE NO `render`. The transcript folds calls in a row into one browsing task
   * and draws it as one card (`chat-messages.ts` → `browsing-card.tsx`), with each call's line and
   * any question about it inside. A render here would never be asked for. The workspace's file calls
   * and the two requests for a person still draw their own.
   */
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
      return navigationOutcome(result);
    },
  });

  useFrontendTool({
    ...fromCatalogue<{ whole?: boolean; from?: string }>("computer_read"),
    // `whole`: every word on the page, not the article a reader view took out of it. `from`: from
    // the first place those words appear, for what the extract's cap left out.
    handler: async (input: { whole?: boolean; from?: string } = {}) => {
      const query = new URLSearchParams();
      if (input.whole) query.set("whole", "1");
      if (input.from?.trim()) query.set("from", input.from.trim());
      return callComputer(bot.current, query.size ? `/read?${query}` : "/read");
    },
  });

  useFrontendTool({
    ...fromCatalogue<Record<string, never>>("computer_snapshot"),
    handler: async () =>
      callComputer(bot.current, "/snapshot", { method: "POST" }),
    // Snapshot renders a count only; navigate owns the screen view.
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
        call,
      );
      const code =
        outcome === "answered"
          ? "laf:secret_entered"
          : outcome === "skipped"
            ? "laf:secret_skipped"
            : outcome === "cancelled"
              ? "laf:request_cancelled"
              : "laf:secret_not_entered";
      return { ok: true, code, result: toolResultText(code) };
    },
    // A card in the conversation with the masked box, where the Bot asked — never a pop-up.
    render: ({ args, result, status, toolCallId }) => (
      <HelpCard
        botId={bot.current}
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
        call,
      );
      const code =
        outcome === "answered"
          ? "laf:control_returned"
          : outcome === "skipped"
            ? "laf:help_skipped"
            : outcome === "cancelled"
              ? "laf:request_cancelled"
              : "laf:nobody_took_control";
      return { ok: true, code, result: toolResultText(code) };
    },
    // A card in the conversation: 직접 하기, 다 했어요, 건너뛰기 (`help-card.tsx`).
    render: ({ args, result, status, toolCallId }) => (
      <HelpCard
        botId={bot.current}
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
    ...fromCatalogue<{ path: string; offset?: number; limit?: number }>(
      "computer_read_file",
    ),
    handler: async (
      input: { path: string; offset?: number; limit?: number },
      call: ToolCallContext = {},
    ) =>
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
    ...fromCatalogue<{ index: number }>("computer_switch_tab"),
    handler: async (input: { index: number }, call: ToolCallContext = {}) =>
      callComputer(
        bot.current,
        "/tabs/switch",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
      ),
  });

  useFrontendTool({
    ...fromCatalogue<{ ref: string; snapshotId: number; path: string }>(
      "computer_upload_file",
    ),
    handler: async (
      input: { ref: string; snapshotId: number; path: string },
      call: ToolCallContext = {},
    ) =>
      callComputer(
        bot.current,
        "/upload",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
      ),
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
  });

  return null;
}
