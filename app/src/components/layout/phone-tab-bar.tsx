import {
  IconBulb,
  IconLayoutGrid,
  IconLayoutList,
  IconMenu2,
  IconMessageCircle,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { usePresence } from "@/components/channels/use-presence";
import { focusRing } from "@/components/ui/focus";
import { conversationOf, primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";
import { useIsKeyboardUp } from "@/lib/use-keyboard-up";
import { cn } from "@/lib/utils";

/**
 * THE PHONE'S WAY AROUND: 대화 · 소식 · 메뉴, AT THE BOTTOM, WITH THEIR NAMES (muse-shape plan §4,
 * phase 3, 2026-09-27).
 *
 * Below `md` there is no sidebar column, and until now the way to anything else was a menu button in
 * each screen's header that slid the whole column over the page — one more press to reach anything,
 * from the top corner a thumb reaches last. The bar holds only the places that exist: the one
 * conversation, 소식 (오늘, as a page of its own), and 메뉴 (everything that changes how the Bot
 * works). More tabs come with the pages behind them, never before: 아이디어 came with its page
 * (phase 5), third, where the plan puts it; 만든 것 (phase 6) before 메뉴, with 목표's place
 * between them kept for phase 9.
 *
 * LABELLED, because five unlabelled icons were the rail nobody could name (UI/UX audit 0.5.3, item
 * 20). Each is the bar's full 56px tall, over the home indicator's inset.
 *
 * AWAY WHILE THE KEYBOARD IS UP (`use-keyboard-up.ts`), so it never sits stacked between the box
 * being typed in and the keys.
 *
 * NEVER ON THE PC APP, whose window is never narrower than 1024: `md:hidden`.
 */
export function PhoneTabBar() {
  const mine = useMyBots();
  const channels = useQuery(channelListQueryOptions());
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const isKeyboardUp = useIsKeyboardUp();
  const bot = mine.bots ? primaryBot(mine.bots, channels.data) : undefined;
  const conversation = bot ? conversationOf(bot.id, channels.data) : undefined;

  const isConversation = pathname === "/" || pathname.startsWith("/channel");
  const isUpdates = pathname === "/feed";
  const isIdeas = pathname === "/ideas";
  const isMade = pathname === "/made";
  const isMenu = !isConversation && !isUpdates && !isIdeas && !isMade;

  return (
    <nav
      aria-label={t("Places")}
      className="order-last shrink-0 border-border border-t bg-sidebar pb-[env(safe-area-inset-bottom)] md:hidden"
      hidden={isKeyboardUp}
      data-phone-tab-bar
    >
      <ul className="grid h-14 grid-cols-5">
        <li className="contents">
          <Tab
            badge={
              <ConversationMark
                botId={bot?.id}
                isUnread={conversation?.unread ?? false}
              />
            }
            icon={IconMessageCircle}
            isActive={isConversation}
            label={t("Conversation")}
            to="/"
          />
        </li>
        <li className="contents">
          <Tab
            icon={IconLayoutList}
            isActive={isUpdates}
            label={t("Updates")}
            to="/feed"
          />
        </li>
        <li className="contents">
          <Tab
            icon={IconBulb}
            isActive={isIdeas}
            label={t("Ideas")}
            to="/ideas"
          />
        </li>
        <li className="contents">
          <Tab
            icon={IconLayoutGrid}
            isActive={isMade}
            label={t("Made")}
            to="/made"
          />
        </li>
        <li className="contents">
          <Tab
            icon={IconMenu2}
            isActive={isMenu}
            label={t("Menu")}
            to="/menu"
          />
        </li>
      </ul>
    </nav>
  );
}

function Tab({
  badge,
  icon: Icon,
  isActive,
  label,
  to,
}: {
  badge?: ReactNode;
  icon: typeof IconMenu2;
  isActive: boolean;
  label: string;
  to: "/" | "/feed" | "/ideas" | "/made" | "/menu";
}) {
  return (
    <Link
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "flex h-full min-h-11 flex-col items-center justify-center gap-0.5 text-xs transition-colors",
        isActive ? "font-medium text-foreground" : "text-muted-foreground",
        focusRing,
      )}
      to={to}
    >
      <span className="relative">
        <Icon aria-hidden="true" className="size-5.5" />
        {badge}
      </span>
      {label}
    </Link>
  );
}

/**
 * The conversation's mark: a dot when there is something unread, amber when the Bot is waiting on
 * the person — an approval, a sign-in — which is the one thing on the bar that asks for them.
 */
function ConversationMark({
  botId,
  isUnread,
}: {
  botId: string | undefined;
  isUnread: boolean;
}) {
  const presence = usePresence(botId);
  const isWaiting = presence.tone === "attention";
  if (!isWaiting && !isUnread) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "-top-0.5 -right-1 absolute size-2 rounded-full ring-2 ring-sidebar",
          isWaiting ? "bg-warning" : "bg-mark",
        )}
        data-mark={isWaiting ? "waiting" : "unread"}
      />
      <span className="sr-only">
        {isWaiting ? t("Waiting on the owner") : t("Unread")}
      </span>
    </>
  );
}
