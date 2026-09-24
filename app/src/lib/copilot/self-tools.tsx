import { useFrontendTool } from "@copilotkit/react-core/v2";
import {
  routineListResult,
  routineSavedText,
  routineUpdatedText,
  TOOL_RESULT_KO,
  toolResultText,
} from "@shared/prompt/tool-results.ko";
import { MANAGE_ROUTINE, REMEMBER, UPDATE_PROFILE } from "@shared/tools/self";
import { asStandardSchema } from "@shared/tools/standard-schema";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { ToolLine } from "@/components/channels/tool-line";
import { RoutineCard } from "@/components/routines/routine-card";
import { type AgentEffort, effortLabel } from "@/lib/agents/effort-label";
import { AGENT_REFUSALS } from "@/lib/agents/mutations";
import { agentKeys } from "@/lib/agents/queries";
import { t } from "@/lib/i18n";
import { routineKeys } from "@/lib/routines/queries";
import { keepPlace } from "@/lib/whereabouts/queries";
import { useActiveBotHolder, useDeclaredBotId } from "./active-bot";

/**
 * A Bot rewriting its own profile, and its own routines, from inside the conversation.
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
 * VALIDITY IS THE SERVER'S. The handlers used to answer English sentences of their own ("A routine
 * needs a name, what it should do each time, and when to run") — server prose invented in the
 * browser, unreachable by a Korean reader and by any other caller of the same endpoints. The routes
 * answer `laf:` codes now, and the words come from `shared/prompt/tool-results.ko.ts` for the model
 * and from `t()` for the person.
 *
 * It edits ITSELF and nothing else: the id comes from the active Bot holder, never from the model,
 * so there is no argument through which a Bot could rename a colleague. The server checks the
 * person's own permission on top of that. And `autoReview` is reachable from neither tool — see the
 * profile route, where that is the security line of the whole boundary feature.
 */

/** What a Bot's own tools hand back to the model: the fact, and the sentence it reads for it. */
function answer(code: string): string {
  return toolResultText(code);
}

/**
 * A `laf:` code out of a route's reply, or the generic one for this call.
 *
 * Only a code the model has words for. `toolResultText` hands an unknown code back as itself, and
 * the routes answer with more codes than this tool's callers can meet — `laf:internal` from the
 * error boundary among them — so a code with no sentence would reach the Bot as an identifier.
 */
async function codeOf(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
  } | null;
  return typeof body?.code === "string" && body.code in TOOL_RESULT_KO
    ? body.code
    : fallback;
}

