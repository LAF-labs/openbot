import { createFileRoute, Outlet } from "@tanstack/react-router";
import { RailNav } from "@/components/layout/rail-nav";
import {
  ShellTitleBar,
  shellTopInset,
} from "@/components/layout/shell-titlebar";
import {
  SETTINGS_NAV,
  SettingsSidebar,
} from "@/components/settings/settings-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authed/settings")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarProvider
      /*
       * The 280px the app shell uses — `--sand-sidebar-width` in styles.css, which is what the
       * roster is actually drawn at. This said 340px and claimed to match it, so crossing into
       * Settings widened the rail by 60px and made the whole frame look like it had moved.
       *
       * `--sidebar-width-mobile` used to be handed in beside it and reached nothing: the Sheet
       * that read it left with the phone decision. Below `lg` there is no column at all now, so
       * there is no second width to name.
       */
      style={{ "--sidebar-width": "280px" } as React.CSSProperties}
    >
      <ShellTitleBar />
      {/* The rail is `fixed inset-y-0`, so the inset has to go on the rail itself: padding on the
          layout around it would move the pane and leave the rail under the window buttons. */}
      <SettingsSidebar className={shellTopInset()} />
      <main className={cn("min-w-0 flex-1", shellTopInset())}>
        {/* Below `lg` the rail is not drawn, and this is the whole navigation of the screen. */}
        <RailNav
          className="lg:hidden"
          items={SETTINGS_NAV}
          label={t("Settings")}
        />
        <Outlet />
      </main>
    </SidebarProvider>
  );
}
