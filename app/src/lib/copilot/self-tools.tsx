import { useFrontendTool } from "@copilotkit/react-core/v2";
import { toolResultText } from "@shared/prompt/tool-results.ko";
import { MANAGE_ROUTINE, REMEMBER, UPDATE_PROFILE } from "@shared/tools/self";
import { asStandardSchema } from "@shared/tools/standard-schema";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { ToolLine } from "@/components/channels/tool-line";
import { type AgentEffort, effortLabel } from "@/lib/agents/effort-label";
import { agentKeys } from "@/lib/agents/queries";
import { t } from "@/lib/i18n";
import { routineKeys } from "@/lib/routines/queries";
import { useActiveBotHolder } from "./active-bot";

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

/** A `laf:` code out of a route's reply, or a generic one when the reply carried no shape at all. */
async function codeOf(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
  } | null;
  return typeof body?.code === "string" && body.code.startsWith("laf:")
    ? body.code
    : fallback;
}

type RoutineArgs = {
  action?: "create" | "update" | "delete";
  name?: string;
  routineId?: string;
  instruction?: string;
  enabled?: boolean;
  schedule?: {
    kind: "daily" | "interval";
    time?: string;
    timeZone?: string;
    days?: number[];
    minutes?: number;
  };
};

/**
 * The routine tool's work.
 *
 * A person asking for something every morning is asking for a routine, and before this the only way
 * to get one was to leave the conversation, open the Routines page and re-type what they had just
 * said. The Bot writes it down instead — for itself, on its own id, which is why no agent id
 * crosses the tool boundary.
 *
 * The only checks here are the ones that decide WHICH URL to call: an id-less update has no route
 * to be sent to. Everything about whether the routine is well formed — a name, an instruction, a
 * schedule that ever comes round — is answered by the routines API, in codes.
 */
async function routineAction(
  args: RoutineArgs,
  botId: string,
  remember: (
    entry: { done: string; doing: string; note?: string },
    failed?: boolean,
  ) => void,
  queryClient: QueryClient,
): Promise<string> {
  const line = (doing: string, done: string, note?: string) => ({
    doing,
    done,
    ...(note ? { note } : {}),
  });
  const say = (
    entry: { done: string; doing: string; note?: string },
    failed: boolean,
    code: string,
  ) => {
    remember(entry, failed);
    return answer(code);
  };
  const done = async (
    entry: { done: string; doing: string; note?: string },
    code: string,
  ) => {
    // The Routines screen and the Bot panel both read this list.
    await queryClient.invalidateQueries({ queryKey: routineKeys.all });
    return say(entry, false, code);
  };

  if (args.action === "create") {
    const response = await fetch("/api/routines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        agentId: botId,
        name: args.name?.trim() ?? "",
        instruction: args.instruction?.trim() ?? "",
        ...(args.schedule ? { schedule: args.schedule } : {}),
      }),
    });
    const name = args.name?.trim();
    if (!response.ok) {
      return say(
        line(t("Saving a routine"), t("Could not save a routine")),
        true,
        await codeOf(response, "laf:routine_incomplete"),
      );
    }
    return await done(
      line(t("Saving a routine"), t("Saved a routine"), name),
      "laf:routine_saved",
    );
  }

  const routineId = args.routineId?.trim();
  if (!routineId) {
    return say(
      line(t("Changing a routine"), t("Could not change a routine")),
      true,
      "laf:routine_needs_id",
    );
  }

  if (args.action === "delete") {
    const response = await fetch(
      `/api/routines/${encodeURIComponent(routineId)}`,
      { method: "DELETE", credentials: "include" },
    );
    if (!response.ok) {
      return say(
        line(t("Deleting a routine"), t("Could not delete a routine")),
        true,
        await codeOf(response, "laf:routine_not_found"),
      );
    }
    return await done(
      line(t("Deleting a routine"), t("Deleted a routine")),
      "laf:routine_deleted",
    );
  }

  if (args.action === "update") {
    /*
     * Pausing and resuming is what `update` reaches today, and the description says so.
     *
     * The routines API has no route that rewrites a routine's text or its schedule — the screen
     * has no such control either — so a tool offering it would be a control that saves and does
     * nothing, which is worse than not drawing it. Changing what a routine says is delete and
     * create, which is two calls the Bot can actually make.
     */
    if (typeof args.enabled !== "boolean") {
      return say(
        line(t("Changing a routine"), t("Could not change a routine")),
        true,
        "laf:routine_needs_enabled",
      );
    }
    const response = await fetch(
      `/api/routines/${encodeURIComponent(routineId)}/enabled`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ enabled: args.enabled }),
      },
    );
    if (!response.ok) {
      return say(
        line(t("Changing a routine"), t("Could not change a routine")),
        true,
        await codeOf(response, "laf:routine_not_found"),
      );
    }
    return await done(
      args.enabled
        ? line(t("Resuming a routine"), t("Resumed a routine"))
        : line(t("Pausing a routine"), t("Paused a routine")),
      args.enabled ? "laf:routine_resumed" : "laf:routine_paused",
    );
  }

  return say(
    line(t("Changing a routine"), t("Could not change a routine")),
    true,
    "laf:routine_unknown_action",
  );
}