export type RoutineArgs = {
  action?: "create" | "list" | "update" | "delete";
  name?: string;
  /** Which routine, for update and delete: its id, or its exact name. See `findRoutine`. */
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

/** A routine as the list answers it, as far as the tool needs to read one. */
type ListedRoutine = { id: string; agentId: string; name: string };

/**
 * What a line in the transcript says a call did — and which routine, so a save or an edit can be
 * drawn as that routine's card rather than as a sentence about it.
 */
type Line = { done: string; doing: string; note?: string; routineId?: string };

/** The id out of a routine the routes answered with, or undefined for a shape this cannot read. */
function idOf(routine: unknown): string | undefined {
  const id = (routine as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * THIS BOT'S ROUTINES, and nothing else of the person's.
 *
 * The routines API scopes by PERSON (`routines/ownership.ts`), and every one of a person's Bots is
 * theirs — so the route alone would let this Bot's tool rewrite a colleague Bot's routine by id. The
 * list is read and filtered to this Bot before anything is looked up in it, which is the same line
 * `update_profile` draws by taking its id from the active Bot rather than from the model.
 *
 * Null when the list could not be read, which is not an empty list: a Bot told "there is no such
 * routine" when the truth was "I could not look" would make one up next.
 */
async function routinesOf(botId: string): Promise<unknown[] | null> {
  try {
    const response = await fetch("/api/routines", { credentials: "include" });
    if (!response.ok) return null;
    const body = (await response.json()) as { routines?: unknown };
    if (!Array.isArray(body.routines)) return null;
    return body.routines.filter(
      (routine) =>
        !!routine &&
        typeof routine === "object" &&
        (routine as { agentId?: unknown }).agentId === botId,
    );
  } catch {
    return null;
  }
}

/**
 * Which routine a call means: the one with this id, or the one with exactly this name.
 *
 * BY NAME BECAUSE THAT IS WHAT A BOT KNOWS. Nothing it is ever handed carries an id except `list`
 * and the refusals below, so "move my briefing to eight" arrives with a name or with nothing. An
 * exact name only, and only when one routine has it: a Bot choosing between two routines called
 * 리뷰 확인 is a Bot guessing which one the person meant, so it is shown both, with their ids.
 */
function findRoutine(
  routines: readonly unknown[],
  wanted: string,
):
  | { kind: "found"; routine: ListedRoutine }
  | { kind: "unknown" | "ambiguous" } {
  const listed = routines.filter(
    (routine): routine is ListedRoutine =>
      !!routine &&
      typeof routine === "object" &&
      typeof (routine as ListedRoutine).id === "string" &&
      typeof (routine as ListedRoutine).name === "string",
  );
  const byId = listed.find((routine) => routine.id === wanted);
  if (byId) return { kind: "found", routine: byId };
  const named = listed.filter((routine) => routine.name.trim() === wanted);
  if (named.length === 1 && named[0]) {
    return { kind: "found", routine: named[0] };
  }
  return { kind: named.length > 1 ? "ambiguous" : "unknown" };
}

/**
 * The routine tool's work.
 *
 * A person asking for something every morning is asking for a routine, and before this the only way
 * to get one was to leave the conversation, open the Routines page and re-type what they had just
 * said. The Bot writes it down instead — for itself, on its own id, which is why no agent id
 * crosses the tool boundary.
 *
 * The only checks here are the ones that decide WHICH URL to call: which routine is meant, and
 * whether there is anything to send it. Everything about whether the routine is well formed — a
 * name, an instruction, a schedule that ever comes round — is answered by the routines API, in codes.
 *
 * Exported so what a Bot is handed after a save is tested against this function, not a copy of it
 * (`app/tests/routine-saved.test.ts`, `app/tests/routine-tool-edit.test.ts`).
 */
export async function routineAction(
  args: RoutineArgs,
  botId: string,
  remember: (entry: Line, failed?: boolean) => void,
  queryClient: QueryClient,
): Promise<string> {
  const line = (
    doing: string,
    done: string,
    note?: string,
    routineId?: string,
  ): Line => ({
    doing,
    done,
    ...(note ? { note } : {}),
    ...(routineId ? { routineId } : {}),
  });
  const say = (entry: Line, failed: boolean, said: string) => {
    remember(entry, failed);
    return said;
  };
  const done = async (entry: Line, said: string) => {
    // The Routines screen and the Bot panel both read this list.
    await queryClient.invalidateQueries({ queryKey: routineKeys.all });
    remember(entry, false);
    return said;
  };
  const refusedChange = (note?: string) =>
    line(t("Changing a routine"), t("Could not change a routine"), note);

  if (args.action === "create") {
    const response = await fetch("/api/routines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        agentId: botId,
        name: args.name?.trim() ?? "",
        instruction: args.instruction?.trim() ?? "",
        ...(args.summary?.trim() ? { summary: args.summary.trim() } : {}),
        ...(args.schedule ? { schedule: args.schedule } : {}),
      }),
    });
    const name = args.name?.trim();
    if (!response.ok) {
      return say(
        line(t("Saving a routine"), t("Could not save a routine")),
        true,
        answer(await codeOf(response, "laf:routine_incomplete")),
      );
    }
    /*
     * THE SCHEDULE AS THE SERVER KEPT IT, SAID BACK TO THE BOT.
     *
     * This answered "saved" and nothing else while a daily schedule with no zone was being stored as
     * UTC: "매일 7시 반" ran at 16:30 in Seoul and the Bot told the person it was done (audit
     * 2026-09-16, R2 F1). Read from the response, never from `args` — the request is what was asked
     * for, and the zone the server filled in is only in what it answered.
     */
    const saved = (await response.json().catch(() => null)) as {
      routine?: unknown;
    } | null;
    return await done(
      line(
        t("Saving a routine"),
        t("Saved a routine"),
        name,
        idOf(saved?.routine),
      ),
      routineSavedText(saved?.routine),
    );
  }

  if (args.action === "list") {
    const routines = await routinesOf(botId);
    if (!routines) {
      return say(
        line(t("Looking at its routines"), t("Could not look at its routines")),
        true,
        answer("laf:routine_list_unavailable"),
      );
    }
    return say(
      line(t("Looking at its routines"), t("Looked at its routines")),
      false,
      routineListResult("laf:routine_list", routines),
    );
  }

  if (args.action !== "update" && args.action !== "delete") {
    return say(refusedChange(), true, answer("laf:routine_unknown_action"));
  }

  const wanted = args.routineId?.trim();
  if (!wanted)
    return say(refusedChange(), true, answer("laf:routine_needs_id"));

  /*
   * THE THREE FIELDS, PICKED, and never the arguments as they came. A model can be talked into
   * sending anything — `keepRunning`, `agentId`, `autoReview` — and the route drops what it does not
   * read, but a field that never leaves the browser is a field nobody has to trust a route about.
   */
  const change = {
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(args.instruction === undefined
      ? {}
      : { instruction: args.instruction }),
    ...(args.summary === undefined ? {} : { summary: args.summary }),
    ...(args.schedule === undefined ? {} : { schedule: args.schedule }),
  };
  const edits = Object.keys(change).length > 0;
  const toggles = typeof args.enabled === "boolean";
  if (args.action === "update" && !edits && !toggles) {
    return say(refusedChange(), true, answer("laf:routine_nothing_to_change"));
  }

  const routines = await routinesOf(botId);
  if (!routines) {
    return say(refusedChange(), true, answer("laf:routine_list_unavailable"));
  }
  const found = findRoutine(routines, wanted);
  if (found.kind !== "found") {
    return say(
      refusedChange(),
      true,
      routineListResult(
        found.kind === "ambiguous"
          ? "laf:routine_name_ambiguous"
          : "laf:routine_name_unknown",
        routines,
      ),
    );
  }
  const target = found.routine;
  const path = `/api/routines/${encodeURIComponent(target.id)}`;

  if (args.action === "delete") {
    const response = await fetch(path, {
      method: "DELETE",
      credentials: "include",
    });
    if (!response.ok) {
      return say(
        line(t("Deleting a routine"), t("Could not delete a routine")),
        true,
        answer(await codeOf(response, "laf:routine_not_found")),
      );
    }
    return await done(
      line(t("Deleting a routine"), t("Deleted a routine"), target.name),
      answer("laf:routine_deleted"),
    );
  }

  /*
   * THE EDIT FIRST, THEN THE SWITCH. An edit can be refused — a time that is not HH:MM — and a
   * routine switched back on under a schedule the person did not ask for is worse than one left as
   * it was; so a refused edit stops the call before the switch is touched.
   */
  const said: string[] = [];
  let edited: Line | null = null;
  if (edits) {
    const response = await fetch(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(change),
    });
    if (!response.ok) {
      return say(
        refusedChange(target.name),
        true,
        answer(await codeOf(response, "laf:routine_not_found")),
      );
    }
    const saved = (await response.json().catch(() => null)) as {
      routine?: { name?: unknown };
    } | null;
    said.push(routineUpdatedText(saved?.routine));
    edited = line(
      t("Changing a routine"),
      t("Changed a routine"),
      typeof saved?.routine?.name === "string"
        ? saved.routine.name
        : target.name,
      target.id,
    );
  }

  if (toggles) {
    const response = await fetch(`${path}/enabled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ enabled: args.enabled }),
    });
    if (!response.ok) {
      const refused = answer(await codeOf(response, "laf:routine_not_found"));
      if (!edited) return say(refusedChange(target.name), true, refused);
      // The edit stands and the switch did not: the Bot is told both halves, and the line says
      // what did happen.
      return await done(edited, [...said, refused].join(" "));
    }
    said.push(
      answer(args.enabled ? "laf:routine_resumed" : "laf:routine_paused"),
    );
  }

  return await done(
    edited ??
      (args.enabled
        ? line(t("Resuming a routine"), t("Resumed a routine"), target.name)
        : line(t("Pausing a routine"), t("Paused a routine"), target.name)),
    said.join(" "),
  );
}

export function SelfTools() {
  const bot = useActiveBotHolder();
  // Which Bot's routines a card may be drawn from. A value, where `bot` is a holder for handlers.
  const declaredBot = useDeclaredBotId();
  const queryClient = useQueryClient();
  /*
   * What each call changed, for the transcript line. A ref because the handler outlives the render
   * that registered it — the same reason the coworker tool keeps its exchanges in one.
   */
  const changes = useRef(new Map<string, Line & { failed?: boolean }>());

  /** Note what this call did, so the line can say it rather than naming the tool. */
  const noteFor =
    (call: { toolCall?: { id?: string } }) =>
    (entry: Line, failed?: boolean) => {
      const id = call.toolCall?.id;
      if (id) {
        changes.current.set(id, { ...entry, ...(failed ? { failed } : {}) });
      }
    };

  useFrontendTool({
    name: UPDATE_PROFILE.name,
    description: UPDATE_PROFILE.description,
    parameters: asStandardSchema<{
      name?: string;
      description?: string;
      effort?: AgentEffort;
    }>(UPDATE_PROFILE.parameters),
    handler: async (
      args: {
        name?: string;
        description?: string;
        effort?: AgentEffort;
      },
      call: { toolCall?: { id?: string } } = {},
    ) => {
      const { name, description, effort } = args;
      const remember = noteFor(call);

      const patch: Record<string, string> = {};
      if (name !== undefined) patch.name = name;
      if (description !== undefined) patch.roleDescription = description;
      if (effort !== undefined) patch.effort = effort;

      const changed = [
        ...(name === undefined ? [] : [t("name")]),
        ...(description === undefined ? [] : [t("what it is for")]),
        /*
         * The field, then the value it was set to. Its siblings are field names, so the bare label
         * put a value in a list of names — "이름, 빠르게" — which reads as a Bot that renamed
         * itself to "quickly". Naming both is also more useful than either: the one thing a person
         * would want to check about this change is which way it went.
         */
        ...(effort === undefined
          ? []
          : [
              t("how hard it thinks ({level})", {
                level: effortLabel(effort),
              }),
            ]),
      ];
      const profileLine = {
        doing: t("Updating its own profile"),
        done: t("Updated its own profile"),
        note: changed.join(", "),
      };
      remember(profileLine);

      const response = await fetch(
        `/api/agents/${encodeURIComponent(bot.current)}/profile`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify(patch),
        },
      );
      if (!response.ok) {
        remember(profileLine, true);
        // Back to the model as text, so it can tell the person what happened rather than the
        // runtime flattening a thrown error into noise.
        return answer(await codeOf(response, "laf:profile_invalid"));
      }

      // The roster shows the name and the face; without this the sidebar keeps the old one until
      // something else happens to refetch, and the person watches the Bot agree and change nothing.
      await queryClient.invalidateQueries({ queryKey: agentKeys.all });
      return answer("laf:profile_updated");
    },
    /*
     * Named for what happened, not for the tool. A person watching their Bot change its own profile
     * should read "this Bot updated its own profile", not `update_profile`.
     */
    render: ({ status, toolCallId }) => {
      const entry = changes.current.get(toolCallId ?? "");
      const running = status !== "complete";
      return (
        <ToolLine
          failed={entry?.failed === true}
          label={
            running
              ? (entry?.doing ?? t("Updating its own profile"))
              : (entry?.done ?? t("Updated its own profile"))
          }
          running={running}
        >
          {entry?.note ? <p>{entry.note}</p> : null}
        </ToolLine>
      );
    },
  });

  useFrontendTool({
    name: MANAGE_ROUTINE.name,
    description: MANAGE_ROUTINE.description,
    parameters: asStandardSchema<RoutineArgs>(MANAGE_ROUTINE.parameters),
    handler: async (
      args: RoutineArgs,
      call: { toolCall?: { id?: string } } = {},
    ) => routineAction(args, bot.current, noteFor(call), queryClient),
    render: ({ args, status, toolCallId, result }) => {
      const entry = changes.current.get(toolCallId ?? "");
      const running = status !== "complete";
      const asked = args as RoutineArgs | undefined;
      /*
       * The line says what the Bot did. One tool does several things, and saying "saved a routine"
       * while it deleted one is the kind of small lie that makes a person stop reading these lines.
       * The entry lives only in this tab's memory, so after a reload the line is drawn from the
       * action the Bot asked for: a Bot that only listed its routines read "Changed a routine"
       * until 2026-09-24.
       */
      const fallback = routineLineFor(asked?.action);
      const label = entry
        ? running
          ? entry.doing
          : entry.done
        : running
          ? fallback.doing
          : fallback.done;
      const line = (
        <ToolLine
          failed={entry?.failed === true}
          label={label}
          running={running}
        >
          {entry?.note ? <p>{entry.note}</p> : null}
        </ToolLine>
      );
      /*
       * A SAVE OR AN EDIT THAT WENT THROUGH IS DRAWN AS THE ROUTINE, not as a sentence about it:
       * name, "매주 월 오전 9:00", when it runs next, 끄기 and 고치기 (UI/UX audit 0.5.3, item 8).
       * An edit is a line of its own with the schedule it has now, since the save's card above it
       * already reads the routine as it is. Anything else — a list, a pause, a refusal — keeps the
       * line, and so does a routine the list no longer holds.
       */
      if (running || !routineCallLanded(asked?.action, entry, result)) {
        return line;
      }
      return (
        <RoutineCard
          agentId={declaredBot}
          compact={asked?.action === "update"}
          fallback={line}
          names={[asked?.name ?? "", asked?.routineId ?? ""]}
          routineId={entry?.routineId}
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
   * so a password that got in there is read by every later conversation, every room and every
   * routine. See `agents/memory-store.ts`.
   */
  useFrontendTool({
    name: REMEMBER.name,
    description: REMEMBER.description,
    parameters: asStandardSchema<{ fact?: string; place?: string }>(
      REMEMBER.parameters,
    ),
    handler: async (
      args: { fact?: string; place?: string },
      call: { toolCall?: { id?: string } } = {},
    ) => {
      const botId = bot.current;
      const note = (text: string, failed?: boolean) =>
        noteFor(call)(
          {
            done: t("Remembered something"),
            doing: t("Remembering"),
            note: text,
          },
          failed,
        );

      /*
       * A PLACE GOES TO 내 가게, NOT TO THE MEMORY LIST. The person's shop location is one field they
       * can see and clear on 내 가게, and the Bot's browser follows it; a sentence in the memory list
       * could be neither shown there nor cleared from there. Saved through the person's own session,
       * checked and kept coarse by the server (`account/whereabouts.ts`).
       */
      if (args.place?.trim()) {
        const kept = await keepPlace(
          { place: args.place, coordinates: null },
          queryClient,
        );
        if (!kept.ok) {
          note(
            kept.code === "laf:place_invalid"
              ? t(
                  "That place was not saved. Only a city and district can be kept.",
                )
              : t("That was not saved. Try again."),
            true,
          );
          return answer(kept.code);
        }
        noteFor(call)({
          done: t("Saved the shop's location"),
          doing: t("Remembering"),
          note: kept.whereabouts.place ?? args.place,
        });
        return answer("laf:place_saved");
      }

      if (!botId) {
        note(t("There is no Bot to remember this."), true);
        return answer("laf:no_bot_here");
      }

      const response = await fetch(
        `/api/agents/${encodeURIComponent(botId)}/memories`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: args.fact ?? "" }),
        },
      );
      if (!response.ok) {
        const code = await codeOf(response, "laf:memory_empty");
        /*
         * A refused secret is NOT echoed onto the transcript line. The whole point of refusing it
         * is that the value stops here; printing it under "could not remember" would put the
         * password on the screen and in the conversation snapshot, which is where it was going in
         * the first place.
         *
         * Every other refusal the route can name is said in the surface's own words — "the memory
         * is full" is something the person can act on, the refused sentence is not.
         */
        const refusal = AGENT_REFUSALS[code];
        note(
          code === "laf:memory_looks_like_a_secret"
            ? t("A secret was not written down.")
            : refusal
              ? t(refusal)
              : (args.fact ?? ""),
          true,
        );
        return answer(code);
      }

      note(args.fact ?? "");
      // The Bot's own screen lists these, and it is open while somebody is talking to it.
      await queryClient.invalidateQueries({
        queryKey: agentKeys.memories(botId),
      });
      return answer("laf:remembered");
    },
    render: ({ status, toolCallId }) => {
      const entry = changes.current.get(toolCallId ?? "");
      const running = status !== "complete";
      return (
        <ToolLine
          failed={entry?.failed === true}
          label={
            running
              ? t("Remembering")
              : (entry?.done ?? t("Remembered something"))
          }
          running={running}
        >
          {entry?.note ? <p>{entry.note}</p> : null}
        </ToolLine>
      );
    },
  });

  return null;
}

/**
 * Whether a routine call saved or changed a routine — the only two that are drawn as its card.
 *
 * This tab's own record says so directly: only a save or an edit that went through carries the
 * routine's id. After a reload that record is gone and the Bot's answer is what is left, so the
 * answer is read for the sentence a success hands the Bot — its opening words, from the same table
 * the handler wrote it from, so the two cannot drift apart.
 */
export function routineCallLanded(
  action: RoutineArgs["action"] | undefined,
  entry: (Line & { failed?: boolean }) | undefined,
  result: string | undefined,
): boolean {
  if (action !== "create" && action !== "update") return false;
  if (entry) return entry.routineId !== undefined && entry.failed !== true;
  const said = answerText(result);
  const opening = (
    TOOL_RESULT_KO[
      action === "create" ? "laf:routine_saved" : "laf:routine_updated"
    ] ?? ""
  ).split("{")[0];
  return Boolean(opening) && said.startsWith(opening ?? "");
}

/** A tool result as the transcript keeps it: the handler's string, sometimes JSON-quoted once. */
function answerText(result: string | undefined): string {
  if (!result) return "";
  if (!result.startsWith('"')) return result;
  try {
    const parsed: unknown = JSON.parse(result);
    return typeof parsed === "string" ? parsed : result;
  } catch {
    return result;
  }
}

/** What a routine line says when this tab did not see the call happen (after a reload). */
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
