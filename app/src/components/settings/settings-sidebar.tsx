import { IconArrowLeft } from "@tabler/icons-react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
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

const ITEMS = [
  {
    title: t("General"),
    linkOptions: { to: "/settings" },
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
            {ITEMS.map((option) => {
              return (
                <SidebarMenuItem key={option.title}>
                  {/* The same active grammar as the app sidebar: the stacked active+hover variant
                      outranks plain hover, so the row you are on never dips to the hover fill. */}
                  <SidebarMenuButton
                    className="h-10 hover:bg-foreground/5 data-[status=active]:bg-foreground/8 data-[status=active]:hover:bg-foreground/8"
                    render={(props) => (
                      <Link {...option.linkOptions} {...props}>
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
