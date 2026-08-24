import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
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
       * The same 340px the app and Settings use. A rail that changes width as you cross into admin
       * makes the whole frame look like it moved.
       */
      style={
        {
          "--sidebar-width": "340px",
          "--sidebar-width-mobile": "20rem",
        } as React.CSSProperties
      }
    >
      <AdminSidebar />
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </SidebarProvider>
  );
}
