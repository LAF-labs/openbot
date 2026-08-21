import { createFileRoute, Outlet } from "@tanstack/react-router";
import { BotRail } from "@/components/app-sidebar/bot-rail";
import { t } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    /*
     * ONE VIEWPORT, NEVER SCROLLS: panes scroll inside it. A growable shell lets the transcript's
     * scroller size against the page, grow it, and grow again.
     *
     * The rail is a plain flex child rather than the sidebar primitive it used to be. That
     * primitive brought a 340px width, a collapse mechanism, a mobile sheet and a keyboard
     * shortcut — machinery for a rail you might want to hide. A 72px column of faces is not in the
     * way of anything, so there is nothing to hide and nothing to bring back.
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
      <BotRail />
      <main
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        id="main"
        // Focusable only as a skip-link target, never as a tab stop of its own.
        tabIndex={-1}
      >
        <Outlet />
      </main>
    </div>
  );
}
