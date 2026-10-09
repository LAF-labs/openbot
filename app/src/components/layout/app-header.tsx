import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { HomeButton } from "@/components/home/home-panel";
import { HeaderSlot } from "@/components/layout/header-slots";
import { PhonePagerTabs } from "@/components/layout/phone-pager";
import { BotState } from "@/components/layout/bot-state";
import { ProfileMenu } from "@/components/layout/profile-menu";
import { ReadNotice } from "@/components/layout/read-states";
import { shellLightsInset } from "@/components/layout/shell-titlebar";
import { UpdateNotice } from "@/components/layout/update-notice";
import { ViewSwitcher } from "@/components/layout/view-switcher";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { rosterNotice } from "@/lib/agents/roster-state";
import { useRunEndRefresh } from "@/lib/agents/run-end-refresh";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { useHomePanel } from "@/lib/home-panel";
import { settledOf, useReading } from "@/lib/reading";
import { useIsSideBySide } from "@/lib/use-side-by-side";
import { cn } from "@/lib/utils";

/**
 * THE ROW ACROSS THE TOP OF THE SCREEN (2026-10-09; `docs/laf/redesign-2026-10.md` §1, laid out as
 * Hark's is): the profile button at the right, and at the left the home button — but only while
 * the home panel is folded away, because while it is open the button is in the panel's own first
 * row, at the same corner of the window.
 *
 * THE MIDDLE IS THE SWITCHER: `[채팅 | 프로젝트]` on a PC (`view-switcher.tsx`), and on a phone
 * 홈 | 채팅 (`phone-pager.tsx`) — there the home panel is not beside the screen but a page before
 * it, and those two are what a person swipes between.
 *
 * THREE COLUMNS, THE OUTER TWO EQUAL, so what is in the middle is in the middle of the window
 * whatever stands either side of it.
 *
 * THE LEFT IS EMPTY TO THE EYE (the user, 2026-10-09, as Hark's is): the home button while the
 * panel is folded, and nothing else. The Bot's name and state stood there for a day; they are in
 * the document still, for a screen reader, said by the conversation on its own screen and by
 * `bot-state.tsx` on every other. The conversation also draws its own buttons into the right of
 * the row (`header-slots.tsx`).
 *
 * NO GROUND OF ITS OWN: the window's backdrop shows through, as it does behind the panel.
 *
 * SEARCH IS NOT HERE YET. The record puts it beside the profile button; nothing can be searched
 * until the conversations have kinds, and a box that finds nothing is not drawn.
 *
 * IT IS ALSO THE WINDOW'S 44px. The installed app draws its traffic lights over the page
 * (`titleBarStyle: "Overlay"`), so the row is `h-titlebar`, carries `data-tauri-drag-region` and is
 * the handle; both are inert in a tab.
 *
 * AT EVERY WIDTH SINCE THE PHONE'S BAR WENT (2026-10-09): it is the one thing drawn on every screen
 * of every surface, which is why the watch on a run ending (`useRunEndRefresh`) lives here — what
 * it refreshes is the unread dot on this row's own profile button.
 */
export function AppHeader() {
  const agents = useQuery(agentListQueryOptions());
  const channels = useQuery(channelListQueryOptions());
  const panel = useHomePanel();
  const isSideBySide = useIsSideBySide();
  const isConversation = useRouterState({
    select: (state) =>
      state.location.pathname === "/" ||
      state.location.pathname.startsWith("/channel"),
  });
  /*
   * What is drawn is what was read — the answer, or the one from before when refreshing it failed —
   * and never data a refusal has said this account cannot have.
   */
  const bots = useReading(agents);
  const conversations = useReading(channels);
  const line = rosterNotice({ bots, conversations });
  useRunEndRefresh();

  /** Asks again for whichever of the two lists failed; a list that answered is left alone. */
  const handleRetry = () => {
    if (bots.state === "failed") void agents.refetch();
    if (conversations.state === "failed") void channels.refetch();
  };

  return (
    <header
      className="row-start-1 grid h-titlebar w-full shrink-0 select-none grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-2.5 md:col-start-2"
      data-app-header
      data-tauri-drag-region
    >
      <div
        className={cn(
          "col-start-1 flex min-w-0 items-center gap-2.5",
          // Only while the button is in this row: open, the panel's own row is under the lights.
          panel.isOpen ? "" : shellLightsInset(),
        )}
        data-tauri-drag-region
      >
        {/* A phone has no panel to fold: 홈 is a page there, and the tabs are the way to it. */}
        {isSideBySide && !panel.isOpen ? <HomeButton /> : null}
        <HeaderSlot className="flex min-w-0 items-center" name="leading" />
        {isConversation ? null : <BotState />}
      </div>
      <ViewSwitcher />
      <PhonePagerTabs />
      {/*
       * NAMED COLUMNS. With the tabs not drawn — every PC — an unplaced right zone took the middle
       * column, and the profile button stood in the middle of the row (measured at 1024: x=674).
       */}
      <div
        className="col-start-3 flex min-w-0 items-center justify-end gap-2"
        data-tauri-drag-region
      >
        <HeaderSlot
          className="flex shrink-0 items-center gap-1"
          name="actions"
        />
        <ReadNotice
          hasButton
          line={line}
          onRetry={handleRetry}
          size="compact"
        />
        <UpdateNotice shape="icon" />
        <ProfileMenu channels={settledOf(conversations)?.data} />
      </div>
    </header>
  );
}
