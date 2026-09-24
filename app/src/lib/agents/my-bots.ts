import { useQuery } from "@tanstack/react-query";
import type { ChannelSummary } from "@/lib/channels/queries";
import { type Reading, useReading } from "@/lib/reading";
import { type AgentProfile, agentListQueryOptions } from "./queries";

/**
 * THE PERSON'S BOT — and, on an account from before 2026-09-24, their Bots.
 *
 * A person has one Bot (docs/laf/deployment-model.md, "봇은 하나다"). The server refuses a second,
 * but an account that already had several keeps every one of them, and nothing here may lose one:
 * so this reads both lists the server answers — the roster and the ones hidden from it, a sidebar
 * preference from when there was a roster to tidy — and puts them back together. A Bot somebody hid
 * in August is still their Bot.
 *
 * `mine` and not `canManage`: an administrator can manage somebody else's Bot on a deployment that
 * still has a leftover account, and that Bot is not this person's conversation.
 */
export type MyBots = {
  /** Undefined until the roster has answered. Hidden ones after the rest, each in server order. */
  bots: AgentProfile[] | undefined;
  /** The one judgement a screen should draw from (`lib/reading.ts`); `empty` is a person with none. */
  reading: Reading<AgentProfile[]>;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
};

export function mineOf(
  visible: readonly AgentProfile[] | undefined,
  hidden: readonly AgentProfile[] | undefined,
): AgentProfile[] | undefined {
  if (!visible) return undefined;
  const seen = new Set<string>();
  const bots: AgentProfile[] = [];
  for (const agent of [...visible, ...(hidden ?? [])]) {
    if (!agent.mine || seen.has(agent.id)) continue;
    seen.add(agent.id);
    bots.push(agent);
  }
  return bots;
}

export function useMyBots(): MyBots {
  const visible = useQuery(agentListQueryOptions());
  /*
   * WAITED FOR, then best-effort. Waited for, because a person whose one Bot was hidden would
   * otherwise read as having none for the moment the second list is in flight — and "none" sends
   * them to make a Bot they already have. Best-effort after that, like every other reader of the
   * hidden list: one that failed to load is an answer, and the visible roster is used without it.
   */
  const hidden = useQuery(agentListQueryOptions(true));
  const settled = visible.data !== undefined && !hidden.isPending;
  const bots = settled ? mineOf(visible.data, hidden.data) : undefined;
  /*
   * THE SAME FACTS, READ THE ONE WAY (`lib/reading.ts`). `isError` above is TanStack's, and it is
   * true after a refresh fails over a roster already read — the Bot's profile page drew "could not
   * be loaded" in place of a profile it had on screen, offered 다시 시도 to a session that had been
   * signed out, and pulsed a skeleton all afternoon on a first read parked offline. The roster's
   * status stands for both lists: the hidden one is waited for, then taken as best-effort.
   */
  const reading = useReading<AgentProfile[]>({
    status:
      visible.status === "error"
        ? "error"
        : bots === undefined
          ? "pending"
          : "success",
    fetchStatus: visible.fetchStatus,
    data: bots,
    error: visible.error,
  });
  return {
    bots,
    reading,
    isPending: !settled && !visible.isError,
    isError: visible.isError,
    refetch: () => {
      void visible.refetch();
      void hidden.refetch();
    },
  };
}

/**
 * Which Bot the app opens on.
 *
 * With one Bot, that one. With several — only ever an account from before the cap came down — the
 * one somebody spoke with last, so opening the app lands where they left off rather than on
 * whichever Bot happens to sort first; a Bot nobody has spoken with yet comes after all of those.
 */
export function primaryBot(
  bots: readonly AgentProfile[],
  channels: readonly ChannelSummary[] | undefined,
): AgentProfile | undefined {
  if (bots.length <= 1 || !channels) return bots[0];
  const lastSpoken = new Map<string, string>();
  for (const channel of channels) {
    if (channel.agentIds.length !== 1) continue;
    const agentId = channel.agentIds[0] as string;
    const at = channel.lastMessageAt ?? channel.createdAt;
    const previous = lastSpoken.get(agentId);
    if (!previous || at > previous) lastSpoken.set(agentId, at);
  }
  return [...bots].sort((a, b) => {
    const atA = lastSpoken.get(a.id);
    const atB = lastSpoken.get(b.id);
    if (atA && atB) return atB.localeCompare(atA);
    if (atA) return -1;
    if (atB) return 1;
    return 0;
  })[0];
}

/**
 * A Bot's conversation: the OLDEST one-Bot channel it has, which is the rule the server's `create`
 * resolves to (`channels/conversations.ts`). Undefined before its first message.
 */
export function conversationOf(
  agentId: string,
  channels: readonly ChannelSummary[] | undefined,
): ChannelSummary | undefined {
  let oldest: ChannelSummary | undefined;
  for (const channel of channels ?? []) {
    if (channel.agentIds.length !== 1 || channel.agentIds[0] !== agentId) {
      continue;
    }
    if (!oldest || channel.createdAt < oldest.createdAt) oldest = channel;
  }
  return oldest;
}
