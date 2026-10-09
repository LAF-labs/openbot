import { Link, useRouterState } from "@tanstack/react-router";
import { focusRing } from "@/components/ui/focus";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 채팅 | 프로젝트, AT THE TOP OF THE SCREEN (`docs/laf/redesign-2026-10.md` §1; the reference is
 * Hark's control in the same place).
 *
 * The one main conversation, or the list of projects beside it. It is the sign of where a person
 * is and the way to the other, so each half is a link and the one that is here says so
 * (`aria-current`). On a screen that is neither — 소식, 설정 — neither half is lit: the control
 * still takes a person back to either.
 *
 * ON A PC ONLY. A phone has 홈 | 채팅 in the same place (`phone-pager.tsx`), which are pages of one
 * scroller rather than places; 프로젝트 joins them there when there are projects.
 */
const SEGMENT_CLASS = cn(
  "flex h-7 items-center rounded-full px-3.5 text-sm transition-colors",
  focusRing,
);

export function ViewSwitcher() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const isChat = pathname === "/" || pathname.startsWith("/channel");
  const isProjects = pathname.startsWith("/projects");

  return (
    <nav
      aria-label={t("Chat or projects")}
      className="col-start-2 flex h-8 shrink-0 select-none items-center rounded-full border border-glass-border bg-glass p-0.5 backdrop-blur-xl max-md:hidden"
      data-view-switcher
    >
      <Link
        aria-current={isChat ? "page" : undefined}
        className={cn(
          SEGMENT_CLASS,
          isChat
            ? "bg-foreground font-medium text-background"
            : "text-muted-foreground hover:text-foreground",
        )}
        to="/"
      >
        {t("Chat")}
      </Link>
      <Link
        aria-current={isProjects ? "page" : undefined}
        className={cn(
          SEGMENT_CLASS,
          isProjects
            ? "bg-foreground font-medium text-background"
            : "text-muted-foreground hover:text-foreground",
        )}
        to="/projects"
      >
        {t("Projects")}
      </Link>
    </nav>
  );
}
