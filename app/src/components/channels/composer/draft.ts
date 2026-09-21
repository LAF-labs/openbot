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

export const AGENT_TRIGGER = "@";
export const COMMAND_TRIGGER = "/";

export type ComposerDraft = {
  /** Plain text, with chips flattened back to `@Agent` / `/command`. */
  text: string;
  /**
   * Everybody this message names with `@`, in the order they were typed. Empty lets the
   * conversation pick — its one coworker, or, in a room, everybody in it.
   *
   * IT WAS ONE, AND ONE WAS A LIE THE SURFACE TOLD ABOUT ITSELF. `enforceSingleAgent` used to
   * DELETE every mention chip but the last one as you typed, so naming two colleagues in a room
   * silently unnamed the first — while the server has taken a list the whole time
   * (`rooms/orchestrator.ts`: "Who the person named — chips and @-mentions, as ids. Empty means
   * everybody"). The block was entirely on this side.
   *
   * Deleting those chips was also the one thing in this composer that rewrote the editor's DOM in
   * the middle of a keystroke, which is how a Korean syllable being assembled gets thrown away
   * (see `composer.tsx`). Nothing rewrites segments for mentions now: what was typed stays typed,
   * and the repetition is resolved here, on the way out.
   */
  agentIds: readonly string[];
  /** Commands that survive into the sent message, in the order they were typed. */
  commandIds: string[];
  isEmpty: boolean;
};

export function toDraft(segments: Segment[]): ComposerDraft {
  const agentChips = getChipsByTrigger(segments, AGENT_TRIGGER);
  const commandChips = getChipsByTrigger(segments, COMMAND_TRIGGER);

  return {
    text: segmentsToPlainText(segments).trim(),
    /*
     * The same Bot named twice is one recipient. "@초롱 …, @초롱 다시 봐줘" is one person saying one
     * colleague's name twice, not a request to run the turn twice; the server refuses a duplicate
     * outright when a channel is created from this (`channels/input.ts`), so a repeat reaching it
     * would come back as a refusal on a message that reads perfectly well.
     */
    agentIds: [...new Set(agentChips.map((chip) => chip.value))],
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
