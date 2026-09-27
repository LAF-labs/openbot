import {
  IconChevronRight,
  IconLogout,
  IconPlayerStop,
  IconSettings,
  IconShieldLock,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { footerLinksFor } from "@/components/app-sidebar/places";
import { StopAllDialog } from "@/components/app-sidebar/stop-all-dialog";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { PageShell } from "@/components/layout/page-shell";
import { focusRing } from "@/components/ui/focus";
import { Skeleton } from "@/components/ui/skeleton";
import { primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 메뉴 — EVERYTHING THAT CHANGES HOW THE BOT WORKS, ON A PHONE (muse-shape plan §3.6, phase 3).
 *
 * The phone's third tab, and what the sheet it replaces used to hold: the Bot's face and name (to
 * its profile), then 수첩 · 루틴 · 스킬 · 연결 · 도움말 · 설정, then 모두 멈추기 and 로그아웃, and 관리
 * for an administrator. The links are the PC sidebar's own list (`app-sidebar/places.ts`), so the
 * two cannot offer different places. On the PC app this is the sidebar's footer and account menu;
 * nothing links here from there.
 */
export const Route = createFileRoute("/_authed/_app/menu")({
  component: MenuPage,
});

const ROW_CLASS = `flex min-h-12 items-center gap-3 px-4 text-sm transition-colors hover:bg-accent ${focusRing}`;

function MenuPage() {
  const mine = useMyBots();
  const channels = useQuery(channelListQueryOptions());
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [isStopping, setIsStopping] = useState(false);
  const bot = mine.bots ? primaryBot(mine.bots, channels.data) : undefined;
  const links = footerLinksFor((mine.bots?.length ?? 0) > 1);

  const handleSignOut = async () => {
    setSignOutError(null);
    try {
      await signOut.mutateAsync();
    } catch (caught) {
      setSignOutError(
        caught instanceof Error ? caught.message : t("Could not log out."),
      );
      return;
    }
    await navigate({ to: "/sign" });
  };

  return (
    <PageShell title={t("Menu")}>
      <div className="flex flex-col gap-6">
        {bot ? (
          <Link
            aria-label={`${bot.name}. ${t("Bot profile")}`}
            className={cn(
              "flex items-center gap-3 rounded-xl border border-border p-3 transition-colors hover:bg-accent",
              focusRing,
            )}
            search={{ agent: bot.id }}
            to="/agents"
          >
            <BotAvatar seed={bot.avatarSeed} size={44} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-semibold text-base">
                {bot.name}
              </span>
              <span className="text-muted-foreground text-xs">
                {t("Bot profile")}
              </span>
            </span>
            <IconChevronRight
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
          </Link>
        ) : (
          <Skeleton className="h-[70px] rounded-xl" />
        )}

        <MenuGroup>
          {links.map(({ icon: Icon, label, to }) => (
            <li key={to}>
              <Link className={ROW_CLASS} to={to}>
                <Icon aria-hidden="true" className="size-5 shrink-0" />
                {t(label)}
              </Link>
            </li>
          ))}
          <li>
            <Link className={ROW_CLASS} to="/settings">
              <IconSettings aria-hidden="true" className="size-5 shrink-0" />
              {t("Settings")}
            </Link>
          </li>
          {currentUser?.role === "admin" ? (
            <li>
              <Link className={ROW_CLASS} to="/admin">
                <IconShieldLock
                  aria-hidden="true"
                  className="size-5 shrink-0"
                />
                {t("Admin")}
              </Link>
            </li>
          ) : null}
        </MenuGroup>

        <MenuGroup>
          <li>
            <button
              className={cn(ROW_CLASS, "w-full text-left")}
              onClick={() => setIsStopping(true)}
              type="button"
            >
              <IconPlayerStop aria-hidden="true" className="size-5 shrink-0" />
              {t("Stop everything")}
            </button>
          </li>
          <li>
            <button
              className={cn(ROW_CLASS, "w-full text-left text-destructive")}
              disabled={signOut.isPending}
              onClick={handleSignOut}
              type="button"
            >
              <IconLogout aria-hidden="true" className="size-5 shrink-0" />
              {signOut.isPending ? t("Logging out…") : t("Log out")}
            </button>
          </li>
        </MenuGroup>
        {signOutError ? (
          <p className="text-destructive text-sm" role="alert">
            {signOutError}
          </p>
        ) : null}
      </div>
      <StopAllDialog onOpenChange={setIsStopping} open={isStopping} />
    </PageShell>
  );
}

function MenuGroup({ children }: { children: ReactNode }) {
  return (
    <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
      {children}
    </ul>
  );
}
