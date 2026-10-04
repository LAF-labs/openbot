import { CARD_NOT_ASKED } from "@shared/tools/gallery";
import { type StepFailure, stepFailureOf } from "@shared/tools/step-result";
import { ToolLine } from "@/components/channels/tool-line";
import { REFUSAL_SAID } from "@/lib/components/queries";
import { OUTCOME_LABELS } from "@/lib/computer/outcome-labels";
import { keptText } from "@/lib/copilot/kept-result";
import { t } from "@/lib/i18n";

/**
 * Visible component refusal, using the same blocked-action semantics as computer policy refusals.
 */
export function RefusedCard({
  title,
  reason,
}: {
  /** The component's own title where we know it, so a person is not shown a tool name. */
  title: string;
  reason: string;
}) {
  return (
    <div
      className="w-full max-w-2xl rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3"
      data-testid="component-refused"
      role="status"
    >
      <p className="text-sm font-medium text-destructive">
        {t("Not shown")}: {title}
      </p>
      <p className="mt-1 text-sm text-foreground/80">{reason}</p>
    </div>
  );
}

/**
 * How a card's call ended, when it ended any way but with the card on screen: null for a call
 * still out, and for one the Bot was told is on screen.
 *
 * A CARD IS DRAWN FROM THE CALL'S ARGUMENTS, SO NOTHING ABOUT DRAWING IT SAYS WHETHER IT WAS SHOWN.
 * Whether a Bot may put a card up is asked again when it calls (`component` in
 * `server/src/turns/chat-tools.ts`) — the list a window offered from is read once a minute — and a
 * card refused there answers the Bot "it was not shown". The window that carried calls out kept
 * that refusal for its own renderer, by the call; a turn the server carries out never told the
 * renderer anything, and from v0.5.7 a card switched off mid-turn, or one whose data it may not
 * read, was drawn in the conversation while the Bot was told it had not been (review of pull
 * request 83). The result the conversation keeps is the one account both sides have, so it is read
 * here, by the reader a connected service's line uses (`stepFailureOf`): a fact from the table, an
 * object of this server's, a call nothing answered.
 *
 * AND THE ONE SENTENCE THAT IS NONE OF THOSE (`CARD_NOT_ASKED`): the grant could not be asked
 * about at all.
 */
export function cardEndingOf(result: string | undefined): StepFailure | null {
  const said = keptText(result);
  if (!said) return null;
  if (said === CARD_NOT_ASKED) return { kind: "failed", code: null };
  return stepFailureOf(said);
}

/**
 * What is drawn where a card would have been.
 *
 * The person's words for why, where the fact is one of a card's own — switched off for this Bot,
 * no such card, a data source it was not allowed (`REFUSAL_SAID`). Anything else — the turn was
 * stopped first, nothing answered — is a line that says the card's name and that it did not work,
 * as any step's does. Never the model's sentence, and never the card.
 */
export function CardNotShown({
  title,
  ending,
}: {
  title: string;
  ending: StepFailure;
}) {
  const code = ending.kind === "error" ? null : ending.code;
  const why = code ? REFUSAL_SAID[code] : undefined;
  if (why) return <RefusedCard reason={t(why)} title={title} />;
  const words = code ? OUTCOME_LABELS[code] : undefined;
  return (
    <ToolLine
      detail={words ? t(words) : undefined}
      failed={ending.kind !== "refused"}
      kind="drawing"
      label={title}
      refused={ending.kind === "refused"}
    />
  );
}
