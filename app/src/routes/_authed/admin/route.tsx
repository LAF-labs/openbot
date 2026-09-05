import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { ADMIN_NAV, AdminSidebar } from "@/components/admin/admin-sidebar";
import { RailNav } from "@/components/layout/rail-nav";
import {
  ShellTitleBar,
  shellTopInset,
} from "@/components/layout/shell-titlebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { loadCurrentUser } from "../../../lib/auth/load-current-user";

export const Route = createFileRoute("/_authed/admin")({
  beforeLoad: async ({ context }) => {
    const user = await loadCurrentUser(context.queryClient);
    if (user?.role !== "admin") {
      throw redirect({ to: "/" });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarProvider
      /*
       * The 280px the app and Settings use — `--sand-sidebar-width`. It said 340px and claimed to
       * match them, and `--sidebar-width-mobile` beside it reached nothing after the Sheet left.
       */
      style={{ "--sidebar-width": "280px" } as React.CSSProperties}
    >
      <ShellTitleBar />
      {/* The rail is `fixed inset-y-0`: the inset goes on it, not on the layout around it. */}
      <AdminSidebar className={shellTopInset()} />
      <main className={cn("min-w-0 flex-1", shellTopInset())}>
        {/* Below `lg` the rail is not drawn. Nine links, so this one scrolls sideways. */}
        <RailNav className="lg:hidden" items={ADMIN_NAV} label={t("Admin")} />
        <Outlet />
      </main>
    </SidebarProvider>
  );
}
