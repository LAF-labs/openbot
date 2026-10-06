import {
  IconBulb,
  IconLayoutGrid,
  IconLayoutList,
  IconMenu2,
  IconMessageCircle,
  IconTarget,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { usePresence } from "@/components/channels/use-presence";
import { UpdateNotice } from "@/components/layout/update-notice";
import { focusRing } from "@/components/ui/focus";
import { conversationOf, primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { feedUnseenQueryOptions } from "@/lib/feed/queries";
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
 * (phase 5), third, where the plan puts it; 만든 것 (phase 6) before 메뉴, and 목표 (phase 9) between
 * 아이디어 and 만든 것 — six, the plan's whole bar. At 375 each is 62px wide, and the longest label
 * (아이디어, 만든 것) fits on one line.
 *
 * LABELLED, because five unlabelled icons were the rail nobody could name (UI/UX audit 0.5.3, item
 * 20). Each is the bar's full 56px tall, over the home indicator's inset.
 *
 * AWAY WHILE THE KEYBOARD IS UP (`use-keyboard-up.ts`), so it never sits stacked between the box
 * being typed in and the keys.
 *
 * A NEWER VERSION IS SAID HERE, ON A ROW OVER THE TABS (`update-notice.tsx`), since 2026-10-06: a
 * phone has no column whose foot could hold it, and the bar is the phone's. Part of the bar, so it
 * is laid out under the screen rather than over it, and goes away with the bar while the keyboard
 * is up. Nothing is drawn while there is none.
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
  const isGoals = pathname === "/goals";
  const isMade = pathname === "/made";
  const isMenu =
    !isConversation && !isUpdates && !isIdeas && !isGoals && !isMade;

  return (
    <nav
      aria-label={t("Places")}
      className="order-last shrink-0 border-border border-t bg-sidebar pb-[env(safe-area-inset-bottom)] md:hidden"
      hidden={isKeyboardUp}
      data-phone-tab-bar
    >
      <UpdateNotice className="border-border border-b px-2 py-1" shape="row" />
      <ul className="grid h-14 grid-cols-6">
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
            badge={<UpdatesMark />}
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
            icon={IconTarget}
            isActive={isGoals}
            label={t("Goals")}
            to="/goals"
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
  to: "/" | "/feed" | "/ideas" | "/goals" | "/made" | "/menu";
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

/** 소식's unseen count, on its tab (phase 7). Nothing at zero. */
function UpdatesMark() {
  const unseen = useQuery(feedUnseenQueryOptions());
  const count = unseen.data ?? 0;
  if (count <= 0) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className="-top-1 -right-2.5 absolute min-w-4 rounded-full bg-mark px-1 text-center font-medium text-white text-xs leading-4 ring-2 ring-sidebar"
        data-mark="unseen"
      >
        {count}
      </span>
      <span className="sr-only">{t("{count} new", { count })}</span>
    </>
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
