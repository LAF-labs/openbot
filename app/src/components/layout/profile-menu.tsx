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
import { useEffect, useRef, useState } from "react";
import { footerLinksFor } from "@/components/app-sidebar/places";
import { StopAllDialog } from "@/components/app-sidebar/stop-all-dialog";
import { PersonAvatar } from "@/components/avatar/person-avatar";
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
import { conversationOf, useMyBots } from "@/lib/agents/my-bots";
import { workingLabel, workingQueryOptions } from "@/lib/agents/working";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { channelKeys, channelListQueryOptions } from "@/lib/channels/queries";
import { feedKeys, feedUnseenQueryOptions } from "@/lib/feed/queries";
import { goalKeys, goalsQueryOptions } from "@/lib/goals/queries";
import { t } from "@/lib/i18n";
import { madeKeys } from "@/lib/made/queries";
import { settledOf, useReading } from "@/lib/reading";

/**
 * EVERYWHERE THE APP GOES, BEHIND THE PERSON'S OWN PICTURE (2026-10-10, record §1, piece 3-1).
 *
 * The column at the left of the window held all of this in three places: the Bot and its
 * conversation at the top, four rows under it (소식 · 아이디어 · 목표 · 만든 것), and a button at the
 * foot opening the places that change how the Bot works and what is about the account. The column
 * is gone — the whole width is the screen now — and the three are one list, a press away, in the
 * corner every app keeps "me" in.
 *
 * THE ORDER, AND WHY 모두 멈추기 IS STILL FIRST. It is the one item here somebody reaches for in a
 * hurry: a conversation and a routine can both be running, and Stop lives inside one conversation
 * at a time. Then where the Bot's work is read — the conversation, 소식, 아이디어, 목표, 만든 것 — in
 * the order the column had them; then the places that change how it works (`places.ts`, the same
 * list the phone's 메뉴 page draws, with 계정 in it since this change); then what is about the
 * deployment and the account; and leaving, last.
 *
 * AN ACCOUNT FROM BEFORE THE CAP CAME DOWN keeps every Bot it had, and reaches each from here: one
 * item a Bot, opening that Bot's conversation, in place of the single 대화. It was a list of rows
 * with the last thing each said; in a menu it is the name, a mark where something is unread, and a
 * word where one is working — which is what tells several Bots apart at a glance.
 *
 * WHAT THE COLUMN SAID WITHOUT BEING OPENED, AND THIS CANNOT. 소식's count and the conversation's
 * unread mark were in sight on every screen; a closed menu shows neither. So the button wears ONE
 * mark while either has something new, and the item inside says which. That the Bot is waiting on
 * the person is not this button's to say: it stands in the row itself, beside the Bot's name, on
 * every screen (`bot-presence-link.tsx`; on the conversation, in its header).
 *
 * NOT A MENU ITEM ANY MORE: "읽지 않음으로 표시", which was the right-click of a row. There is no
 * row. The Bot's profile is reached from the conversation's own header, as before.
 */

/** Where the Bot's work is read, in the order the column had them. */
const LOOK_PLACES = [
  { to: "/feed", icon: IconLayoutList, label: "Updates", is: "feed" },
  { to: "/ideas", icon: IconBulb, label: "Ideas", is: "ideas" },
  { to: "/goals", icon: IconTarget, label: "Goals", is: "goals" },
  { to: "/made", icon: IconLayoutGrid, label: "Made", is: "made" },
] as const;

const ITEM_CLASS = "gap-2 px-2 py-1.5";

/** Something new, said twice: a mark for the eye and a word for whoever cannot see it. */
function NewMark({ label }: { label: string }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="ml-auto size-2 shrink-0 rounded-full bg-mark"
        data-mark="new"
      />
      <span className="sr-only">{label}</span>
    </>
  );
}

/**
 * A run ending is the moment a routine's answer lands in the conversation, and nothing pushes that
 * to the window — the socket carries only what a window reported. The working poll already notices
 * the run end; this turns that into a refresh of what the run may have written: the conversations
 * (the delivered answer and its unread mark), 소식's count (a feed run's posts land when it ends)
 * and 목표's (a goal is saved, and progress logged, by a turn or a check-in run).
 *
 * It lived in the column, which was always mounted. It lives with the menu's button now, for the
 * same reason: this is on every screen of the app.
 */
function useRefreshWhenARunEnds(workingIds: string): void {
  const queryClient = useQueryClient();
  const previous = useRef(workingIds);
  useEffect(() => {
    const before = new Set(previous.current.split(",").filter(Boolean));
    const after = new Set(workingIds.split(",").filter(Boolean));
    previous.current = workingIds;
    if ([...before].some((id) => !after.has(id))) {
      void queryClient.invalidateQueries({ queryKey: channelKeys.list() });
      void queryClient.invalidateQueries({ queryKey: feedKeys.all });
      void queryClient.invalidateQueries({ queryKey: goalKeys.all });
      // And what the Bot made: the home panel lists the newest on every screen (`home-widgets.tsx`).
      void queryClient.invalidateQueries({ queryKey: madeKeys.all });
    }
  }, [workingIds, queryClient]);
}

