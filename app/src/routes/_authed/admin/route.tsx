import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import {
  ADMIN_NAV,
  AdminSidebar,
  adminPagesOffered,
  useTakesBotEndpoints,
} from "@/components/admin/admin-sidebar";
import { RailNav } from "@/components/layout/rail-nav";
import { SectionBoundary } from "@/components/layout/section-boundary";
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
  const takesBotEndpoints = useTakesBotEndpoints();
  return (
    <SidebarProvider
      /*
       * The width the app and Settings use — `--sand-sidebar-width`, 216px since 2026-10-04. It
       * said 340px and claimed to match them, and `--sidebar-width-mobile` beside it reached
       * nothing after the Sheet left.
       */
      style={{ "--sidebar-width": "216px" } as React.CSSProperties}
    >
      <ShellTitleBar />
      {/* The rail is `fixed inset-y-0`: the inset goes on it, not on the layout around it. */}
      <AdminSidebar className={shellTopInset()} />
      <main className={cn("min-w-0 flex-1", shellTopInset())}>
        {/* Below `lg` the rail is not drawn. Eight or nine links, so this one scrolls sideways. */}
        <RailNav
          className="lg:hidden"
          items={adminPagesOffered(ADMIN_NAV, takesBotEndpoints)}
          label={t("Admin")}
        />
        {/* The same seam as Settings, for the same reasons: one page at a time, rail outside. */}
        <SectionBoundary className="py-16" section="admin_page">
          <Outlet />
        </SectionBoundary>
      </main>
    </SidebarProvider>
  );
}