export function SelfTools() {
  const bot = useActiveBotHolder();
  const queryClient = useQueryClient();
  /*
   * What each call changed, for the transcript line. A ref because the handler outlives the render
   * that registered it — the same reason the coworker tool keeps its exchanges in one.
   */
  const changes = useRef(
    new Map<
      string,
      { done: string; doing: string; note?: string; failed?: boolean }
    >(),
  );

  /** Note what this call did, so the line can say it rather than naming the tool. */
  const noteFor =
    (call: { toolCall?: { id?: string } }) =>
    (
      entry: { done: string; doing: string; note?: string },
      failed?: boolean,
    ) => {
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
      title?: string;
      description?: string;
      effort?: AgentEffort;
    }>(UPDATE_PROFILE.parameters),
    handler: async (
      args: {
        name?: string;
        title?: string;
        description?: string;
        effort?: AgentEffort;
      },
      call: { toolCall?: { id?: string } } = {},
    ) => {
      const { name, description, title, effort } = args;
      const remember = noteFor(call);

      const patch: Record<string, string> = {};
      if (name !== undefined) patch.name = name;
      if (description !== undefined) patch.roleDescription = description;
      if (title !== undefined) patch.title = title;
      if (effort !== undefined) patch.effort = effort;

      const changed = [
        ...(name === undefined ? [] : [t("name")]),
        ...(title === undefined ? [] : [t("title")]),
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
    render: ({ status, toolCallId }) => {
      const entry = changes.current.get(toolCallId ?? "");
      const running = status !== "complete";
      /*
       * The line says what the Bot did. One tool does three things, and saying "saved a routine"
       * while it deleted one is the kind of small lie that makes a person stop reading these lines.
       */
      const label = entry
        ? running
          ? entry.doing
          : entry.done
        : running
          ? t("Changing a routine")
          : t("Changed a routine");
      return (
        <ToolLine
          failed={entry?.failed === true}
          label={label}
          running={running}
        >
          {entry?.note ? <p>{entry.note}</p> : null}
        </ToolLine>
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
    parameters: asStandardSchema<{ fact: string }>(REMEMBER.parameters),
    handler: async (
      args: { fact: string },
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
          body: JSON.stringify({ content: args.fact }),
        },
      );
      if (!response.ok) {
        const code = await codeOf(response, "laf:memory_empty");
        /*
         * A refused secret is NOT echoed onto the transcript line. The whole point of refusing it
         * is that the value stops here; printing it under "could not remember" would put the
         * password on the screen and in the conversation snapshot, which is where it was going in
         * the first place.
         */
        note(
          code === "laf:memory_looks_like_a_secret"
            ? t("A secret was not written down.")
            : args.fact,
          true,
        );
        return answer(code);
      }

      note(args.fact);
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
          label={running ? t("Remembering") : t("Remembered something")}
          running={running}
        >
          {entry?.note ? <p>{entry.note}</p> : null}
        </ToolLine>
      );
    },
  });

  return null;
}
