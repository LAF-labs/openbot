import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import {
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

/**
 * The way back to the sidebar, which did not exist.
 *
 * `SidebarTrigger` was never rendered anywhere in the app. On a desktop the only ways to bring the
 * rail back were Cmd-B, undiscoverable, and the 4px invisible rail, which is `hidden` below the `sm`
 * breakpoint — and under 768px the sidebar becomes a sheet with no rail at all, so every
 * conversation, Routines, Skills and Agents were unreachable with no way to notice why.
 *
 * In the flow rather than floating over the page: an absolute button would land on the channel
 * header's avatar, and this appears only when the rail is away, so nothing moves in the normal case.
 */
function SidebarReturn() {
  const { state, isMobile } = useSidebar();
  if (!isMobile && state === "expanded") {
    return null;
  }
  return (
    <div className="flex h-10 shrink-0 items-center px-2">
      <SidebarTrigger />
    </div>
  );
}

function RouteComponent() {
  return (
    // One viewport, never scrolls: panes scroll inside it. A growable shell lets the transcript's
    // scroller size against the page, grow it, and grow again.
    <SidebarProvider
      className="h-svh overflow-hidden"
      style={
        {
          "--sidebar-width": "340px",
          "--sidebar-width-mobile": "20rem",
        } as React.CSSProperties
      }
    >
      <AppSidebar />
      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <SidebarReturn />
        <Outlet />
      </main>
    </SidebarProvider>
  );
}
