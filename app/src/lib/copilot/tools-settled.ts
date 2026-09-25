import { useQuery } from "@tanstack/react-query";
import { agentComponentsQueryOptions } from "@/lib/components/queries";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import { publishedSandboxedQueryOptions } from "@/lib/sandboxed/queries";

/**
 * Whether the tools a turn with this Bot offers have been decided.
 *
 * The surface registers every tool once, but which of them a run carries depends on the Bot's
 * grants: the gallery's cards and the browser-authored components are offered only once their grant
 * query has answered (`available`), and a connected service's tools only once they are listed. Those
 * queries start when a conversation names its Bot — so a turn sent the moment a conversation opens
 * went out before they had answered.
 *
 * MEASURED 2026-09-25: the first message from the compose screen carried 18 surface tools and the
 * next one 31, the thirteen cards appearing between them. The context layer froze the first list,
 * the Bot could not show a card on its first answer, and the second turn carried a reminder that
 * the tools had changed — a conversation's tools changing mid-conversation, which the harness
 * forbids (agent-harness-design rows 1–5). A turn now waits for this.
 *
 * Settled means answered, not granted: a query that failed has decided too, and a Bot with no
 * grants is a Bot with none.
 */
export function useToolsSettled(botId: string): boolean {
  const declared = useDeclaredBotId();
  const components = useQuery(agentComponentsQueryOptions(botId));
  const plugins = useQuery(agentPluginsQueryOptions(botId));
  const published = useQuery(publishedSandboxedQueryOptions(true));
  return (
    declared === botId &&
    !components.isPending &&
    !plugins.isPending &&
    !published.isPending
  );
}
