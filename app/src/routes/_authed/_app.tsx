import { createFileRoute, Outlet } from "@tanstack/react-router";
import { HomePanel } from "@/components/home/home-panel";
import { AppHeader } from "@/components/layout/app-header";
import { HeaderSlotsProvider } from "@/components/layout/header-slots";
import { PhoneTabBar } from "@/components/layout/phone-tab-bar";
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
     * ON A PHONE, A COLUMN: the screen, then the bar (`phone-tab-bar.tsx`) under it. Neither the
     * panel nor the row is drawn there.
     *
     * THE GROUND IS THE BACKDROP (`bg-backdrop`, `styles.css`), the one thing drawn behind all of
     * it: the panel and the row have no ground of their own, and what stands on it is glass.
     */
    <div className="flex h-svh w-full overflow-hidden bg-backdrop max-md:flex-col">
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
       * THREE SEAMS. The panel, the row and the screen share nothing but the window, and before
       * seams a throw in any one was caught by the router at THIS layout — all of it replaced by
       * one error page. A failed panel now leaves the conversation working, and a failed page
       * leaves the menu to go somewhere else with. Each fallback keeps its part's size, so what is
       * beside it does not jump.
       */}
      {/*
       * THE PHONE'S BAR IS IN THE PANEL'S SEAM. It reads the same Bots and conversations, and
       * outside any seam an answer that broke them broke the whole layout through the bar instead
       * (measured by `section-seams.test.tsx`). The seam draws its children with no wrapper, so the
       * bar is still the layout's own flex child, sent below the screen by `order`; and the seam's
       * fallback, which is the column's ground on a PC, is a line at the bottom on a phone.
       */}
      <SectionBoundary
        className="h-full w-home-panel shrink-0 max-md:order-last max-md:h-auto max-md:w-full max-md:border-border max-md:border-t max-md:bg-sidebar"
        queryKeys={ROSTER_QUERIES}
        section="home_panel"
      >
        <HomePanel />
        <PhoneTabBar />
      </SectionBoundary>
      {/* The row's two places are filled by the screen under it, so one provider holds both. */}
      <HeaderSlotsProvider>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <SectionBoundary
            className="flex h-titlebar w-full shrink-0 items-center justify-end gap-2 overflow-hidden px-2.5 max-md:hidden"
            queryKeys={ROSTER_QUERIES}
            section="top_row"
          >
            <AppHeader />
          </SectionBoundary>
          <main
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            id="main"
            // Focusable only as a skip-link target, never as a tab stop of its own.
            tabIndex={-1}
          >
            <SectionBoundary className="flex-1" section="main">
              <Outlet />
            </SectionBoundary>
          </main>
        </div>
      </HeaderSlotsProvider>
    </div>
  );
}
