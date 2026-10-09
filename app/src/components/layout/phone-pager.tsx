import { useRouterState } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  type UIEvent,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { focusRing } from "@/components/ui/focus";
import { t } from "@/lib/i18n";
import { useIsKeyboardUp } from "@/lib/use-keyboard-up";
import { cn } from "@/lib/utils";

/**
 * A PHONE'S SCREENS, SIDE BY SIDE AND SWIPED BETWEEN LIKE PHOTOGRAPHS: 홈, THEN 채팅
 * (`docs/laf/redesign-2026-10.md` §1 모바일; the reference is Hark's phone app).
 *
 * The bar at the bottom had six tabs and each was a route. The two here are not routes: they are
 * two parts of one window — the home panel and the screen — that a PC draws beside each other and
 * a phone has room for one of. So the pager is a scroller with scroll-snap, the way the record
 * asks: the web view does the inertia and the stop, and no gesture code of ours fights iOS.
 *
 * TWO PAGES, AND 프로젝트 WILL BE THE THIRD when there are projects; a page that could do nothing
 * is not a page.
 *
 * NOTHING HERE TOUCHES THE HISTORY. A swipe and a press on a tab both only move the scroller, so a
 * browser's back never walks between 홈 and 채팅 — on a phone's browser the edge swipe is the
 * browser's own back, and it has to mean what it means everywhere else.
 *
 * WHAT A PERSON GOES TO IS ALWAYS THE SCREEN. Every place in the menu is a route, drawn on the
 * second page; so a change of route brings that page in front, wherever the pager stood.
 *
 * NOT WHILE THE KEYBOARD IS UP: a sideways drag over a box being typed in is somebody moving the
 * caret. And a swipe that starts inside something that scrolls sideways itself — a chart, a row
 * of tabs — is that thing's first, which a nested scroller is by default.
 *
 * ON A PC NONE OF THIS IS DRAWN AS A PAGER: the scroller is `md:contents`, so its two children are
 * the layout's own grid items and there is nothing to scroll.
 */
export type PhonePage = "home" | "chat";

type Pager = {
  page: PhonePage;
  goTo: (page: PhonePage) => void;
  setScroller: (element: HTMLElement | null) => void;
  setPage: (page: PhonePage) => void;
};

const PagerContext = createContext<Pager | null>(null);

/** Which page a scroller stands on: the one more than half in view. */
export function pageAt(scrollLeft: number, width: number): PhonePage {
  return width > 0 && scrollLeft < width / 2 ? "home" : "chat";
}

export function PhonePagerProvider({ children }: { children: ReactNode }) {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [page, setPage] = useState<PhonePage>("chat");
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  /*
   * 채팅 FIRST, BEFORE ANYTHING IS PAINTED: a scroller starts at its left edge, which is 홈, and
   * an effect after paint would show 홈 for a frame on every launch. And again whenever the route
   * changes — `pathname` is read so that it does.
   *
   * INSTANTLY, SAID OUT LOUD. The scroller is `scroll-smooth` for the tabs' sake, and that makes a
   * plain `scrollLeft =` an animation too: every launch slid in from 홈 (measured — and where no
   * frame is drawn, never arrived at all).
   */
  useLayoutEffect(() => {
    if (!scroller || pathname === undefined) return;
    scroller.scrollTo({ left: scroller.clientWidth, behavior: "instant" });
  }, [scroller, pathname]);
  useEffect(() => {
    if (pathname !== undefined) setPage("chat");
  }, [pathname]);

  const goTo = (next: PhonePage) => {
    // Smoothly where motion is welcome: the scroller's own `scroll-smooth` decides, not this call.
    scroller?.scrollTo({ left: next === "home" ? 0 : scroller.clientWidth });
    setPage(next);
  };

  return (
    <PagerContext value={{ page, goTo, setScroller, setPage }}>
      {children}
    </PagerContext>
  );
}

/** The scroller. Its children are the pages, each the scroller's whole width. */
export function PhonePager({ children }: { children: ReactNode }) {
  const pager = useContext(PagerContext);
  const isKeyboardUp = useIsKeyboardUp();

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const { scrollLeft, clientWidth } = event.currentTarget;
    pager?.setPage(pageAt(scrollLeft, clientWidth));
  };

  return (
    <div
      className={cn(
        "row-start-2 flex min-h-0 snap-x snap-mandatory overscroll-x-contain scroll-smooth motion-reduce:scroll-auto md:contents",
        isKeyboardUp ? "overflow-x-hidden" : "overflow-x-auto",
      )}
      data-phone-pager
      onScroll={handleScroll}
      ref={pager?.setScroller}
    >
      {children}
    </div>
  );
}

/** A page's place: the scroller's whole width on a phone, and nothing of the pager's on a PC. */
export const PHONE_PAGE_CLASS =
  "max-md:w-full max-md:shrink-0 max-md:snap-start";

const TAB_CLASS = cn(
  "flex h-7 items-center rounded-full px-3.5 text-sm transition-colors",
  focusRing,
);

/**
 * 홈 | 채팅, in the middle of the row at the top: the sign of which page is in front, and the way
 * to the other for somebody who does not swipe. Buttons, not links — they go nowhere a link could.
 */
export function PhonePagerTabs() {
  const pager = useContext(PagerContext);
  if (!pager) return null;
  const tabs = [
    { page: "home", label: t("Home") },
    { page: "chat", label: t("Chat") },
  ] as const;

  return (
    <div
      aria-label={t("Home or chat")}
      className="col-start-2 flex h-8 shrink-0 select-none items-center rounded-full border border-glass-border bg-glass p-0.5 backdrop-blur-xl md:hidden"
      data-phone-tabs
      role="tablist"
    >
      {tabs.map(({ page, label }) => (
        <button
          aria-selected={pager.page === page}
          className={cn(
            TAB_CLASS,
            pager.page === page
              ? "bg-foreground font-medium text-background"
              : "text-muted-foreground",
          )}
          key={page}
          onClick={() => pager.goTo(page)}
          role="tab"
          type="button"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
