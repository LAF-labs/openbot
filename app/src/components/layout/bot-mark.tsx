import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  PresencePillBody,
  presenceClass,
} from "@/components/channels/bot-header";
import { usePresence } from "@/components/channels/use-presence";
import { focusRing } from "@/components/ui/focus";
import { primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * THE BOT, IN THE ROW AT THE TOP OF A SCREEN THAT IS NOT ITS CONVERSATION.
 *
 * The sidebar said who the Bot was and what it was doing on every screen: on 소식 or 만든 것, the
 * amber pill beside its name was the one thing in the window that said it was waiting on the
 * person. The sidebar went on 2026-10-09 and that did not stop being needed, so the name and the
 * state stand here, where the conversation draws its own on its own screen (`bot-header.tsx`): the
 * same two things in the same place, whichever screen is open.
 *
 * IT GOES TO THE CONVERSATION. The sidebar's went to the profile, because the conversation had a
 * row of its own under it. What somebody reading "확인이 필요해요" wants is the card that asks, and
 * that is in the conversation; the profile is a row of the menu.
 *
 * ONE BOT. An account from before the cap sees the Bot its home opens on (`primaryBot`); the others
 * are in the menu's 내 봇들, with their unread marks.
 */
export function BotMark() {
  const mine = useMyBots();
  const channels = useQuery(channelListQueryOptions());
  const bot = mine.bots ? primaryBot(mine.bots, channels.data) : undefined;
  const presence = usePresence(bot?.id);
  if (!bot) return null;

  const word = t(presence.label);
  return (
    <Link
      aria-label={`${bot.name} · ${word}. ${t("Conversation")}`}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-accent",
        focusRing,
      )}
      data-bot-mark
      to="/"
    >
      <span className="min-w-0 truncate font-semibold text-sm leading-5">
        {bot.name}
      </span>
      <span aria-hidden="true" className={presenceClass(presence)} title={word}>
        <PresencePillBody presence={presence} />
      </span>
    </Link>
  );
}
