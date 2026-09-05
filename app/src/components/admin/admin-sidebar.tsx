import {
  IconArrowLeft,
  IconCode,
  IconDeviceDesktop,
  IconKey,
  IconLayoutGrid,
  IconListDetails,
  IconPuzzle,
  IconShieldCheck,
} from "@tabler/icons-react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import type { RailNavItem } from "@/components/layout/rail-nav";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { t } from "@/lib/i18n";

const appLinkOptions = { to: "/" } satisfies LinkOptions;
const adminLinkOptions = { to: "/admin" } satisfies LinkOptions;

/**
 * The same three groups, in the same order, as the admin index.
 *
 * A rail that lists eight things flat asks somebody to know which of them is the one they want. The
 * grouping is the only navigation help this screen offers, so it has to agree with the page it
 * navigates to — two different orderings of the same eight links is worse than either ordering.
 */
const GROUPS: {
  label: string;
  items: {
    icon: React.ComponentType<{ className?: string }>;
    linkOptions: LinkOptions;
    title: string;
  }[];
}[] = [
  {
    label: t("What Bots can reach"),
    items: [
      {
        title: t("Credentials"),
        icon: IconKey,
        linkOptions: { to: "/admin/credentials" },
      },
      {
        title: t("Boundaries"),
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/boundaries" },
      },
      {
        title: t("Computers"),
        icon: IconDeviceDesktop,
        linkOptions: { to: "/admin/computers" },
      },
    ],
  },
  {
    label: t("What Bots can do"),
    items: [
      {
        title: t("Plugins"),
        icon: IconPuzzle,
        linkOptions: { to: "/admin/plugins" },
      },
      {
        title: t("Components"),
        icon: IconLayoutGrid,
        linkOptions: { to: "/admin/components" },
      },
      {
        title: t("Playground"),
        icon: IconCode,
        linkOptions: { to: "/admin/playground" },
      },
    ],
  },
  {
    label: t("What happened"),
    items: [
      {
        title: t("Audit"),
        icon: IconListDetails,
        linkOptions: { to: "/admin/audit" },
      },
    ],
  },
];

/**
 * The same nine links, flat, for the row that replaces the rail below `lg`.
 *
 * Flat rather than grouped because a horizontal strip has nowhere to put a group label, and the
 * order is the rail's order, so the two never disagree about where 감사 is.
 */
export const ADMIN_NAV: RailNavItem[] = [
  // Exact, because /admin is a prefix of every other route here.
  { title: t("Overview"), linkOptions: adminLinkOptions, isExact: true },
  ...GROUPS.flatMap((group) =>
    group.items.map((item) => ({
      title: item.title,
      linkOptions: item.linkOptions,
    })),
  ),
];

export function AdminSidebar({
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
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              {/*
               * `activeOptions.exact`, because /admin is a prefix of every other route here and
               * would otherwise light up on all of them.
               */}
              <SidebarMenuButton
                // One rhythm with the app sidebar: h-10 rows, and an active state that does not
                // dip back to the hover fill when the row you are on is hovered.
                className="h-10 hover:bg-foreground/5 data-[status=active]:bg-foreground/8 data-[status=active]:hover:bg-foreground/8"
                render={(props) => (
                  <Link
                    {...adminLinkOptions}
                    activeOptions={{ exact: true }}
                    activeProps={{ className: "bg-foreground/5" }}
                    {...props}
                  >
                    {t("Overview")}
                  </Link>
                )}
              />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    // One rhythm with the app sidebar: h-10 rows, and an active state that does not
                    // dip back to the hover fill when the row you are on is hovered.
                    className="h-10 hover:bg-foreground/5 data-[status=active]:bg-foreground/8 data-[status=active]:hover:bg-foreground/8"
                    render={(props) => (
                      <Link {...item.linkOptions} {...props}>
                        <item.icon />
                        {item.title}
                      </Link>
                    )}
                  />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
