import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { focusRing } from "@/components/ui/focus";
import { isProject } from "@/lib/channels/projects";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 채팅 | 프로젝트 — WHICH OF THE TWO THE SCREEN IS (2026-10-10, record §1, piece 4-2).
 *
 * The screen beside 홈 is the Bot's main conversation or a project, and this is what says which
 * and goes to the other: 채팅 to the main conversation, 프로젝트 to the list of projects. It
 * stands in the top row where the screen begins, on every screen — so from 루틴 or 설정's
 * neighbours the way back to the conversation is one press, where it was a menu.
 *
 * NEITHER IS MARKED ON A SCREEN THAT IS NEITHER. 소식, 목표, 루틴 are places a person went to from
 * the menu; marking 채팅 there would say the conversation is what is on screen.
 *
 * 프로젝트 WEARS A MARK WHILE A PROJECT HAS SOMETHING UNREAD. A project's answer lands while its
 * person is in the main conversation, and nothing else on that screen is about projects. The
 * main conversation's own unread mark is the menu button's, as it was.
 *
 * IT READS THE LIST OF CONVERSATIONS AND TRUSTS NONE OF IT. It is outside the roster's seam (the
 * row is the window's handle, and stays whatever fails): an answer that is not a list is no
 * projects and no mark, never a throw.
 */
export function ScreenSwitch() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const channels = useQuery(channelListQueryOptions());
  const list: readonly unknown[] = Array.isArray(channels.data)
    ? channels.data
    : [];
  const projects = list.filter(
    (one): one is { id: string; kind: "project"; unread?: unknown } =>
      one !== null &&
      typeof one === "object" &&
      isProject(one as { kind?: "main" | "project" }) &&
      typeof (one as { id?: unknown }).id === "string",
  );

  const open = pathname.startsWith("/channel/")
    ? pathname.slice("/channel/".length).split("/")[0]
    : null;
  const isOnProject =
    pathname === "/projects" ||
    (open !== null && projects.some((project) => project.id === open));
  // The main conversation: its own address, the address that opens on it, or a new one.
  const isOnChat = pathname === "/" || (open !== null && !isOnProject);
  const hasUnread = projects.some((project) => project.unread === true);

  return (
    <nav
      aria-label={t("Chat or projects")}
      className="flex h-8 shrink-0 items-center rounded-full bg-muted p-0.5 text-sm"
      data-screen-switch
    >
      <Link
        aria-current={isOnChat ? "page" : undefined}
        className={cn(PART, isOnChat ? ON : OFF, focusRing)}
        data-screen="chat"
        to="/"
      >
        {t("Chat")}
      </Link>
      <Link
        aria-current={isOnProject ? "page" : undefined}
        className={cn(PART, isOnProject ? ON : OFF, focusRing)}
        data-screen="projects"
        to="/projects"
      >
        {t("Projects")}
        {hasUnread ? (
          <>
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full bg-mark"
              data-mark="new"
            />
            <span className="sr-only">{t("Unread")}</span>
          </>
        ) : null}
      </Link>
    </nav>
  );
}

const PART =
  "flex h-7 items-center gap-1.5 rounded-full px-3 font-medium transition-colors";
const ON = "bg-background text-foreground shadow-sm";
const OFF = "text-muted-foreground hover:text-foreground";