export function ProfileMenu() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mine = useMyBots();
  const channels = useQuery(channelListQueryOptions());
  const working = useQuery(workingQueryOptions());
  const unseen = useQuery(feedUnseenQueryOptions());
  const goals = useQuery(goalsQueryOptions());
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const [signOutError, setSignOutError] = useState<string | null>(null);
  /** `모두 멈추기`'s dialog. Outside the menu, which closes on the press that opens it. */
  const [stoppingAll, setStoppingAll] = useState(false);

  const workingIds = (working.data ?? []).map((run) => run.agentId).join(",");
  useRefreshWhenARunEnds(workingIds);

  /*
   * What is drawn is what was read — the answer, or the one from before when refreshing it failed —
   * and never data a refusal has said this account cannot have.
   */
  const channelList = settledOf(useReading(channels))?.data;
  const bots = (mine.bots ?? []).map((agent) => {
    const channel = conversationOf(agent.id, channelList);
    const run = working.data?.find((entry) => entry.agentId === agent.id);
    return {
      agent,
      channel,
      unread: channel?.unread ?? false,
      working: run ? workingLabel(run) : undefined,
    };
  });
  const isLegacy = bots.length > 1;
  const [only] = bots;
  const unseenCount = unseen.data ?? 0;
  const activeGoals = goals.data?.active ?? 0;
  const hasNew = unseenCount > 0 || bots.some((bot) => bot.unread);

  const handleSignOut = async () => {
    setSignOutError(null);
    try {
      await signOut.mutateAsync();
    } catch {
      // The surface's own words, never what was thrown.
      setSignOutError(t("Could not log out."));
      return;
    }
    await navigate({ to: "/sign" });
  };

  /*
   * WHO IS SIGNED IN, as the button's name and title: the name and the address, whichever there
   * are. In two statements — joined and defaulted in one, the React Compiler left the component
   * uncompiled ("Unexpected terminal kind `optional` for logical test block").
   */
  const signedInAs = [currentUser?.name, currentUser?.email]
    .filter((part) => Boolean(part))
    .join(" · ");
  const accountName = signedInAs || t("Account");
  const menuName = hasNew
    ? `${t("Menu")} · ${accountName} · ${t("Something new")}`
    : `${t("Menu")} · ${accountName}`;

  const conversationOfBot = (bot: (typeof bots)[number]) =>
    bot.channel
      ? ({
          params: { channelId: bot.channel.id },
          to: "/channel/$channelId",
        } as const)
      : ({ search: { agent: bot.agent.id }, to: "/channel/new" } as const);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={menuName}
              className="relative size-9 shrink-0 rounded-full p-0 hover:bg-accent"
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
          {hasNew ? (
            <span
              aria-hidden="true"
              className="absolute top-1 right-1 size-2 rounded-full bg-mark ring-2 ring-background"
              data-mark="new"
            />
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

          {/* Several Bots, on an account from before the cap: each is its own conversation. */}
          {isLegacy ? (
            <DropdownMenuGroup>
              <DropdownMenuLabel className="px-2 py-1 text-muted-foreground text-xs">
                {t("Your Bots")}
              </DropdownMenuLabel>
              {bots.map((bot) => (
                <DropdownMenuItem
                  className={ITEM_CLASS}
                  data-menu-bot={bot.agent.id}
                  key={bot.agent.id}
                  render={<Link {...conversationOfBot(bot)} />}
                >
                  <IconMessageCircle />
                  <span className="min-w-0 truncate">{bot.agent.name}</span>
                  {bot.working ? (
                    <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                      {bot.working}
                    </span>
                  ) : bot.unread ? (
                    <NewMark label={t("Unread")} />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ) : null}

          {/* One Bot: its conversation is simply 대화. */}
          {!isLegacy && only ? (
            <DropdownMenuItem
              className={ITEM_CLASS}
              data-menu-place="conversation"
              render={<Link {...conversationOfBot(only)} />}
            >
              <IconMessageCircle />
              {t("Conversation")}
              {only.unread ? <NewMark label={t("Unread")} /> : null}
            </DropdownMenuItem>
          ) : null}

          {LOOK_PLACES.map(({ icon: Icon, is, label, to }) => (
            <DropdownMenuItem
              className={ITEM_CLASS}
              data-menu-place={is}
              key={to}
              render={<Link to={to} />}
            >
              <Icon />
              {t(label)}
              {is === "feed" && unseenCount > 0 ? (
                <span
                  className="ml-auto rounded-full bg-mark px-1.5 font-medium text-white text-xs leading-5"
                  data-unseen-count
                >
                  <span aria-hidden="true">{unseenCount}</span>
                  <span className="sr-only">
                    {t("{count} new", { count: unseenCount })}
                  </span>
                </span>
              ) : null}
              {/* Quiet, not the mark 소식's count wears: nothing here is new, it is what is being worked on. */}
              {is === "goals" && activeGoals > 0 ? (
                <span
                  className="ml-auto text-muted-foreground text-xs tabular-nums"
                  data-active-goals
                >
                  <span aria-hidden="true">{activeGoals}</span>
                  <span className="sr-only">
                    {t("{count} in progress", { count: activeGoals })}
                  </span>
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />

          {footerLinksFor(isLegacy).map(({ icon: Icon, label, to }) => (
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

      {/* Outside the menu, which closes on click: an error inside it dies with the interaction. */}
      {signOutError ? (
        <p
          className="fixed top-12 right-3 z-40 rounded-lg border border-border bg-popover px-3 py-2 text-destructive text-xs shadow-lg"
          role="alert"
        >
          {signOutError}
        </p>
      ) : null}
      <StopAllDialog onOpenChange={setStoppingAll} open={stoppingAll} />
    </>
  );
}
