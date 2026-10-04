import { useRenderTool } from "@copilotkit/react-core/v2";
import { NOW_TOOL } from "@shared/tools/now";
import { asStandardSchema } from "@shared/tools/standard-schema";
import { stepFailureOf } from "@shared/tools/step-result";
import { ToolLine } from "@/components/channels/tool-line";
import { t } from "@/lib/i18n";
import { keptText } from "./kept-result";

/**
 * The line a `now` call leaves in the conversation.
 *
 * `now` is the Bot's `date` (`shared/tools/now.ts`): answered inside agent-bot's run, never
 * executed here, so the surface registers a renderer and no tool. Without one the transcript's
 * fallback drew the tool's own name — "now", in English, in a Korean conversation.
 *
 * It reads how the call ended, as every line of the Bot's own does: a turn stopped while the call
 * was out files a result that says so, and "시각을 확인함" over it would be a thing that did not
 * happen said as done.
 */
export function NowToolLine() {
  useRenderTool({
    name: NOW_TOOL.name,
    parameters: asStandardSchema(NOW_TOOL.parameters),
    render: ({ status, result }) => {
      const running = status !== "complete";
      const kept = keptText(result);
      const failed = !running && kept !== "" && stepFailureOf(kept) !== null;
      return (
        <ToolLine
          failed={failed}
          label={
            running
              ? t("Checking the time")
              : failed
                ? t("Could not check the time")
                : t("Checked the time")
          }
          running={running}
        />
      );
    },
  });
  return null;
}
