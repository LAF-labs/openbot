import { useFrontendTool } from "@copilotkit/react-core/v2";
import { TOOL_RESULT_KO, toolResultText } from "@shared/prompt/tool-results.ko";
import {
  MANAGE_ROUTINE,
  REMEMBER,
  UPDATE_PROFILE,
  UPDATE_PROFILE_WITHOUT_EFFORT,
} from "@shared/tools/self";
import { asStandardSchema } from "@shared/tools/standard-schema";
import { useQuery } from "@tanstack/react-query";
import { ToolLine } from "@/components/channels/tool-line";
import { RoutineCard } from "@/components/routines/routine-card";
import type { AgentEffort } from "@/lib/agents/effort-label";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";
import { useDeclaredBotId } from "./active-bot";
import { keptText } from "./kept-result";

/**
 * A Bot rewriting its own profile, and its own routines, from inside the conversation: what the
 * turn is told this window offers, and the line each call is drawn as.
 *
 * This is what makes a Bot something you shape by talking rather than something you configure once.
 * A Bot starts blank; told "you're the one who chases invoices", it writes that into its own
 * description here and still knows it next week, in every conversation, without anybody opening a
 * settings screen. Without it the only way to change a Bot was a form, and the answer the person
 * gave in conversation was forgotten as soon as the turn ended.
 *
 * TWO TOOLS, NOT ONE. `update_state` was one tool with nine optional fields, a `target` enum and a
 * second `action` enum on top of it, and about 1,500 characters of prose trying to teach a model
 * which combination it wanted. Those characters were tuned between three eval runs in eleven
 * minutes — FAIL, FAIL, PASS — which is not evidence that they work; n=3 cannot tell 90% from 99%.
 * The boundary is drawn by the tool NAMES now, which a model does not have to reason about, and the
 * remaining prose is a sentence per tool. The one sentence worth keeping is the one that failed in
 * production: a duty handed to the Bot is its job, not something it remembers.
 *
 * THE SERVER CARRIES THE CALLS OUT (`server/src/turns/chat-tools.ts`): it takes the Bot's id from
 * the turn, never from the model, so there is no argument through which a Bot could rename a
 * colleague, and `autoReview` is reachable from neither tool — see the profile route, where that is
 * the security line of the whole boundary feature. Each registration here carried a handler that
 * did the same through the person's own session while the window ran the Bot's calls; that window
 * was removed 2026-10-05, and with it the per-tab record the handlers kept of what each call had
 * changed. A line is drawn from the call's own arguments and the result the conversation keeps,
 * which is what it was drawn from after every reload and on every turn the server ran.
 */

export type RoutineArgs = {
  action?: "create" | "list" | "update" | "delete";
  name?: string;
  /** Which routine, for update and delete: its id, or its exact name. */
  routineId?: string;
  instruction?: string;
  /** The line the person reads on the Routines screen and the card. See `shared/tools/self.ts`. */
  summary?: string;
  enabled?: boolean;
  schedule?: {
    kind: "daily" | "interval";
    time?: string;
    timeZone?: string;
    days?: number[];
    minutes?: number;
  };
};

