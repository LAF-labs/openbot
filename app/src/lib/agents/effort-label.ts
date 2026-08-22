import { type AgentEffort, AGENT_EFFORTS } from "@/lib/agents/queries";
import { t } from "@/lib/i18n";

/**
 * How hard a Bot thinks, in the words a person picks between.
 *
 * Named for the wait, not for the mechanism. The stored values are `quick`, `balanced` and
 * `thorough`, and they become a reasoning effort at the model call — but somebody choosing between
 * "low" and "high" is being asked to reason about an API, and the thing they actually want to say is
 * whether they mind waiting.
 *
 * Its own module because two places need the same three words and a second copy would drift: a Bot
 * that says it set itself to 꼼꼼하게 and a control that reads 높음 are the same setting described
 * two ways, and a person cannot tell whether that is one thing or two.
 */
export function effortLabel(effort: AgentEffort): string {
  if (effort === "quick") return t("Quick");
  if (effort === "thorough") return t("Thorough");
  return t("Balanced");
}

export { AGENT_EFFORTS, type AgentEffort };
