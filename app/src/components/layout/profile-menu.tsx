import {
  IconBulb,
  IconLayoutGrid,
  IconLayoutList,
  IconLogout,
  IconMessageCircle,
  IconPlayerStop,
  IconSettings,
  IconShieldLock,
  IconTarget,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { FOOTER_LINKS } from "@/components/app-sidebar/places";
import { StopAllDialog } from "@/components/app-sidebar/stop-all-dialog";
import { PersonAvatar } from "@/components/avatar/person-avatar";
import { usePresence } from "@/components/channels/use-presence";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { conversationOf, primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import type { ChannelSummary } from "@/lib/channels/queries";
import { feedUnseenQueryOptions } from "@/lib/feed/queries";
import { goalsQueryOptions } from "@/lib/goals/queries";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * EVERYWHERE THE SIDEBAR WENT, FROM ONE BUTTON AT THE TOP RIGHT (2026-10-09, the first piece of
 * `docs/laf/redesign-2026-10.md` §1 to land).
 *
 * The column is gone: its five rows — 대화 · 소식 · 아이디어 · 목표 · 만든 것 — and the list its
 * foot opened — 수첩 · 루틴 · 스킬 · 연결 · 도움말, then what is about the account — are one list
 * under the person's own picture. The record puts the button where it stays when the home panel is
 * folded away, so nothing a person navigates by depends on a panel being open.
 *
 * THE ORDER IS THE FOOT'S, WITH THE ROWS PUT IN FRONT OF IT. 모두 멈추기 first, because it is the
 * one item somebody reaches for in a hurry: a conversation and a routine can both be running, and
 * Stop lives inside one conversation at a time. Then where a person goes to look, then where they
 * go to change how the Bot works, then the account, and leaving last.
 *
 * 봇 프로필 IS A ROW FOR EVERYBODY HERE. The column drew it only for an account with several Bots,
 * because with one the Bot at the top of the column was the way to its profile (`places.ts`). That
 * face left with the column, so the row is the way now. The phone's 메뉴 page still has the face
 * and still leaves the row out.
 *
 * WHAT THE ROWS SAID WITHOUT BEING OPENED IS SAID ON THE BUTTON. The column showed an unread
 * conversation and 소식's count at a glance; a list behind a press shows nothing until it is
 * pressed. So the picture wears one dot — amber when the Bot is waiting on the person, the mark's
 * colour for something unread or unseen — and the rows inside carry what they carried.
 *
 * AN ACCOUNT FROM BEFORE THE CAP keeps every Bot it had (`deployment-model.md` "봇은 하나다"), and
 * the column's list was the only way between them. It is the first group here, for those accounts
 * only: 내 봇들, a row per Bot, each its own conversation. A row is the Bot's name and nothing
 * before it — a Bot has no face (2026-10-09) and, in a list of words, needs no mark standing in
 * for one. With one Bot there is no such group and 대화 is a row like the others.
 */

/** Where a person goes to look: an icon and the place's name, as the column drew them. */
const LOOK_ROWS = [
  { to: "/feed", icon: IconLayoutList, label: "Updates", row: "feed" },
  { to: "/ideas", icon: IconBulb, label: "Ideas", row: "ideas" },
  { to: "/goals", icon: IconTarget, label: "Goals", row: "goals" },
  { to: "/made", icon: IconLayoutGrid, label: "Made", row: "made" },
] as const;

const ITEM_CLASS = "gap-2 px-2 py-1.5";

/** A Bot's conversation, or the screen that starts one where nothing has been said yet. */
function conversationLink(agentId: string, channelId: string | undefined) {
  return channelId
    ? ({ params: { channelId }, to: "/channel/$channelId" } as const)
    : ({ search: { agent: agentId }, to: "/channel/new" } as const);
}

function UnreadMark() {
  return (
    <>
      <span
        aria-hidden="true"
        className="ml-auto size-2 shrink-0 rounded-full bg-mark"
        data-mark="unread"
      />
      <span className="sr-only">{t("Unread")}</span>
    </>
  );
}

/** 소식's count of posts not yet seen. Nothing drawn at zero or while it loads. */
function UnseenCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="ml-auto rounded-full bg-mark px-1.5 font-medium text-white text-xs leading-5"
      data-unseen-count
    >
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{t("{count} new", { count })}</span>
    </span>
  );
}

/** 목표's number: how many are in progress. Quiet — nothing here is new, it is what is worked on. */
function ActiveGoals() {
  const goals = useQuery(goalsQueryOptions());
  const count = goals.data?.active ?? 0;
  if (count <= 0) return null;
  return (
    <span
      className="ml-auto text-muted-foreground text-xs tabular-nums"
      data-active-goals
    >
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{t("{count} in progress", { count })}</span>
    </span>
  );
}

