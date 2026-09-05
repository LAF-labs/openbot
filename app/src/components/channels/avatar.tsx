import { useQuery } from "@tanstack/react-query";
import { memo } from "react";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { drawnFaceCount, stackedFaces } from "./avatar-stack";

/**
 * Memoized roster avatar. Row updates usually change preview/timestamp only, and
 * `use-channel-events` preserves participant id arrays for unchanged rows.
 */
/**
 * An agent id, resolved to the face that agent actually wears.
 *
 * A channel row knows who is in it and nothing else about them, so hashing the id straight to a
 * face would give the same Bot one face in the sidebar and another on its profile — the same Bot,
 * twice, and no way for anybody to know which one is the real one. The roster is already loaded and
 * cached for the page this appears on, so the seed comes from there.
 *
 * TWO ROSTERS, THEN THE ID. A member who has been hidden from the sidebar is not in the visible
 * list, and a member who has been deleted is in neither — and a group row is exactly where those
 * two turn up. Reading only the visible roster left them as a grey disc that never resolved: not a
 * face arriving late, a hole in the row for as long as the room existed. So the hidden roster is
 * asked as well (the sidebar has usually already fetched it), and an id in neither falls back to
 * hashing the id itself, which is a stable face rather than an absence.
 */
function useSeeds(): (agentId: string) => string | undefined {
  const agents = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  return (agentId) => {
    /*
     * UNDEFINED WHILE THE ROSTER IS IN FLIGHT, NOT A GUESS. Falling back to hashing the id gave a
     * real, wrong face — every avatar in the app drew somebody else's character for a moment and
     * then swapped. A Bot's face is how people recognise it here; showing the wrong one, however
     * briefly, is worse than showing none.
     */
    if (!agents.data) return undefined;
    const visible = agents.data.find((agent) => agent.id === agentId);
    if (visible) return visible.avatarSeed;

    const wasHidden = hidden.data?.find((agent) => agent.id === agentId);
    if (wasHidden) return wasHidden.avatarSeed;

    /*
     * THE HIDDEN ROSTER IS BEST-EFFORT, AND THAT IS THE POINT OF `isPending` RATHER THAN `data`.
     *
     * Waiting on `hidden.data` would mean that a hidden-roster request which FAILS — a blip, or a
     * deployment that answers `?hidden=true` differently — leaves every id it could not resolve as
     * a grey disc for the life of the page. Pending is the only state worth waiting through; error
     * is an answer, and the answer is "ask the id".
     */
    if (hidden.isPending) return undefined;
    return agentId;
  };
}

export const ChannelAvatar = memo(function ChannelAvatar({
  participantIds,
  size = 32,
  ringClassName = "ring-sidebar",
}: {
  participantIds: string[];
  size?: number;
  /**
   * The ground the gap between two overlapping faces is painted in.
   *
   * A ring rather than a border, and a PROP rather than a constant, because the ground this is
   * drawn on is not one colour: `--sidebar` is `#f7f7f7` and `--background` is `#fcfcfc`, so the
   * hard-coded `ring-sidebar` that used to be here drew a faintly darker halo around every face in
   * the room header. The sidebar is where the overwhelming majority of stacks appear, so it keeps
   * the default and the one screen that is not the sidebar says so.
   */
  ringClassName?: string;
}) {
  const seedOf = useSeeds();
  const channelSize = participantIds?.length;

  if (channelSize === 1) {
    const seed = seedOf(participantIds[0] ?? "");
    return seed === undefined ? (
      // A neutral disc holds the space until the roster says whose face belongs here.
      <div
        className="rounded-full bg-muted"
        style={{ height: size, width: size }}
      />
    ) : (
      <BotAvatar seed={seed} size={size} />
    );
  }

  const drawn = participantIds.slice(0, drawnFaceCount(channelSize ?? 0));
  const places = stackedFaces(drawn.length, size);

  /*
   * ABSOLUTE PLACEMENT, NOT A FLEX ROW PULLED BACK BY TRANSFORMS.
   *
   * The row laid the faces out end to end and then dragged each one left over the last, so the
   * box's width was never what the faces occupied and the last face's overhang escaped it. Every
   * face is now positioned from the box's own corner by `stackedFaces`, which cannot place one
   * outside — see `avatar-stack.ts` for the arithmetic that went wrong and `avatar-stack.test.ts`
   * for the invariant that now holds it.
   */
  return (
    <div className="relative shrink-0" style={{ height: size, width: size }}>
      {drawn.map((participantId, index) => {
        const seed = seedOf(participantId);
        const place = places[index];
        if (!place) return null;
        return (
          <div
            key={participantId}
            /*
             * A ring of the page's own ground between the discs. They overlap on purpose, and
             * without a gap of the ground colour two drawn characters read as one smudged blob.
             */
            className={`absolute flex items-center justify-center rounded-full ring-2 ${ringClassName}`}
            style={{
              height: place.diameter,
              left: place.left,
              top: place.top,
              width: place.diameter,
            }}
          >
            {seed === undefined ? (
              <div className="size-full rounded-full bg-muted" />
            ) : (
              <BotAvatar
                className="size-full"
                seed={seed}
                size={place.diameter}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});
