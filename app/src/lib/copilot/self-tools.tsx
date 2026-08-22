import { useFrontendTool } from "@copilotkit/react-core/v2";
import { useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { agentKeys } from "@/lib/agents/queries";
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
export function SelfTools() {
  const bot = useActiveBotHolder();
  const queryClient = useQueryClient();
  /*
   * What each call changed, for the transcript line. A ref because the handler outlives the render
   * that registered it — the same reason the coworker tool keeps its exchanges in one.
   */
  const changes = useRef(
    new Map<string, { fields: string[]; failed?: boolean }>(),
  );

  useFrontendTool({
    name: "update_state",
    description:
      "Change your own profile — your name, what you are for, or your face. Use this the moment " +
      "the person tells you what they want you to do, so you still know it in every later " +
      "conversation. Send only the fields that change. This edits you and no one else.",
    parameters: z.object({
      target: z
        .literal("profile")
        .describe("What to change. Only 'profile' is supported so far."),
      name: z.string().optional().describe("Your new name, if it changes"),
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
    }),
    handler: async (
      {
        name,
        description,
        title,
      }: {
        target: "profile";
        name?: string;
        description?: string;
        title?: string;
      },
      call: { toolCall?: { id?: string } } = {},
    ) => {
      const patch: Record<string, string> = {};
      if (name !== undefined) patch.name = name;
      if (description !== undefined) patch.roleDescription = description;
      if (title !== undefined) patch.title = title;
      if (Object.keys(patch).length === 0) {
        return "Nothing was changed: no fields were given.";
      }
      const changed = [
        ...(name === undefined ? [] : [t("name")]),
        ...(title === undefined ? [] : [t("title")]),
        ...(description === undefined ? [] : [t("what it is for")]),
      ];
      const remember = (failed?: boolean) => {
        const id = call.toolCall?.id;
        if (id) {
          changes.current.set(id, {
            fields: changed,
            ...(failed ? { failed } : {}),
          });
        }
      };
      remember();

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
        remember(true);
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
      return (
        <ToolLine
          failed={entry?.failed === true}
          label={
            running
              ? t("Updating its own profile")
              : t("Updated its own profile")
          }
          running={running}
        >
          {entry?.fields.length ? <p>{entry.fields.join(", ")}</p> : null}
        </ToolLine>
      );
    },
  });

  return null;
}
