import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { conversationOf, primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/_app/")({
  component: RouteComponent,
});

/**
 * HOME IS THE CONVERSATION WITH THE BOT (2026-09-24).
 *
 * Home was a greeting over a row of faces and a box that asked which of them to send to, with `@`
 * to reach another or two for a room. A person has one Bot now and everything happens by talking
 * to it, so the first screen is that conversation: this resolves which one and goes there. A Bot
 * that has never been spoken to has no channel yet and opens on the compose screen, which makes
 * the channel with the first message.
 *
 * A person with no Bot at all — the only way is deleting the one they had — is sent to make one.
 */
function RouteComponent() {
  const mine = useMyBots();
  const channels = useQuery(channelListQueryOptions());

  if (mine.isError) {
    return (
      <div className="flex w-full flex-1 flex-col items-center justify-center gap-3 p-4">
        <p className="text-[13px] text-destructive" role="alert">
          {t("Your Bot could not be loaded.")}
        </p>
        <Button onClick={() => mine.refetch()} size="sm" variant="outline">
          {t("Try again")}
        </Button>
      </div>
    );
  }

  /*
   * The conversations are waited for too, unless they failed: a Bot that HAS a conversation must
   * open on it rather than on an empty compose screen that would look like the history was gone.
   */
  if (!mine.bots || (channels.isPending && !channels.isError)) {
    return (
      <div aria-hidden className="flex w-full flex-1 flex-col gap-3 p-6">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-16 w-2/3" />
      </div>
    );
  }

  const bot = primaryBot(mine.bots, channels.data);
  if (!bot) return <Navigate replace to="/welcome" />;

  const conversation = conversationOf(bot.id, channels.data);
  return conversation ? (
    <Navigate
      params={{ channelId: conversation.id }}
      replace
      to="/channel/$channelId"
    />
  ) : (
    <Navigate replace search={{ agent: bot.id }} to="/channel/new" />
  );
}
