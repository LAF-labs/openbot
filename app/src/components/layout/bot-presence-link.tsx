import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  DOT_TONES,
  PILL_CLASS,
  PILL_TONES,
} from "@/components/channels/bot-header";
import { usePresence } from "@/components/channels/use-presence";
import { focusRing } from "@/components/ui/focus";
import { conversationOf, useMyBots } from "@/lib/agents/my-bots";
import type { AgentProfile } from "@/lib/agents/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";
import { settledOf, useReading } from "@/lib/reading";
import { cn } from "@/lib/utils";

/**
 * THE BOT, AT THE LEFT OF THE TOP ROW ON EVERY SCREEN THAT IS NOT ITS CONVERSATION (2026-10-10,
 * record §1, piece 3-1): its name, and what it is doing beside it.
 *
 * The column that stood at the left of the window said this on every screen, and it is the one
 * thing of the column's a menu cannot say: a menu is closed. A person reading 소식 while the Bot
 * stops on a question has to be told there, not the next time they happen to open a list — so the
 * name and its state stay in sight, in the row that is always there (`app-top-bar.tsx`). On the
 * conversation itself the same place holds the conversation's own header, which says the same.
 *
 * A DOT, AND ONE WORD. What the Bot is doing is a dot beside the name; the word is the dot's name
 * and title, and the link's own name, for whoever cannot see a dot. ONE WORD IS STILL DRAWN: when
 * the Bot is waiting on the person the amber pill stays, with 확인 필요 or 도움 필요 in it, because
 * that is the one state that asks them for something, and a dot changing colour at the edge of
 * what somebody is reading is not them being asked (the column's rule since 2026-10-04).
 *
 * IT LEADS TO THE CONVERSATION, where the card that is waiting is. The column's row led to the
 * Bot's profile, with the conversation a row below it; here there is one place to press, and
 * what somebody who sees 확인 필요 wants is the question. The profile is a button on the
 * conversation's header, as it was.
 *
 * ONLY WHERE THERE IS ONE BOT. An account from before the cap has several, and whose state would
 * stand here is not a question with an answer: each is in the menu, with its own mark.
 */
export function BotPresenceLink() {
  const mine = useMyBots();
  const channels = useQuery(channelListQueryOptions());
  const channelList = settledOf(useReading(channels))?.data;
  const bots = mine.bots ?? [];
  const [only] = bots;
  if (bots.length !== 1 || !only) return null;
  return (
    <PresenceOf
      agent={only}
      channelId={conversationOf(only.id, channelList)?.id}
    />
  );
}

function PresenceOf({
  agent,
  channelId,
}: {
  agent: AgentProfile;
  channelId: string | undefined;
}) {
  const presence = usePresence(agent.id);
  const word = t(presence.label);
  const isAsking = presence.tone === "attention";
  const destination = channelId
    ? ({ params: { channelId }, to: "/channel/$channelId" } as const)
    : ({ search: { agent: agent.id }, to: "/channel/new" } as const);

  return (
    <Link
      aria-label={`${agent.name} · ${word}. ${t("Conversation")}`}
      className={cn(
        "flex h-8 min-w-0 shrink items-center gap-1.5 rounded-lg px-2 transition-colors hover:bg-accent",
        focusRing,
      )}
      data-bot-presence
      {...destination}
    >
      <span className="min-w-0 truncate font-semibold text-sm">
        {agent.name}
      </span>
      {isAsking ? (
        <span
          className={cn(PILL_CLASS, PILL_TONES.attention, "shrink-0")}
          data-presence="attention"
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              DOT_TONES.attention,
            )}
          />
          <span className="truncate">{word}</span>
        </span>
      ) : (
        <span
          aria-label={word}
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            DOT_TONES[presence.tone],
          )}
          data-presence={presence.tone}
          role="img"
          title={word}
        />
      )}
    </Link>
  );
}
