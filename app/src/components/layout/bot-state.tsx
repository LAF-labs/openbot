import { useQuery } from "@tanstack/react-query";
import { usePresence } from "@/components/channels/use-presence";
import { primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";

/**
 * WHAT THE BOT IS DOING, SAID IN THE ROW AT THE TOP TO WHOEVER CANNOT SEE THE REST OF THE SCREEN.
 *
 * The row's left is empty to the eye (the user, 2026-10-09: as Hark's is). The Bot's name and a
 * dot for its state stood there for a day, and before that at the top of the sidebar on every
 * screen. What a sighted person is left with is the amber dot on the profile button when the Bot
 * waits on them, and 오늘 in the home panel.
 *
 * A screen reader has neither at a glance, so the name and the state stay in the document, in the
 * place they were, not drawn: one line, read when somebody moves to it and never announced by
 * itself — the cards that ask for a person announce themselves where they are.
 *
 * `data-bot-state` carries the state's word alone, for a test to read without parsing a sentence.
 *
 * ON A SCREEN THAT IS NOT THE CONVERSATION, for the Bot the home opens on; the conversation says
 * its own Bot's (`bot-header.tsx`).
 */
export function BotState() {
  const mine = useMyBots();
  const channels = useQuery(channelListQueryOptions());
  const bot = mine.bots ? primaryBot(mine.bots, channels.data) : undefined;
  const presence = usePresence(bot?.id);
  if (!bot) return null;

  const word = t(presence.label);
  return (
    <p className="sr-only" data-bot-state={word}>
      {bot.name} · {word}
    </p>
  );
}
