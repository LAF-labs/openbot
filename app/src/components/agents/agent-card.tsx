import Avatar from "boring-avatars";
import {
  hasMascot,
  Mascot,
  mascotBackground,
} from "@/components/agents/mascot";
import type { AgentProfile } from "@/lib/agents/queries";

/**
 * A Bot as a tile.
 *
 * The generated avatar is blown up to 250 and washed out behind the text, which turns it into a soft
 * field of colour — the right treatment for a drawing nobody chose. A drawn Bot is not that: it has a
 * face, and hiding it behind a 40% wash would be drawing it for nothing. Those tiles carry their own
 * ground at full strength and put the words on a scrim instead.
 */
export function AgentCard({ agent }: { agent: AgentProfile }) {
  const drawn = hasMascot(agent.avatarSeed);

  if (drawn) {
    return (
      <div
        className="relative h-[180px] w-[144px] overflow-hidden rounded-2xl"
        style={{ background: mascotBackground(agent.avatarSeed) }}
      >
        {/* As wide as the tile, so the creature runs off its sides the way the brief asks. */}
        <Mascot
          className="-translate-x-1/2 absolute top-0 left-1/2"
          mascotKey={agent.avatarSeed}
          size={144}
        />
        {/* A band rather than a scrim over the face: a drawn Bot is not a background. */}
        <div className="absolute inset-x-0 bottom-0 flex h-[68px] flex-col gap-1 bg-black/35 p-3">
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

  return (
    <div className="h-[180px] bg-foreground/10 rounded-2xl w-[144px] relative overflow-hidden">
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <Avatar name={agent.avatarSeed} size={250} />
      </div>
      <div className="absolute top-0 left-0 w-full h-full bg-background/40 dark:bg-background/50" />
      <div className="absolute top-0 left-0 w-full h-full flex flex-col justify-end p-3 gap-2">
        <span className="text-sm font-medium line-clamp-1">{agent.name}</span>
        <span className="text-xs text-foreground dark:text-foreground/80 line-clamp-3">
          {agent.roleDescription}
        </span>
      </div>
    </div>
  );
}
