import { createFileRoute, Outlet } from "@tanstack/react-router";
import {
  ShellTitleBar,
  shellTopInset,
} from "@/components/layout/shell-titlebar";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authed/settings")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarProvider
      /*
       * The same 340px the app shell uses. Settings is a different screen, not a different product,
       * and a rail that changes width on the way in makes the whole frame look like it moved.
       */
      style={
        {
          "--sidebar-width": "340px",
          "--sidebar-width-mobile": "20rem",
        } as React.CSSProperties
      }
    >
      <ShellTitleBar />
      {/* The rail is `fixed inset-y-0`, so the inset has to go on the rail itself: padding on the
          layout around it would move the pane and leave the rail under the window buttons. */}
      <SettingsSidebar className={shellTopInset()} />
      <main className={cn("min-w-0 flex-1", shellTopInset())}>
        <Outlet />
      </main>
    </SidebarProvider>
  );
}
