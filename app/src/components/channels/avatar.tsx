import { useQuery } from "@tanstack/react-query";
import { memo } from "react";
import { Mascot } from "@/components/agents/mascot";
import { agentListQueryOptions } from "@/lib/agents/queries";

/**
 * Memoized roster avatar. Row updates usually change preview/timestamp only, and
 * `use-channel-events` preserves participant id arrays for unchanged rows.
 *
 * `size-full` opts the generated SVG out of ancestor icon selectors such as
 * `[&_svg:not([class*='size-'])]:size-4`.
 */
/**
 * An agent id, resolved to the face that agent actually wears.
 *
 * A channel row knows who is in it and nothing else about them, so hashing the id straight to a tile
 * would give the same Bot one face in the sidebar and another on its profile — the same Bot, twice,
 * and no way for anybody to know which one is the real one. The roster is already loaded and cached
 * for the page this appears on, so the seed comes from there; before it arrives, or for an id that is
 * not a Bot, the id hashes as it always did and the face settles a moment later.
 */
function useSeeds(): (agentId: string) => string | undefined {
  const agents = useQuery(agentListQueryOptions());
  return (agentId) => {
    /*
     * UNDEFINED WHILE THE ROSTER IS IN FLIGHT, NOT A GUESS. Falling back to hashing the id gave a
     * real, wrong face — every avatar in the app drew somebody else's character for a moment and
     * then swapped. A Bot's face is how people recognise it here; showing the wrong one, however
     * briefly, is worse than showing none.
     */
    if (!agents.data) return undefined;
    return agents.data.find((agent) => agent.id === agentId)?.avatarSeed ?? agentId;
  };
}

/**
 * An agent id, resolved to what that agent is called.
 *
 * Same roster, same cache, same reason as the seed above: a row holds ids, and a person reads names.
 * Undefined until the roster lands, and for an id that is no longer a Bot — callers are expected to
 * have something to say in that case rather than showing a raw id.
 */
export function useAgentNames(): (agentId: string) => string | undefined {
  const agents = useQuery(agentListQueryOptions());
  return (agentId) => agents.data?.find((agent) => agent.id === agentId)?.name;
}

export const ChannelAvatar = memo(function ChannelAvatar({
  participantIds,
  size = 32,
}: {
  participantIds: string[];
  size?: number;
}) {
  const seedOf = useSeeds();
  const channelSize = participantIds?.length;

  if (channelSize === 1) {
    const seed = seedOf(participantIds[0] ?? "");
    return (
      <div style={{ height: size, width: size }}>
        {seed === undefined ? (
          // A neutral disc holds the space until the roster says whose face belongs here.
          <div className="size-full rounded-full bg-muted" />
        ) : (
          <Mascot
            className="size-full rounded-full object-cover"
            seed={seed}
            size={size}
          />
        )}
      </div>
    );
  }

  const firstThree = participantIds.slice(0, 3);

  return (
    <div
      className="flex flex-row items-center"
      style={{ height: size, width: size }}
    >
      {firstThree.map((c, i) => {
        const seed = seedOf(c);
        const tile = size / (firstThree.length / 2);
        return (
          <div
            key={c}
            className="shrink-0 border-2 border-sidebar rounded-full flex items-center justify-center"
            style={{
              height: tile,
              width: tile,
              transform: `translateX(${i * -75}%)`,
            }}
          >
            {seed === undefined ? (
              <div className="size-full rounded-full bg-muted" />
            ) : (
              <Mascot
                className="size-full rounded-full object-cover"
                seed={seed}
                size={tile}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});
