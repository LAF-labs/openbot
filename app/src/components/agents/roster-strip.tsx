import { BotAvatar } from "@/components/avatar/bot-avatar";
import { focusRing } from "@/components/ui/focus";
import { useNewBot } from "@/lib/agents/new-bot";
import type { AgentProfile } from "@/lib/agents/queries";
import { seatsFullMessage } from "@/lib/agents/seats";
import { t } from "@/lib/i18n";

/**
 * The team, as faces you can point at.
 *
 * Home and the compose screen both ask the same question — which colleague is this for — and both
 * answered it differently: Home drew a row of faces, and compose drew a combobox over an empty
 * white page. One question deserves one control, and a roster of at most a handful of characters is
 * better pointed at than typed into.
 *
 * Selection is the caller's, because the two screens do different things with it: Home aims its
 * composer, compose puts the choice in the URL.
 */
export function RosterStrip({
  roster,
  selectedId,
  selectedIds,
  onSelect,
}: {
  roster: readonly AgentProfile[];
  selectedId: string | undefined;
  /**
   * Several chosen at once, for a screen that is building a room rather than picking one colleague.
   *
   * Additive, and it wins over `selectedId` when given: the compose screen can hold up to eight
   * recipients and had no way to show more than one of them as chosen, which is why it grew a
   * second picker beside this one. Home still asks the single-answer question and passes neither.
   */
  selectedIds?: readonly string[];
  onSelect: (agentId: string) => void;
}) {
  const newBot = useNewBot();
  return (
    // Wraps within the composer's measure: a team of a dozen ran off the right of the screen.
    <div className="flex max-w-2xl flex-wrap items-start justify-center gap-1">
      {roster.map((agent) => {
        const chosen = selectedIds
          ? selectedIds.includes(agent.id)
          : agent.id === selectedId;
        return (
          <button
            aria-pressed={chosen}
            className={`group flex w-[76px] flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-accent ${focusRing}`}
            key={agent.id}
            onClick={() => onSelect(agent.id)}
            type="button"
          >
            {/*
             * The ring is a circle around a face that is no longer a circle, so it is drawn on a
             * ground rather than on the drawing: the face keeps its own silhouette inside it.
             */}
            <span
              className={
                "inline-flex size-12 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-all duration-150 group-hover:scale-105" +
                (chosen ? " ring-2 ring-primary" : " ring-1 ring-border")
              }
            >
              <BotAvatar
                className="size-full"
                seed={agent.avatarSeed}
                size={48}
              />
            </span>
            <span
              className={
                "max-w-full truncate text-xs leading-tight" +
                (chosen ? " font-medium" : " text-muted-foreground")
              }
            >
              {agent.name}
            </span>
          </button>
        );
      })}
      {/*
       * IT MAKES THE BOT. It used to link to a form; the form is gone, and this is the same press
       * every other 새 봇 is — a Bot named, given a face, and its conversation opened.
       *
       * The reason is on `title` here and nowhere else on screen, because this tile is one of a row
       * of faces inside a composer: a sentence under it would push the message box down the page.
       * The roster says it in full, which is where somebody goes to do something about it.
       */}
      <button
        className={`group flex w-[76px] flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-accent disabled:opacity-50 ${focusRing}`}
        disabled={newBot.isPending || newBot.seats.isFull}
        onClick={() => void newBot.create()}
        title={newBot.seats.isFull ? seatsFullMessage(newBot.seats) : undefined}
        type="button"
      >
        <span className="inline-flex size-12 items-center justify-center rounded-full border border-border border-dashed text-[20px] text-muted-foreground transition-transform duration-150 group-hover:scale-105">
          +
        </span>
        <span className="max-w-full truncate text-xs text-muted-foreground leading-tight">
          {newBot.isPending ? t("Creating…") : t("New Bot")}
        </span>
      </button>
    </div>
  );
}
