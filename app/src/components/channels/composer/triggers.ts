import type { TriggerConfig, TriggerSuggestion } from "prompt-area/helpers";
import { commandTrigger, mentionTrigger } from "prompt-area/helpers";
import { t } from "@/lib/i18n";
import { AGENT_TRIGGER, COMMAND_TRIGGER, type CommandOption } from "./draft";

/**
 * The composer's trigger registry.
 *
 * Adding a trigger means adding a factory here and passing its source down; composer rendering stays
 * independent of trigger semantics.
 */

export type AgentOption = {
  id: string;
  name: string;
  description?: string;
};

/**
 * Narrows the agent roster to mention options, scoped to a channel's permitted agents when
 * `permittedIds` is given.
 *
 * Takes a structural shape so the composer stays independent of the queries module.
 */
export function toAgentOptions(
  profiles: readonly { id: string; name: string; title?: string }[] | undefined,
  permittedIds?: readonly string[],
): AgentOption[] {
  if (!profiles) {
    return [];
  }
  const permitted = permittedIds ? new Set(permittedIds) : null;
  return profiles
    .filter((profile) => !permitted || permitted.has(profile.id))
    .map((profile) => ({
      id: profile.id,
      name: profile.name,
      description: profile.title,
    }));
}

function matches(query: string, ...fields: (string | undefined)[]): boolean {
  if (!query) {
    return true;
  }
  const needle = query.toLowerCase();
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

/**
 * A trigger takes its options as something to CALL, not as a list, and the difference is the
 * caret.
 *
 * The lists these menus draw from — the roster, the granted skills — arrive a moment after the
 * composer mounts, and a trigger built around the list itself has to be rebuilt every time the list
 * does. The editor keys its DOM-sync effect on the trigger list, so each rebuild re-runs that
 * effect against the value its render closed over, and a keystroke that lands between the commit
 * and the effect is judged foreign and rendered over — with the caret dropped at the start of the
 * box (measured 2026-09-06: "안녕하세요" typed as a screen opened came out "녕하세요안"). Read at
 * the moment a menu asks, the list can change as often as it likes and the trigger never has to.
 */
export type OptionsReader<T> = () => readonly T[];

/**
 * `@` selects the agent that answers this message.
 *
 * `reopenOnChipClick` keeps an inserted mention editable without deleting and retyping.
 */
export function agentTrigger(
  agents: OptionsReader<AgentOption>,
): TriggerConfig {
  return mentionTrigger({
    char: AGENT_TRIGGER,
    accessibilityLabel: "agent",
    reopenOnChipClick: true,
    emptyMessage: t("No Bots in this conversation"),
    onSearch: (query): TriggerSuggestion[] =>
      agents()
        .filter((agent) => matches(query, agent.name, agent.description))
        .map((agent) => ({
          value: agent.id,
          label: agent.name,
          description: agent.description,
        })),
    onSelect: (suggestion) => suggestion.label,
  });
}

/**
 * `/` is restricted to the start of a line, so a URL or a date in the middle of a sentence never
 * opens the dropdown. Selection resolves to a chip; `applyCommandChips` then rewrites the ones that
 * are really prompts or client actions.
 */
export function slashCommandTrigger(
  commands: OptionsReader<CommandOption>,
): TriggerConfig {
  return commandTrigger({
    char: COMMAND_TRIGGER,
    position: "start",
    accessibilityLabel: "command",
    emptyMessage: t("No matching commands"),
    onSearch: (query): TriggerSuggestion[] =>
      commands()
        .filter((command) => matches(query, command.name, command.description))
        .map((command) => ({
          value: command.id,
          label: command.name,
          description: command.description,
        })),
    onSelect: (suggestion) => suggestion.label,
  });
}

export function buildTriggers({
  agents,
  commands,
}: {
  agents: OptionsReader<AgentOption>;
  commands: OptionsReader<CommandOption>;
}): TriggerConfig[] {
  return [agentTrigger(agents), slashCommandTrigger(commands)];
}
