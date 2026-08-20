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
    <div className="group w-[144px] overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-ring/40">
      <div
        className="flex items-center justify-center overflow-hidden"
        style={{ background: mascotBackground(agent.avatarSeed) }}
      >
        <Mascot
          className="w-full transition-transform duration-200 group-hover:scale-[1.04]"
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
