import { Mascot, mascotFor } from "@/components/agents/mascot";
import type { AgentProfile } from "@/lib/agents/queries";

/**
 * A Bot as a tile.
 *
 * The face is the tile, at full strength. The earlier card blew a generated avatar up to 250 and
 * washed it out to 40% behind the words, which is the right treatment for a gradient nobody chose and
 * the wrong one for a drawing: it would be hiding the only thing on the card worth looking at. The
 * words go in a band beneath it instead.
 */
export function AgentCard({ agent }: { agent: AgentProfile }) {
  const tile = mascotFor(agent.avatarSeed);

  return (
    <div
      className="relative h-[180px] w-[144px] overflow-hidden rounded-2xl"
      style={{ background: tile.background }}
    >
      <Mascot
        className="absolute top-0 left-0 w-full"
        seed={agent.avatarSeed}
        size={144}
      />
      <div className="absolute inset-x-0 bottom-0 flex h-[68px] flex-col gap-1 bg-black/40 p-3">
        <span className="line-clamp-1 font-medium text-sm text-white">
          {agent.name}
        </span>
        <span className="line-clamp-2 text-white/80 text-xs leading-snug">
          {agent.roleDescription}
        </span>
      </div>
    </div>
  );
}