export function SelfTools() {
  // Which Bot's routines a card may be drawn from.
  const declaredBot = useDeclaredBotId();

  /*
   * No `effort` field where the deployment's model takes none — the same fact that keeps the effort
   * card off the profile. Offered anyway, a Bot could tell its owner it now thinks more carefully
   * when nothing it is sent has changed. Read the way the card reads it, so the two cannot disagree.
   */
  const { data: user } = useQuery(currentUserQueryOptions());
  const profileTool =
    user && !user.deployment.effort
      ? UPDATE_PROFILE_WITHOUT_EFFORT
      : UPDATE_PROFILE;

  useFrontendTool({
    name: profileTool.name,
    description: profileTool.description,
    parameters: asStandardSchema<{
      name?: string;
      description?: string;
      effort?: AgentEffort;
    }>(profileTool.parameters),
    /*
     * Named for what happened, not for the tool. A person watching their Bot change its own profile
     * should read "this Bot updated its own profile", not `update_profile`.
     */
    render: ({ status, result }) => {
      const running = status !== "complete";
      const line = profileLineFor(result);
      return (
        <ToolLine
          failed={!running && line.failed === true}
          label={running ? t("Updating its own profile") : line.done}
          running={running}
        />
      );
    },
  });

  useFrontendTool({
    name: MANAGE_ROUTINE.name,
    description: MANAGE_ROUTINE.description,
    parameters: asStandardSchema<RoutineArgs>(MANAGE_ROUTINE.parameters),
    render: ({ args, status, result }) => {
      const running = status !== "complete";
      const asked = args as RoutineArgs | undefined;
      /*
       * The line says what the Bot did. One tool does several things, and saying "saved a routine"
       * while it deleted one is the kind of small lie that makes a person stop reading these lines:
       * a Bot that only listed its routines read "Changed a routine" until 2026-09-24. Drawn from
       * the action the Bot asked for, and from the answer it got (`routineLineOf`): a save the
       * server refused is not "루틴을 저장했어요".
       */
      const said = routineLineOf(asked?.action, result);
      const line = (
        <ToolLine
          failed={!running && said.failed === true}
          label={running ? said.doing : said.done}
          running={running}
        />
      );
      /*
       * A SAVE OR AN EDIT THAT WENT THROUGH IS DRAWN AS THE ROUTINE, not as a sentence about it:
       * name, "매주 월 오전 9:00", when it runs next, 끄기 and 고치기 (UI/UX audit 0.5.3, item 8).
       * An edit is a line of its own with the schedule it has now, since the save's card above it
       * already reads the routine as it is. Anything else — a list, a pause, a refusal — keeps the
       * line, and so does a routine the list no longer holds.
       */
      if (running || said.failed || !routineCallLanded(asked?.action, result)) {
        return line;
      }
      return (
        <RoutineCard
          agentId={declaredBot}
          compact={asked?.action === "update"}
          fallback={line}
          names={[asked?.name ?? "", asked?.routineId ?? ""]}
        />
      );
    },
  });

  /**
   * ONE THING IT LEARNED, KEPT PAST THIS CONVERSATION.
   *
   * `update_profile` writes what the Bot IS. This writes what it KNOWS, and the two are
   * deliberately separate tools: a Bot told "we close on Sundays" should not have to decide whether
   * that belongs in its job description, and a job description that grows a paragraph every time
   * somebody mentions a supplier stops being a job description.
   *
   * Append only. Forgetting is the person's, on the Bot's own screen — a Bot that could quietly
   * drop what it knows is a Bot whose memory nobody can audit, which is the thing being fixed here.
   *
   * And the server refuses anything that looks like a secret. The description says not to record
   * one, but a description is not a boundary: a memory is reread at the top of every single turn,
   * so a password that got in there is read by every later conversation and every routine. See
   * `agents/memory-store.ts`. A refused secret is not echoed onto the line either
   * (`rememberLineFor`): the whole point of refusing it is that the value stops there.
   */
  useFrontendTool({
    name: REMEMBER.name,
    description: REMEMBER.description,
    parameters: asStandardSchema<{ fact?: string; place?: string }>(
      REMEMBER.parameters,
    ),
    render: ({ args, status, result }) => {
      const running = status !== "complete";
      // Read off the call: what it was asked to keep, and the code it answered.
      const line = rememberLineFor(
        args as { fact?: string; place?: string } | undefined,
        result,
      );
      return (
        <ToolLine
          failed={line.failed === true}
          label={running ? t("Remembering") : line.done}
          running={running}
        >
          {line.note ? <p>{line.note}</p> : null}
        </ToolLine>
      );
    },
  });

  return null;
}

/**
 * WHETHER ONE OF THE BOT'S OWN CALLS WENT THROUGH, READ OFF THE ANSWER THE CONVERSATION KEEPS.
 *
 * These lines said what they knew from the handler the window ran — it wrote "루틴을 저장하지
 * 못했어요" for its renderer when a route refused. A turn the server carries out never ran that
 * handler, so from v0.5.7 a line knew nothing and said what a line that knows nothing says: a
 * routine refused for a time of "8시" read "루틴을 저장했어요", and a profile the server would not
 * change read "자기 프로필을 바꿨어요" (review of pull request 83). The answer is the one account
 * of the call both sides have.
 *
 * BY THE SENTENCE A SUCCESS IS ANSWERED WITH, NOT BY A LIST OF FAILURES. These tools' good news is
 * a sentence of the same table their refusals are (`shared/prompt/tool-results.ko.ts`), so the
 * reader a connected service's line uses (`stepFailureOf`) would call every one of them a failure.
 * A call went through when its answer is the one its action is answered with — from the table the
 * server writes it from, so the two cannot drift apart — and any other answer is a call that did
 * not: a refusal, a turn stopped under it, a call nothing answered. No answer kept at all says
 * nothing either way, and reads as it always did.
 */
const opens = (code: string) =>
  (TOOL_RESULT_KO[code] ?? "").split("{")[0] ?? "";

