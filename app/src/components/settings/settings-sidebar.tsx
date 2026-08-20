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
                  <IconArrowLeft className="mr-2 h-4 w-4" />
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
                    className="hover:bg-foreground/5 data-[status=active]:bg-foreground/8 data-[status=active]:hover:bg-foreground/8"
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
