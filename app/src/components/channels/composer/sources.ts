import type { CommandOption } from "./draft";

/**
 * No slash commands by default.
 *
 * This used to hold one fabricated `/summarize` that pasted an English sentence — "Summarize what we
 * covered in this channel so far." — into the box. Home inherited it, where there is no channel to
 * summarise and the sentence is not in the reader's language. A menu that offers something the
 * product cannot do is worse than an empty one, and every call site now passes the Bot's real
 * granted skills through `useSkillCommands`.
 *
 * Kept as a named export rather than deleted: `commands` is an optional prop, and this is the
 * documented default for a caller that has no agent to ask about yet.
 */
export const PLACEHOLDER_COMMANDS: CommandOption[] = [];
