import { Mascot, mascotBackground } from "@/components/agents/mascot";
import type { AgentProfile } from "@/lib/agents/queries";
import { t } from "@/lib/i18n";

/**
 * A Bot as a card: the face above, the words below, nothing on top of either.
 *
 * The earlier tile laid the name over the character on a black wash, which put the two things a
 * person came to read in each other's way. This is the desktop app's grammar instead — a card
 * surface, a hairline, depth from the background step rather than a shadow — with the face's own
 * ground carrying the only colour on the card.
 */
export function AgentCard({
  agent,
  status,
}: {
  agent: AgentProfile;
  /** What it is doing right now, when it is doing something. */
  status?: string;
}) {
  /*
   * A NEW BOT HAS NO ROLE, AND THE SECOND LINE WAS SIMPLY BLANK.
   *
   * Every Bot is now made in one press with nothing set, so the ordinary card is the one with no
   * description — and it drew a name over an empty line, which reads as a Bot that failed to load
   * rather than one that has not been given a job. The line says what to do about it instead.
   */
  const line = agent.roleDescription || agent.title;

  return (
    /*
     * FULL WIDTH, NOT 144px. The card used to set its own width, which held as long as its grid gave
     * every column at least that much — and the roster's grid is a fixed four columns, so opening
     * the profile panel beside it took each column below 144px and the cards grew out of their cells
     * and over each other. The grid now sizes its columns and the card fills the one it is given.
     */
    <div className="group w-full overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-ring/40">
      <div
        className="flex aspect-square items-center justify-center overflow-hidden"
        style={{ background: mascotBackground(agent.avatarSeed) }}
      >
        <Mascot
          className="size-full transition-transform duration-200 group-hover:scale-[1.04]"
          seed={agent.avatarSeed}
          size={144}
        />
      </div>
      <div className="flex flex-col gap-0.5 p-3">
        <span className="line-clamp-1 font-medium text-[13px]">
          {agent.name}
        </span>
        {status ? (
          /* A dot, because a Bot that is working is the one thing on this card worth a colour. */
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
            <span className="line-clamp-1">{status}</span>
          </span>
        ) : (
          <span
            className={`line-clamp-2 text-[12px] leading-snug ${line ? "text-muted-foreground" : "text-muted-foreground/70"}`}
          >
            {line || t("Decide what it does by talking to it.")}
          </span>
        )}
      </div>
    </div>
  );
}
