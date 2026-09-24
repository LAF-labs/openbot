import { useFrontendTool } from "@copilotkit/react-core/v2";
import { toolResultText } from "@shared/prompt/tool-results.ko";
import { normalizeSkillName, SKILL_VIEW } from "@shared/tools/skills";
import { asStandardSchema } from "@shared/tools/standard-schema";
import { useRef, useState } from "react";
import { ToolLine } from "@/components/channels/tool-line";
import { t } from "@/lib/i18n";
import { viewSkill } from "@/lib/plugins/queries";
import { useActiveBotHolder } from "./active-bot";

/**
 * A Bot reading one of its own skills, from inside the conversation.
 *
 * Until now a skill reached a Bot only when a person picked it from the `/` menu, and the Bot did
 * not know skills existed: "재고 좀 정리해 줘" with a perfectly matching skill installed went
 * unanswered unless the person remembered its name. The prompt now lists the Bot's skills by name
 * and one line (`shared/prompt/skill-index.ts`); this is the tool that fetches the body.
 *
 * REGISTERED ALWAYS, whether or not the Bot holds a skill (2026-09-25, agent-harness-design row 5).
 * It used to appear only once a skill was granted, on the footprint ladder's reasoning that every
 * tool costs every turn. But the tools are the head of the prompt: the day the first skill was
 * granted, the tool list changed and the whole conversation behind it was billed again, and a
 * tool that comes and goes is a prefix that never settles. Claude Code's rule is the one kept —
 * never add or remove a tool mid-session. Its description says to read only a skill the prompt
 * lists, and a Bot that holds none is answered `laf:skill_not_granted` by the server.
 *
 * The body and the audit row come from the server (`viewSkill`), which rechecks the grant. The
 * instructions are in the grants query already, but reading them here would leave no trace of a
 * Bot choosing a skill nobody typed with `/` — and that trace is the point.
 */
export function SkillTools() {
  const bot = useActiveBotHolder();
  /** Per-call render state. The SDK captures `render` at registration, so it reads a ref. */
  const calls = useRef(
    new Map<string, { name: string; title?: string; failed?: boolean }>(),
  );
  const [, redraw] = useState(0);
  const touch = () => redraw((tick) => tick + 1);

  useFrontendTool({
    name: SKILL_VIEW.name,
    description: SKILL_VIEW.description,
    parameters: asStandardSchema<{ name: string }>(SKILL_VIEW.parameters),
    handler: async (
      args: { name?: string },
      call: { toolCall?: { id?: string } } = {},
    ) => {
      const id = call.toolCall?.id ?? "";
      const name = normalizeSkillName(String(args.name ?? ""));
      calls.current.set(id, { name });
      touch();

      const viewed = await viewSkill(bot.current, name);
      if (!viewed.ok) {
        calls.current.set(id, { name, failed: true });
        touch();
        // The same sentence a routine's Bot reads for the same code.
        return {
          ok: false,
          code: viewed.code,
          reason: toolResultText(viewed.code),
        };
      }
      calls.current.set(id, { name, title: viewed.skill.title });
      touch();
      return { ok: true, ...viewed.skill };
    },
    render: ({ status, toolCallId }) => {
      const entry = calls.current.get(toolCallId ?? "");
      const running = status !== "complete";
      return (
        <ToolLine
          detail={entry?.title ?? entry?.name}
          failed={entry?.failed === true}
          kind="document"
          label={running ? t("Reading a skill") : t("Read a skill")}
          running={running}
        />
      );
    },
  });

  return null;
}
