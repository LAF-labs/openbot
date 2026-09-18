import { createFileRoute, Outlet } from "@tanstack/react-router";
import { BotSidebar } from "@/components/app-sidebar/bot-sidebar";
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
     * The roster is a plain flex child rather than the sidebar primitive it used to be. That
     * primitive brought its own width, a collapse mechanism, a mobile sheet and a keyboard
     * shortcut; the column here is a fixed 280px that is always the inbox, so there is nothing to
     * collapse and nothing to bring back.
     */
    <div className="flex h-svh w-full overflow-hidden">
      {/*
       * THE COMPOSER IS ABOUT THIRTY-FIVE TAB STOPS DEEP. This is the standard way past a
       * navigation column, and it is the first thing in the tab order: invisible until focused,
       * then a real button in the corner.
       */}
      <a
        className="sr-only z-50 rounded-lg bg-popover px-3 py-2 text-sm shadow-lg focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
        href="#main"
      >
        {t("Skip to the conversation")}
      </a>
      {/*
       * TWO SEAMS, ONE PER COLUMN. The roster and the screen beside it share nothing but the
       * window, and before these a throw in either was caught by the router at THIS layout — both
       * columns replaced by one error page. A failed roster now leaves the conversation working,
       * and a failed page leaves the roster to go somewhere else with. The roster's fallback keeps
       * the column's ground and a fixed width, so the page beside it does not jump sideways.
       */}
      <SectionBoundary
        className="h-full w-70 max-w-[40vw] shrink-0 border-border border-r bg-sidebar"
        queryKeys={ROSTER_QUERIES}
        section="sidebar"
      >
        <BotSidebar />
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
  );
}
