import { useQuery } from "@tanstack/react-query";
import { memo } from "react";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { agentListQueryOptions } from "@/lib/agents/queries";

/**
 * An agent id, resolved to the face that agent actually wears.
 *
 * A conversation knows who is in it and nothing else about them, so hashing the id straight to a
 * face would give the same Bot one face here and another on its profile. The roster is already
 * loaded and cached for the page this appears on, so the seed comes from there.
 *
 * TWO ROSTERS, THEN THE ID. A Bot hidden from the old roster is not in the visible list, and a Bot
 * that was deleted is in neither — so the hidden roster is asked as well, and an id in neither falls
 * back to hashing the id itself, which is a stable face rather than an absence.
 *
 * It drew a stack of faces for a room until rooms were removed on 2026-09-24.
 */
function useSeed(agentId: string | undefined): string | undefined {
  const agents = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  /*
   * UNDEFINED WHILE THE ROSTER IS IN FLIGHT, NOT A GUESS. Falling back to hashing the id gave a
   * real, wrong face for a moment and then swapped — worse than showing none.
   */
  if (!agentId || !agents.data) return undefined;
  const visible = agents.data.find((agent) => agent.id === agentId);
  if (visible) return visible.avatarSeed;
  const wasHidden = hidden.data?.find((agent) => agent.id === agentId);
  if (wasHidden) return wasHidden.avatarSeed;
  // Pending is worth waiting through; an error is an answer, and the answer is "ask the id".
  if (hidden.isPending) return undefined;
  return agentId;
}

export const AgentAvatar = memo(function AgentAvatar({
  agentId,
  size = 32,
}: {
  agentId: string | undefined;
  size?: number;
}) {
  const seed = useSeed(agentId);
  return seed === undefined ? (
    // A neutral disc holds the space until the roster says whose face belongs here.
    <div
      className="shrink-0 rounded-full bg-muted"
      style={{ height: size, width: size }}
    />
  ) : (
    <BotAvatar seed={seed} size={size} />
  );
});
