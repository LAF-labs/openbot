import { useFrontendTool } from "@copilotkit/react-core/v2";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { agentKeys } from "@/lib/agents/queries";
import { routineKeys } from "@/lib/routines/queries";
import { type AgentEffort, effortLabel } from "@/lib/agents/effort-label";
import { t } from "@/lib/i18n";
import { useActiveBotHolder } from "./active-bot";

/**
 * A Bot rewriting its own profile, from inside the conversation.
 *
 * This is what makes a Bot something you shape by talking rather than something you configure once.
 * A Bot starts blank; told "you're the one who chases invoices", it writes that into its own
 * description here and still knows it next week, in every conversation, without anybody opening a
 * settings screen. Without it the only way to change a Bot was a form, and the answer the person
 * gave in conversation was forgotten as soon as the turn ended.
 *
 * It edits ITSELF and nothing else: the id comes from the active Bot holder, never from the model,
 * so there is no argument through which a Bot could rename a colleague. The server checks the
 * person's own permission on top of that.
 */
type RoutineArgs = {
  action?: "set" | "create" | "delete" | "pause" | "resume";
  name?: string;
  routineId?: string;
  instruction?: string;
  schedule?: {
    kind: "daily" | "interval";
    time?: string;
    timeZone?: string;
    days?: number[];
    minutes?: number;
  };
};

