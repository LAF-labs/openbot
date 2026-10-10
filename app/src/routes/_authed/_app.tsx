import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppTopBar } from "@/components/layout/app-top-bar";
import { PhoneTabBar } from "@/components/layout/phone-tab-bar";
import { SectionBoundary } from "@/components/layout/section-boundary";
import { agentKeys } from "@/lib/agents/queries";
import { channelKeys } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";

/**
 * What the roster reads that the screen beside it reads too — the Bots and the conversations — so
 * 다시 불러오기 fetches them again even while that screen is still watching them.
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
     * A COLUMN: the top row, then the screen (2026-10-10, record §1, piece 3-1). There was a
     * column at the left of the window — the Bot, its conversation, 소식 · 아이디어 · 목표 · 만든 것
     * and a menu at its foot — and the screen beside it. That column is gone: what it led to is
     * behind the person's picture at the right of the top row (`layout/profile-menu.tsx`), and
     * the screen is the whole width.
     *
     * IN A NARROW WINDOW THE BAR UNDER THE SCREEN IS STILL DRAWN (`phone-tab-bar.tsx`). A phone's
     * browser is not a surface this app is made for (owner, 2026-10-10: mobile is an app of its
     * own); what was there is left as it was, neither worked on nor taken out.
     */
    <div className="flex h-svh w-full flex-col overflow-hidden">
      {/*
       * THE COMPOSER IS MANY TAB STOPS DEEP. This is the standard way past what comes before it,
       * and it is the first thing in the tab order: invisible until focused, then a real button
       * in the corner.
       */}
      <a
        className="sr-only z-50 rounded-lg bg-popover px-3 py-2 text-sm shadow-lg focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
        href="#main"
      >
        {t("Skip to the conversation")}
      </a>
      {/*
       * TWO SEAMS: THE MENU'S AND THE SCREEN'S. The menu in the top row reads the Bots and the
       * conversations, and the screen under it shares nothing with that but the window; before
       * the seams a throw in either was caught by the router at THIS layout — both replaced by
       * one error page. A failed roster now leaves the conversation working, and a failed page
       * leaves the menu to go somewhere else with. The row itself is outside both: it is the
       * place the window is dragged by, and stays whatever fails (`layout/app-top-bar.tsx`).
       *
       * THE NARROW WINDOW'S BAR IS IN THE MENU'S SEAM, as it was in the column's: it reads the
       * same Bots and conversations, and outside any seam an answer that broke the roster broke
       * the whole layout through the bar instead (measured by `section-seams.test.tsx`). It is
       * handed to the row, which draws it from that seam and lays it out under the screen.
       */}
      <AppTopBar narrowBar={<PhoneTabBar />} rosterQueries={ROSTER_QUERIES}>
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
      </AppTopBar>
    </div>
  );
}
