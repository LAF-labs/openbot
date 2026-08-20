import { Mascot, mascotBackground } from "@/components/agents/mascot";
import type { AgentProfile } from "@/lib/agents/queries";

/**
 * A Bot as a card: the face above, the words below, nothing on top of either.
 *
 * The earlier tile laid the name over the character on a black wash, which put the two things a
 * person came to read in each other's way. This is the desktop app's grammar instead — a card
 * surface, a hairline, depth from the background step rather than a shadow — with the face's own
 * ground carrying the only colour on the card.
 */
export function AgentCard({ agent }: { agent: AgentProfile }) {
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
        <span className="line-clamp-2 text-[12px] text-muted-foreground leading-snug">
          {agent.roleDescription}
        </span>
      </div>
    </div>
  );
}