export function ProfileMenu({
  channels,
}: {
  /** The conversations as last read, or nothing while they could not be. */
  channels: readonly ChannelSummary[] | undefined;
}) {
  const mine = useMyBots();
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const unseen = useQuery(feedUnseenQueryOptions());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const [signOutError, setSignOutError] = useState<string | null>(null);
  /** `모두 멈추기`'s dialog. Outside the menu, which closes on the press that opens it. */
  const [stoppingAll, setStoppingAll] = useState(false);

  const bots = mine.bots ?? [];
  const isLegacy = bots.length > 1;
  const rows = bots.map((agent) => ({
    agent,
    channel: conversationOf(agent.id, channels),
  }));
  const main = mine.bots ? primaryBot(mine.bots, channels) : undefined;
  const mainChannel = main ? conversationOf(main.id, channels) : undefined;
  const presence = usePresence(main?.id);

  const unseenCount = unseen.data ?? 0;
  const isWaiting = presence.tone === "attention";
  const hasUnread = rows.some((row) => row.channel?.unread) || unseenCount > 0;

  const handleSignOut = async () => {
    setSignOutError(null);
    try {
      await signOut.mutateAsync();
    } catch {
      // The surface's own words, never what was thrown (`settings/index.tsx` says what that drew).
      setSignOutError(t("Could not log out."));
      return;
    }
    await navigate({ to: "/sign" });
  };

  /*
   * WHO IS SIGNED IN, as the button's name and title: the name and the address, whichever there
   * are. In two statements: joined and defaulted in one, the React Compiler left the whole
   * component uncompiled ("Unexpected terminal kind `optional` for logical test block").
   */
  const signedInAs = [currentUser?.name, currentUser?.email]
    .filter((part) => Boolean(part))
    .join(" · ");
  const accountName = signedInAs || t("Account");
  const menuName = `${t("Menu")} · ${accountName}`;

  return (
    <>
      {/* Outside the menu, which closes on click: an error inside it dies with the interaction. */}
      {signOutError ? (
        <p className="text-destructive text-xs" role="alert">
          {signOutError}
        </p>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={menuName}
              className="relative size-8 rounded-full p-0 hover:bg-accent"
              data-profile-menu
              title={menuName}
              variant="ghost"
            />
          }
        >
          {/* The person's own picture when the provider handed one over, which all three do. */}
          <PersonAvatar
            email={currentUser?.email}
            image={currentUser?.image}
            name={currentUser?.name}
            size="sm"
          />
          {isWaiting || hasUnread ? (
            <>
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-0 right-0 size-2 rounded-full ring-2 ring-background",
                  isWaiting ? "bg-warning" : "bg-mark",
                )}
                data-mark={isWaiting ? "waiting" : "unread"}
              />
              <span className="sr-only">
                {isWaiting ? t("Waiting on the owner") : t("Unread")}
              </span>
            </>
          ) : null}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52 p-1.5" side="bottom">
          <DropdownMenuItem
            className={ITEM_CLASS}
            onClick={() => setStoppingAll(true)}
          >
            <IconPlayerStop />
            {t("Stop everything")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {isLegacy ? (
            <>
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("Your Bots")}</DropdownMenuLabel>
                {rows.map(({ agent, channel }) => (
                  <DropdownMenuItem
                    className={ITEM_CLASS}
                    data-menu-bot={agent.id}
                    key={agent.id}
                    render={
                      <Link {...conversationLink(agent.id, channel?.id)} />
                    }
                  >
                    <span className="min-w-0 truncate">{agent.name}</span>
                    {channel?.unread ? <UnreadMark /> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {!isLegacy && main ? (
            <DropdownMenuItem
              className={ITEM_CLASS}
              data-menu-row="conversation"
              render={<Link {...conversationLink(main.id, mainChannel?.id)} />}
            >
              <IconMessageCircle />
              {t("Conversation")}
              {mainChannel?.unread ? <UnreadMark /> : null}
            </DropdownMenuItem>
          ) : null}
          {LOOK_ROWS.map(({ icon: Icon, label, row, to }) => (
            <DropdownMenuItem
              className={ITEM_CLASS}
              data-menu-row={row}
              key={to}
              render={<Link to={to} />}
            >
              <Icon />
              {t(label)}
              {row === "feed" ? <UnseenCount count={unseenCount} /> : null}
              {row === "goals" ? <ActiveGoals /> : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {FOOTER_LINKS.map(({ icon: Icon, label, to }) => (
            <DropdownMenuItem
              className={ITEM_CLASS}
              key={to}
              render={<Link to={to} />}
            >
              <Icon />
              {t(label)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {currentUser?.role === "admin" ? (
            <DropdownMenuItem
              className={ITEM_CLASS}
              render={<Link to="/admin" />}
            >
              <IconShieldLock />
              {t("Admin")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className={ITEM_CLASS}
            render={<Link to="/settings" />}
          >
            <IconSettings />
            {t("Settings")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className={ITEM_CLASS}
            disabled={signOut.isPending}
            onClick={handleSignOut}
            variant="destructive"
          >
            <IconLogout />
            {signOut.isPending ? t("Logging out…") : t("Log out")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <StopAllDialog onOpenChange={setStoppingAll} open={stoppingAll} />
    </>
  );
}