/** What a profile line says once its call is over. */
export function profileLineFor(result: string | undefined): {
  done: string;
  failed?: boolean;
} {
  const said = keptText(result);
  return !said || said === toolResultText("laf:profile_updated")
    ? { done: t("Updated its own profile") }
    : { done: t("Could not update its own profile"), failed: true };
}

/** Whether a routine call's answer is the one that action is answered with when it goes through. */
function routineWentThrough(
  action: RoutineArgs["action"] | undefined,
  said: string,
): boolean {
  switch (action) {
    case "create":
      // Saved, or saved with a schedule that could not be read back: either way a save.
      return (
        said.startsWith(opens("laf:routine_saved")) ||
        said === toolResultText("laf:routine_saved_unread")
      );
    case "list":
      return (
        said.startsWith(opens("laf:routine_list")) ||
        said === toolResultText("laf:routine_list_empty")
      );
    case "delete":
      return said === toolResultText("laf:routine_deleted");
    case "update":
      /*
       * An edit that stood — whatever became of a switch asked for with it, which the server does
       * only after the edit (`routineAction`) — or the switch alone.
       */
      return (
        said.startsWith(opens("laf:routine_updated")) ||
        said === toolResultText("laf:routine_saved_unread") ||
        said === toolResultText("laf:routine_paused") ||
        said === toolResultText("laf:routine_resumed")
      );
    default:
      return false;
  }
}

/** What a routine line says: the action the Bot asked for, and whether its answer says it went through. */
export function routineLineOf(
  action: RoutineArgs["action"] | undefined,
  result: string | undefined,
): { doing: string; done: string; failed?: boolean } {
  const line = routineLineFor(action);
  const said = keptText(result);
  if (!said || routineWentThrough(action, said)) return line;
  const could =
    action === "create"
      ? t("Could not save a routine")
      : action === "list"
        ? t("Could not look at its routines")
        : action === "delete"
          ? t("Could not delete a routine")
          : t("Could not change a routine");
  return { doing: line.doing, done: could, failed: true };
}

/**
 * Whether a routine call saved or changed a routine — the only two that are drawn as its card.
 *
 * The Bot's answer is what the conversation keeps of the call, so it is read for the sentence a
 * success hands the Bot — its opening words, from the same table the server wrote it from
 * (`routineSavedText`, `routineUpdatedText`), so the two cannot drift apart.
 */
export function routineCallLanded(
  action: RoutineArgs["action"] | undefined,
  result: string | undefined,
): boolean {
  if (action !== "create" && action !== "update") return false;
  const said = keptText(result);
  const opening = (
    TOOL_RESULT_KO[
      action === "create" ? "laf:routine_saved" : "laf:routine_updated"
    ] ?? ""
  ).split("{")[0];
  return Boolean(opening) && said.startsWith(opening ?? "");
}

/**
 * What a `remember` line says, read off the call.
 *
 * MEASURED 2026-09-25 (0.5.4 final QA): "서울 마포구야" answered, the line read "가게 위치를
 * 저장했어요 · 서울 마포구"; after a reload the same call read "기억해 두었어요" with nothing under
 * it, because the words lived only in the memory of the tab that ran the call. The call's own
 * arguments and the code it answered say which of the two it was, and what was kept.
 */
export function rememberLineFor(
  args: { fact?: string; place?: string } | undefined,
  result: string | undefined,
): { done: string; note?: string; failed?: boolean } {
  const said = keptText(result);
  /*
   * A failed line reads "{action} — 실패", so its action is the thing tried, not the thing done:
   * "기억해 두었어요 — 실패" said both at once (walked 2026-09-27, a refused remember after a cut).
   */
  const failed = (action: string) =>
    said ? { done: action, failed: true } : { done: t("Remembered something") };
  if (args?.place?.trim()) {
    return said === toolResultText("laf:place_saved")
      ? { done: t("Saved the shop's location"), note: args.place.trim() }
      : failed(t("Save the shop's location"));
  }
  return said === toolResultText("laf:remembered") && args?.fact
    ? { done: t("Remembered something"), note: args.fact }
    : failed(t("Remember something"));
}

/** What a routine line says, from the action the Bot asked for. */
export function routineLineFor(action: RoutineArgs["action"] | undefined): {
  doing: string;
  done: string;
} {
  switch (action) {
    case "list":
      return {
        doing: t("Looking at its routines"),
        done: t("Looked at its routines"),
      };
    case "create":
      return { doing: t("Saving a routine"), done: t("Saved a routine") };
    case "delete":
      return { doing: t("Deleting a routine"), done: t("Deleted a routine") };
    default:
      return { doing: t("Changing a routine"), done: t("Changed a routine") };
  }
}
