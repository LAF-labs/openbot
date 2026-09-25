import type { AttachmentPart } from "@shared/attachments";
import {
  getChipsByTrigger,
  isSegmentsEmpty,
  mergeAdjacentTextSegments,
  type Segment,
  segmentsToPlainText,
  text,
} from "prompt-area/helpers";

/**
 * Pure boundary between prompt-area segments and LAF Agent's message draft model.
 */

export const COMMAND_TRIGGER = "/";

/**
 * A `/name` at the start of a sent message: the skill it was sent with, and the rest after it.
 *
 * The name's letters are the skills' own (`SKILL_SLUG_PATTERN`, shared/tools/skills.ts), Korean
 * included since 0.5.3 — `/리뷰답장` is a skill, and the a–z pattern this replaced left it drawn as
 * plain text in the conversation and asked again without its instruction.
 */
export const LEADING_SKILL =
  /^\/([\p{Ll}\p{Lo}\p{Nd}][\p{Ll}\p{Lo}\p{Nd}-]*)(\s|$)/u;

export type ComposerDraft = {
  /** Plain text, with chips flattened back to `/command`. */
  text: string;
  /** Commands that survive into the sent message, in the order they were typed. */
  commandIds: string[];
  /** Whether nothing is TYPED. A draft of files alone is not empty to send; see `attachments`. */
  isEmpty: boolean;
  /** Files the server already kept, as the parts the message carries (`@shared/attachments`). */
  attachments?: AttachmentPart[];
};

export function toDraft(segments: Segment[]): ComposerDraft {
  const commandChips = getChipsByTrigger(segments, COMMAND_TRIGGER);

  return {
    text: segmentsToPlainText(segments).trim(),
    commandIds: commandChips.map((chip) => chip.value),
    isEmpty: isSegmentsEmpty(segments),
  };
}

/**
 * What a `/command` does once it has been picked from the dropdown.
 *
 * - `chip` keeps the chip in the message, so the runtime receives it as structured data.
 * - `prompt` expands into editable text, for the channel's seeded suggested prompts.
 * - `action` runs client-side and never reaches the runtime.
 *
 * prompt-area always resolves a dropdown selection into a chip, so `prompt` and `action` are
 * applied here on the next change instead of being special-cased inside the editor.
 */
export type CommandKind = "chip" | "prompt" | "action";

export type CommandOption = {
  id: string;
  name: string;
  description?: string;
  /** Defaults to `chip`. */
  kind?: CommandKind;
  /** Text substituted for the command when `kind` is `prompt`. */
  prompt?: string;
  /** Side effect run when `kind` is `action`. */
  run?: () => void;
};

export type AppliedCommands = {
  segments: Segment[];
  /** Actions to run after the new segments are committed to state. */
  actions: (() => void)[];
};

/**
 * Rewrites `prompt` and `action` command chips, leaving `chip` commands (and everything else)
 * alone. Side effects are returned rather than run so the transform stays pure and testable.
 */
export function applyCommandChips(
  segments: Segment[],
  commands: readonly CommandOption[],
): AppliedCommands {
  const byId = new Map(commands.map((command) => [command.id, command]));
  const actions: (() => void)[] = [];
  let changed = false;

  const rewritten = segments.flatMap<Segment>((segment) => {
    if (segment.type !== "chip" || segment.trigger !== COMMAND_TRIGGER) {
      return [segment];
    }

    const command = byId.get(segment.value);
    const kind = command?.kind ?? "chip";

    if (kind === "prompt") {
      changed = true;
      return command?.prompt ? [text(command.prompt)] : [];
    }

    if (kind === "action") {
      changed = true;
      if (command?.run) {
        actions.push(command.run);
      }
      return [];
    }

    return [segment];
  });

  return {
    segments: changed ? mergeAdjacentTextSegments(rewritten) : segments,
    actions,
  };
}
