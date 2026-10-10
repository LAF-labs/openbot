import { type QueryKey, useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";
import { BotPresenceLink } from "@/components/layout/bot-presence-link";
import { HomeButton } from "@/components/layout/home-panel";
import { ProfileMenu } from "@/components/layout/profile-menu";
import { ReadNotice } from "@/components/layout/read-states";
import { SectionBoundary } from "@/components/layout/section-boundary";
import { UpdateNotice } from "@/components/layout/update-notice";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { rosterNotice } from "@/lib/agents/roster-state";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { inShell } from "@/lib/notifications/shell";
import { useReading } from "@/lib/reading";
import { cn } from "@/lib/utils";

/**
 * THE ONE ROW AT THE TOP OF THE APP (2026-10-10, `docs/laf/redesign-2026-10.md` §1, piece 3-1).
 *
 * The column that stood at the left — the Bot, its conversation, 소식 · 아이디어 · 목표 · 만든 것,
 * and a menu at its foot — is gone, and what it led to is behind the picture at the right end of
 * this row (`profile-menu.tsx`). The screen under it is the whole width of the window.
 *
 * IT IS THE WINDOW'S HANDLE, WHICH NO TEST AND NO BROWSER SHOWS. The installed app draws its
 * traffic lights over the page (`titleBarStyle: "Overlay"`, `desktop/src-tauri/tauri.conf.json`)
 * and has no bar of its own to be dragged by. The column's title row was that bar, on every
 * screen; with the column gone and nothing in its place the window could not be moved from 소식
 * or 목표 at all, with every check green. So this row carries `data-tauri-drag-region` — Tauri
 * drags only from an element that carries it itself, so the empty stretch in the middle does too —
 * is the height the lights sit in (`h-titlebar`), and in the shell leaves their width empty at
 * its left. All three are inert in a browser tab, where the row is simply where the menu is.
 *
 * ONE ROW, NOT TWO. A conversation already had a row of its own — the Bot's name, what it is
 * doing, its buttons (`channels/bot-header.tsx`), and it too was a handle. Drawn under this one,
 * the PC app's smallest window (1024×640) would give 92px to two bars. So the left of this row is
 * a place the screen below fills (`useTopBarSlot`), and a conversation puts its header there.
 * A screen with a title of its own in its page leaves it empty, which is a longer handle.
 *
 * ITS LEFT CELL IS AS WIDE AS 홈 (2026-10-10, piece 3-2). The panel at the left of the window
 * (`home-panel.tsx`) stands under this row, and the row is still one bar from edge to edge — one
 * handle. But what a screen draws into the row has to start where that screen starts, or a
 * conversation's name would stand over 홈 and its buttons a window away from it. So the row's
 * first cell — the lights' width in the shell, then the home button — is never narrower than the
 * panel (`--home-panel-width`, set on the app's frame), and shrinks to the button when 홈 is
 * folded. The cell is the row's and carries the attribute itself: it is most of the handle while
 * 홈 is wide.
 *
 * WHAT IS NOT HERE YET, each with a piece of its own: the switch between 채팅 and 프로젝트, and
 * the search (pieces 4-2, 4-3).
 */

/** The width the macOS window buttons take at the row's left, in the shell: three lights and air. */
const LIGHTS_CLEARANCE = "ps-20";

const TopBarSlot = createContext<HTMLElement | null>(null);

/**
 * Whatever a screen puts at the left of the top row — or, where there is no row above it (a test
 * that mounts the screen alone), nothing: the caller draws its own.
 */
export function useTopBarSlot(): HTMLElement | null {
  return useContext(TopBarSlot);
}

export function AppTopBar({
  children,
  narrowBar,
  rosterQueries,
}: {
  /** The screen under the row, which may fill the row's left (`useTopBarSlot`). */
  children: ReactNode;
  /**
   * The bar a narrow window has under the screen (`phone-tab-bar.tsx`). It reads the roster as the
   * menu does, so it is drawn inside the menu's seam — one failure, said once, reported once —
   * and laid out where it always was, under the screen.
   */
  narrowBar?: ReactNode;
  /** What the menu reads: asked for again by 다시 불러오기 when the menu could not be drawn. */
  rosterQueries: readonly QueryKey[];
}) {
  /*
   * The place itself, kept in state rather than a ref: what is drawn into it has to be drawn again
   * once it exists, and a ref read while rendering is one of the things that leaves a component
   * uncompiled (CLAUDE.md, "The React Compiler compiles the app").
   */
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  /** Where the narrow window's bar is laid out: under the screen, though drawn from the row's seam. */
  const [under, setUnder] = useState<HTMLElement | null>(null);
  /*
   * A conversation fills the row's left with its own header, which names the Bot and says what it
   * is doing. Everywhere else the row says so itself (`BotPresenceLink`) — drawn here and not by
   * each screen, so a screen added next month cannot forget it.
   */
  const isConversation = useRouterState({
    select: (state) => state.location.pathname.startsWith("/channel/"),
  });
  const agents = useQuery(agentListQueryOptions());
  const channels = useQuery(channelListQueryOptions());
  /*
   * A LIST THAT COULD NOT BE READ IS SAID, AND CAN BE ASKED FOR AGAIN. The column said so above
   * its rows; the menu draws from the same two lists and is closed most of the time, so the line
   * stands under the row. It takes no room while there is nothing to say.
   */
  const bots = useReading(agents);
  const conversations = useReading(channels);
  const line = rosterNotice({ bots, conversations });
  const handleRetry = () => {
    if (bots.state === "failed") void agents.refetch();
    if (conversations.state === "failed") void channels.refetch();
  };

  return (
    <TopBarSlot.Provider value={slot}>
      <header
        // At least the height the window buttons sit in; taller only while a line stands in it.
        className="flex min-h-titlebar shrink-0 select-none items-center gap-2 bg-background pe-2"
        data-app-top-bar
        data-tauri-drag-region
      >
        <div
          className={cn(
            "flex h-full shrink-0 items-center lg:min-w-[calc(var(--home-panel-width)_-_0.5rem)]",
            // Eased with the panel under it, and not at all while its edge follows a hand.
            "transition-[min-width] duration-300 ease-out group-data-resizing/frame:transition-none motion-reduce:transition-none",
            inShell() ? LIGHTS_CLEARANCE : "ps-2",
          )}
          data-tauri-drag-region
          data-top-bar-home
        >
          <HomeButton />
        </div>
        <div
          className="flex h-full min-w-0 flex-1 items-center gap-2"
          data-tauri-drag-region
          ref={setSlot}
        />
        {/* Only while there is a newer version: an icon, and its sentence a hover away. */}
        <UpdateNotice shape="icon" />
        {/*
         * ONE SEAM FOR WHAT READS THE ROSTER: the Bot at the row's left, the menu at its right,
         * and the bar a narrow window has under the screen (drawn from here, laid out there).
         * All draw from the Bots and the conversations, and a throw on that answer used to be the
         * column's, caught beside the screen and not with it. It still is: with either unable to
         * be drawn, one line stands in the row for both, with a way to ask again, and the screen
         * under the row goes on working.
         *
         * THE BOT IS DRAWN INTO THE ROW'S LEFT, NOT MOVED THERE BY CSS. It is the seam's child and
         * stands at the other end of the row; `order` would put it there for the eye and leave it
         * after the update icon for the Tab key, so it is drawn into the place itself — the same
         * place a conversation draws its header into — and a portal keeps the seam it came from.
         */}
        <SectionBoundary
          className="min-w-0"
          layout="line"
          queryKeys={rosterQueries}
          section="sidebar"
        >
          {!isConversation && slot
            ? createPortal(<BotPresenceLink />, slot)
            : null}
          <ProfileMenu />
          {narrowBar && under ? createPortal(narrowBar, under) : null}
        </SectionBoundary>
      </header>
      {/* Mounted before it speaks, as the column had it: a line that arrives with its element is not heard. */}
      <ReadNotice
        className="justify-center px-4 pb-2 text-center"
        hasButton
        line={line}
        onRetry={handleRetry}
        size="compact"
      />
      {children}
      {/* No box of its own: what is drawn into it is the layout's child, as the bar always was. */}
      <div className="contents" ref={setUnder} />
    </TopBarSlot.Provider>
  );
}