/**
 * The routine half of `update_state`.
 *
 * A person asking for something every morning is asking for a routine, and before this the only way
 * to get one was to leave the conversation, open the Routines page and re-type what they had just
 * said. The Bot writes it down instead — for itself, on its own id, which is why no agent id
 * crosses the tool boundary.
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
    message: string,
  ) => {
    remember(entry, failed);
    return message;
  };
  const done = async (
    entry: { done: string; doing: string; note?: string },
    message: string,
  ) => {
    // The Routines screen and the Bot panel both read this list.
    await queryClient.invalidateQueries({ queryKey: routineKeys.all });
    return say(entry, false, message);
  };
  const reason = async (response: Response) => {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    return body?.error ?? response.statusText;
  };

  if (args.action === "create") {
    const name = args.name?.trim();
    const instruction = args.instruction?.trim();
    if (!name || !instruction || !args.schedule) {
      return say(
        line(t("Saving a routine"), t("Could not save a routine")),
        true,
        "A routine needs a name, what it should do each time, and when to run.",
      );
    }
    const response = await fetch("/api/routines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        agentId: botId,
        name,
        instruction,
        schedule: args.schedule,
      }),
    });
    if (!response.ok) {
      return say(
        line(t("Saving a routine"), t("Saved a routine"), name),
        true,
        `The routine was not saved: ${await reason(response)}`,
      );
    }
    return await done(
      line(t("Saving a routine"), t("Saved a routine"), name),
      `Saved the routine "${name}". It runs on its own from now on; the person can see and change it on the Routines screen.`,
    );
  }

  const routineId = args.routineId?.trim();
  if (!routineId) {
    return say(
      line(t("Changing a routine"), t("Could not change a routine")),
      true,
      "Say which routine, by its id.",
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
        `The routine was not deleted: ${await reason(response)}`,
      );
    }
    return await done(
      line(t("Deleting a routine"), t("Deleted a routine")),
      "Deleted that routine.",
    );
  }

  if (args.action === "pause" || args.action === "resume") {
    const enabled = args.action === "resume";
    const response = await fetch(
      `/api/routines/${encodeURIComponent(routineId)}/enabled`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ enabled }),
      },
    );
    if (!response.ok) {
      return say(
        line(t("Changing a routine"), t("Could not change a routine")),
        true,
        `That routine was not changed: ${await reason(response)}`,
      );
    }
    return await done(
      enabled
        ? line(t("Resuming a routine"), t("Resumed a routine"))
        : line(t("Pausing a routine"), t("Paused a routine")),
      enabled ? "Resumed that routine." : "Paused that routine.",
    );
  }

  return say(
    line(t("Changing a routine"), t("Could not change a routine")),
    true,
    "Say what to do with the routine: create, delete, pause or resume.",
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

  useFrontendTool({
    name: "update_state",
    description:
      "Change your own standing state: your profile, or the routines you run on a schedule. " +
      "Use it the moment the person tells you what you are for or asks for something regular, so " +
      "it survives past this conversation. Send only what changes. This edits you and no one else.",
    parameters: z.object({
      target: z
        .enum(["profile", "routine"])
        .describe(
          "'profile' for who you are and how hard you think; 'routine' for work you repeat on a schedule",
        ),
      action: z
        .enum(["set", "create", "delete", "pause", "resume"])
        .optional()
        .describe(
          "For routine: create, delete, pause or resume. For profile: set (the default).",
        ),
      name: z
        .string()
        .optional()
        .describe("Your new name, or the routine's name when creating one"),
      description: z
        .string()
        .optional()
        .describe(
          "What you are for, in a sentence or two, written as your standing role",
        ),
      title: z
        .string()
        .optional()
        .describe("A short role label, such as 'Finance operations'"),
      effort: z
        .enum(["quick", "balanced", "thorough"])
        .optional()
        .describe(
          "How hard you think before answering. Raise it when the work needs care, lower it when speed matters more than depth.",
        ),
      routineId: z
        .string()
        .optional()
        .describe("Which routine to delete, pause or resume"),
      instruction: z
        .string()
        .optional()
        .describe(
          "What the routine does every time it fires, written to your future self",
        ),
      schedule: z
        .object({
          kind: z.enum(["daily", "interval"]),
          time: z
            .string()
            .optional()
            .describe("HH:MM on the wall clock, for a daily routine"),
          timeZone: z
            .string()
            .optional()
            .describe("IANA zone the time is written in, such as Asia/Seoul"),
          days: z
            .array(z.number())
            .optional()
            .describe("Weekdays it may run, 0 = Sunday. Omit for every day."),
          minutes: z
            .number()
            .optional()
            .describe("How often, for an interval routine"),
        })
        .optional()
        .describe("When the routine runs. Required when creating one."),
    }),
    handler: async (
      args: {
        target: "profile" | "routine";
        action?: "set" | "create" | "delete" | "pause" | "resume";
        name?: string;
        description?: string;
        title?: string;
        effort?: AgentEffort;
        routineId?: string;
        instruction?: string;
        schedule?: {
          kind: "daily" | "interval";
          time?: string;
          timeZone?: string;
          days?: number[];
          minutes?: number;
        };
      },
      call: { toolCall?: { id?: string } } = {},
    ) => {
      const { name, description, title, effort } = args;
      const remember = (
        entry: { done: string; doing: string; note?: string },
        failed?: boolean,
      ) => {
        const id = call.toolCall?.id;
        if (id) {
          changes.current.set(id, { ...entry, ...(failed ? { failed } : {}) });
        }
      };

      if (args.target === "routine") {
        return await routineAction(args, bot.current, remember, queryClient);
      }

      const patch: Record<string, string> = {};
      if (name !== undefined) patch.name = name;
      if (description !== undefined) patch.roleDescription = description;
      if (title !== undefined) patch.title = title;
      if (effort !== undefined) patch.effort = effort;
      if (Object.keys(patch).length === 0) {
        return "Nothing was changed: no fields were given.";
      }
      const changed = [
        ...(name === undefined ? [] : [t("name")]),
        ...(title === undefined ? [] : [t("title")]),
        ...(description === undefined ? [] : [t("what it is for")]),
        ...(effort === undefined ? [] : [effortLabel(effort)]),
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
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        remember(profileLine, true);
        // Back to the model as text, so it can tell the person what happened rather than the
        // runtime flattening a thrown error into noise.
        return `Your profile could not be changed: ${body?.error ?? response.statusText}`;
      }

      // The roster shows the name and the face; without this the sidebar keeps the old one until
      // something else happens to refetch, and the person watches the Bot agree and change nothing.
      await queryClient.invalidateQueries({ queryKey: agentKeys.all });
      return `Updated: ${Object.keys(patch).join(", ")}. This is now your standing profile.`;
    },
    /*
     * Named for what happened, not for the tool. A person watching their Bot change its own profile
     * should read "this Bot updated its own profile", not `update_state`.
     */
    render: ({ status, toolCallId }) => {
      const entry = changes.current.get(toolCallId ?? "");
      const running = status !== "complete";
      /*
       * The line says what the Bot did, and one tool does two things: saying "updated its own
       * profile" while it saved a routine is the kind of small lie that makes a person stop reading
       * these lines at all.
       */
      const label = entry
        ? running
          ? entry.doing
          : entry.done
        : running
          ? t("Changing its own settings")
          : t("Changed its own settings");
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

  return null;
}
