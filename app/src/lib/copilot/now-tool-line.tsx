import { useRenderTool } from "@copilotkit/react-core/v2";
import { NOW_TOOL } from "@shared/tools/now";
import { asStandardSchema } from "@shared/tools/standard-schema";
import { ToolLine } from "@/components/channels/tool-line";
import { t } from "@/lib/i18n";

/**
 * The line a `now` call leaves in the conversation.
 *
 * `now` is the Bot's `date` (`shared/tools/now.ts`): answered inside agent-bot's run, never
 * executed here, so the surface registers a renderer and no tool. Without one the transcript's
 * fallback drew the tool's own name — "now", in English, in a Korean conversation.
 */
export function NowToolLine() {
  useRenderTool({
    name: NOW_TOOL.name,
    parameters: asStandardSchema(NOW_TOOL.parameters),
    render: ({ status }) => {
      const running = status !== "complete";
      return (
        <ToolLine
          label={running ? t("Checking the time") : t("Checked the time")}
          running={running}
        />
      );
    },
  });
  return null;
}
