import { useFrontendTool } from "@copilotkit/react-core/v2";
import { normalizeSkillName, SKILL_VIEW } from "@shared/tools/skills";
import { asStandardSchema } from "@shared/tools/standard-schema";
import { stepFailureOf } from "@shared/tools/step-result";
import { ToolLine } from "@/components/channels/tool-line";
import { t } from "@/lib/i18n";
import { keptText } from "./kept-result";

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
 * The body and the audit row come from the server (`viewSkill` in the plugin store, called by
 * `server/src/turns/chat-tools.ts`), which rechecks the grant: reading the instructions here would
 * leave no trace of a Bot choosing a skill nobody typed with `/` — and that trace is the point.
 * This is the registration the turn offers the tool from, and its line.
 *
 * THE LINE SAYS WHETHER THE SKILL WAS READ, FROM THE CALL'S OWN ANSWER. The server answers a skill
 * this Bot does not hold with `{ ok: false, code }`, and the line read "스킬을 읽음" all the same:
 * what it knew of a refusal it had from the handler the window ran, which a turn the server
 * carries out never did (review of pull request 83). It names the skill asked for; the body is the
 * Bot's to read and is not printed.
 */
export function SkillTools() {
  useFrontendTool({
    name: SKILL_VIEW.name,
    description: SKILL_VIEW.description,
    parameters: asStandardSchema<{ name: string }>(SKILL_VIEW.parameters),
    render: ({ args, status, result }) => {
      const running = status !== "complete";
      const kept = keptText(result);
      const ending = running || !kept ? null : stepFailureOf(kept);
      const name = typeof args?.name === "string" ? args.name : "";
      return (
        <ToolLine
          detail={name ? normalizeSkillName(name) : undefined}
          failed={ending !== null && ending.kind !== "refused"}
          kind="document"
          label={
            running
              ? t("Reading a skill")
              : ending
                ? t("Could not read a skill")
                : t("Read a skill")
          }
          refused={ending?.kind === "refused"}
          running={running}
        />
      );
    },
  });

  return null;
}
