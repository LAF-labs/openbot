import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { HomeButton } from "@/components/home/home-panel";
import { HeaderSlot } from "@/components/layout/header-slots";
import { BotMark } from "@/components/layout/bot-mark";
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
import { cn } from "@/lib/utils";

/**
 * THE ROW ACROSS THE TOP OF THE SCREEN (2026-10-09; `docs/laf/redesign-2026-10.md` §1, laid out as
 * Hark's is): the switcher in the middle, the profile button at the right, and at the left the
 * home button — but only while the home panel is folded away, because while it is open the button
 * is in the panel's own first row, at the same corner of the window.
 *
 * THREE COLUMNS, THE OUTER TWO EQUAL, so the switcher is in the middle of the screen it switches
 * whatever stands either side of it. The middle of the SCREEN, not of the window: the row is
 * beside the panel, and the conversation under it is centred on the same line.
 *
 * WHAT THE SCREEN PUTS IN IT. The conversation draws the Bot's face, name and state into the left
 * of the row and its own buttons into the right (`header-slots.tsx`); it had a row of its own under
 * this one until 2026-10-09. On every other screen the row draws the Bot's name and state itself
 * (`bot-mark.tsx`), so what the Bot is doing is said in the same place whichever screen is open.
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
 * NOT DRAWN ON A PHONE, AND STILL MOUNTED THERE: the bar at the bottom is the phone's way around
 * until its three screens land, and the watch on a run ending (`useRunEndRefresh`) is what puts
 * the unread dot on that bar.
 */
export function AppHeader() {
  const agents = useQuery(agentListQueryOptions());
  const channels = useQuery(channelListQueryOptions());
  const panel = useHomePanel();
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
      className="grid h-titlebar w-full shrink-0 select-none grid-cols-[1fr_auto_1fr] items-center gap-2 px-2.5 max-md:hidden"
      data-app-header
      data-tauri-drag-region
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-2.5",
          // Only while the button is in this row: open, the panel's own row is under the lights.
          panel.isOpen ? "" : shellLightsInset(),
        )}
        data-tauri-drag-region
      >
        {panel.isOpen ? null : <HomeButton />}
        <HeaderSlot className="flex min-w-0 items-center" name="leading" />
        {isConversation ? null : <BotMark />}
      </div>
      <ViewSwitcher />
      <div
        className="flex min-w-0 items-center justify-end gap-2"
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
