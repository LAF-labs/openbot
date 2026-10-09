import { createFileRoute, Outlet } from "@tanstack/react-router";
import { HOME_PANEL_PLACE, HomePanel } from "@/components/home/home-panel";
import { AppHeader } from "@/components/layout/app-header";
import { HeaderSlotsProvider } from "@/components/layout/header-slots";
import {
  PHONE_PAGE_CLASS,
  PhonePager,
  PhonePagerProvider,
} from "@/components/layout/phone-pager";
import { SectionBoundary } from "@/components/layout/section-boundary";
import { agentKeys } from "@/lib/agents/queries";
import { channelKeys } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";

/**
 * What the row at the top reads that the screen under it reads too — the Bots and the
 * conversations — so 다시 불러오기 fetches them again even while that screen is still watching them.
 */
const ROSTER_QUERIES = [agentKeys.list(), channelKeys.list()] as const;

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    /*
     * ONE VIEWPORT, NEVER SCROLLS: panes scroll inside it. A growable shell lets the transcript's
     * scroller size against the page, grow it, and grow again.
     *
     * TWO COLUMNS (2026-10-09, `docs/laf/redesign-2026-10.md` §1): the home panel
     * (`home-panel.tsx`), which a person folds away and drags wider, and beside it the screen under
     * its row (`app-header.tsx`). The left column was the sidebar — the Bot and its places — and the
     * places are behind the profile button now.
     *
     * ON A PHONE THE SAME THREE PARTS, ARRANGED FOR ONE COLUMN: the row across the top, and under
     * it the panel and the screen as two pages swiped between (`phone-pager.tsx`). One grid does
     * both — the pager's scroller is `md:contents`, so on a PC its two children are grid items of
     * this layout and on a phone they are its pages. The bar that stood at the bottom is gone
     * (2026-10-09): its six tabs are the two pages and the menu under the profile button.
     *
     * THE GROUND IS THE BACKDROP (`bg-backdrop`, `styles.css`), the one thing drawn behind all of
     * it: the panel and the row have no ground of their own, and what stands on it is glass.
     */
    <HeaderSlotsProvider>
      <PhonePagerProvider>
        <div className="grid h-svh w-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-backdrop max-md:pb-[env(safe-area-inset-bottom)] md:grid-cols-[auto_minmax(0,1fr)]">
          {/*
           * THE FIRST THING IN THE TAB ORDER: invisible until focused, then a real button in the
           * corner. It was the way past a navigation column thirty-five tab stops long; the row at the
           * top is two or three, and a screen reader still lands on the screen in one press.
           */}
          <a
            className="sr-only z-50 rounded-lg bg-popover px-3 py-2 text-sm shadow-lg focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
            href="#main"
          >
            {t("Skip to the conversation")}
          </a>
          {/*
           * THREE SEAMS. The panel, the row and the screen share nothing but the window, and
           * before seams a throw in any one was caught by the router at THIS layout — all of it
           * replaced by one error page. A failed panel now leaves the conversation working, and a
           * failed page leaves the menu to go somewhere else with. Each fallback keeps its part's
           * place in the grid, so what is beside it does not jump.
           */}
          <SectionBoundary
            className="row-start-1 flex h-titlebar w-full shrink-0 items-center justify-end gap-2 overflow-hidden px-2.5 md:col-start-2"
            queryKeys={ROSTER_QUERIES}
            section="top_row"
          >
            <AppHeader />
          </SectionBoundary>
          <PhonePager>
            <SectionBoundary
              className={`h-full ${HOME_PANEL_PLACE}`}
              queryKeys={ROSTER_QUERIES}
              section="home_panel"
            >
              <HomePanel />
            </SectionBoundary>
            <main
              className={`flex min-h-0 min-w-0 flex-col overflow-hidden md:col-start-2 md:row-start-2 ${PHONE_PAGE_CLASS}`}
              id="main"
              // Focusable only as a skip-link target, never as a tab stop of its own.
              tabIndex={-1}
            >
              <SectionBoundary className="flex-1" section="main">
                <Outlet />
              </SectionBoundary>
            </main>
          </PhonePager>
        </div>
      </PhonePagerProvider>
    </HeaderSlotsProvider>
  );
}
