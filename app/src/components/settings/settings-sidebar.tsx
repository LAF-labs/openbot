import { IconArrowLeft } from "@tabler/icons-react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import type { RailNavItem } from "@/components/layout/rail-nav";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { t } from "@/lib/i18n";

const appLinkOptions = { to: "/" } satisfies LinkOptions;

/**
 * The three screens Settings is, and the only list of them.
 *
 * Exported because the rail is not the only thing that draws it: below `lg` there is no rail, and
 * `RailNav` reads this same table. Two copies would be two orders and, sooner, two answers about
 * which row is lit.
 */
export const SETTINGS_NAV: RailNavItem[] = [
  {
    title: t("General"),
    linkOptions: { to: "/settings" },
    /*
     * `/settings` is a prefix of every other route here, so without this it lights up on all of
     * them — General stayed active while somebody was reading 연결. The admin rail had already
     * made this argument for `/admin`; this rail had never had it made.
     */
    isExact: true,
  },
  /*
   * The same argument as 내 정보 below, and it had never been made for this one: 연결 was reachable
   * only by opening General and reading past appearance settings, which is where somebody looks
   * exactly once — when they have been told to. It is the screen a person comes back to every time
   * they add a service, so it is a row.
   */
  {
    title: t("Connections"),
    linkOptions: { to: "/settings/connected-accounts" },
  },
  /*
   * Its own row rather than a link buried in General.
   *
   * Taking your data and ending your account are the two things somebody has to be able to FIND
   * without being told where they are — a page reachable only by scrolling past appearance settings
   * is a page that does not really exist.
   */
  {
    title: t("Your data"),
    linkOptions: { to: "/settings/account" },
  },
];

export function SettingsSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  <IconArrowLeft />
                  {t("Back to app")}
                </Link>
              )}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu>
          <SidebarGroup>
            {SETTINGS_NAV.map((option) => {
              return (
                <SidebarMenuItem key={option.title}>
                  {/* The same active grammar as the app sidebar: the stacked active+hover variant
                      outranks plain hover, so the row you are on never dips to the hover fill. */}
                  <SidebarMenuButton
                    className="h-10 hover:bg-foreground/5 data-[status=active]:bg-foreground/8 data-[status=active]:hover:bg-foreground/8"
                    render={(props) => (
                      <Link
                        activeOptions={
                          option.isExact ? { exact: true } : undefined
                        }
                        {...option.linkOptions}
                        {...props}
                      >
                        {option.title}
                      </Link>
                    )}
                  />
                </SidebarMenuItem>
              );
            })}
          </SidebarGroup>
        </SidebarMenu>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
