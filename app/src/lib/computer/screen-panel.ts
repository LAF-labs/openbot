import { useSyncExternalStore } from "react";

/**
 * WHETHER THE BOT'S LIVE SCREEN IS OPEN, AND HOW MUCH OF THE WINDOW IT MAY HAVE.
 *
 * OPEN IS THE PERSON'S, AND ONLY THE PERSON'S. The screen used to open itself whenever the Bot used
 * its browser and whenever it waited for somebody; closing it lasted until the next step. Now it
 * opens when a person asks — the header's button, a task card, the banner, a request for help — and
 * nothing else writes `isOpen: true`. The live view closes itself when there is no page to show
 * (`live-view.tsx`); that writes `false`, and false stays until somebody asks again.
 *
 * Kept per device as a convenience: a person who left it open finds it open after a reload. That is
 * their own choice remembered, not the screen deciding to appear.
 *
 * ONE PERSON PER DEPLOYMENT (CLAUDE.md), so `localStorage` is the whole store — no row, no route,
 * no sync. Every read and every write is wrapped: a private window, blocked site data or a quota
 * that is full throws on the getter itself, and a screen that will not draw because it could not
 * read a preference is a worse failure than one at its default width.
 */

export type ScreenPanelSize = "small" | "medium" | "large";

export type ScreenPanel = {
  size: ScreenPanelSize;
  isOpen: boolean;
};

/**
 * The three widths, in pixels.
 *
 * Wider than the pane that opened itself (240 / 320 / 440). That pane sat beside every conversation
 * whether or not anybody was looking, so every pixel it took was taken from the conversation all
 * day. This one is open only because somebody asked to watch a page, and a 1280px page at 320px is
 * text nobody can read.
 */
export const SCREEN_PANEL_WIDTHS: Readonly<Record<ScreenPanelSize, number>> = {
  small: 360,
  medium: 480,
  large: 640,
};

/**
 * What the rest of a wide window keeps beside the screen: the roster column and a conversation
 * still wide enough to read. A size the window cannot honour is narrowed to leave this.
 */
const ROOM_FOR_THE_REST = 700;

export const DEFAULT_SCREEN_PANEL: ScreenPanel = {
  size: "medium",
  isOpen: false,
};

/**
 * While a person drives the browser, the screen takes all the window can spare.
 *
 * Clicking into a 1280px page drawn a third of its size is clicking at a third of the size, and a
 * login is exactly where a mis-click costs something. The conversation keeps `ROOM_FOR_THE_REST`,
 * because the request for help with its "다 했어요" is in it; the screen takes the rest, up to what
 * a page needs.
 *
 * On a wide window that is now the pane BEHIND the driving: since 0.5.3 the page itself is driven on
 * a sheet over the whole window (`DrivingScreen` in `live-view.tsx`), because even this width drew
 * a 1280px login at 43% in a 1280px window (audit item 4). The pane keeps it so that nothing
 * jumps under the sheet, and settles back to the chosen size when the wheel is handed back.
 */
export const DRIVING_MAX_WIDTH = 1_040;

const STORAGE_KEY = "laf.screen-panel";

const SIZES: readonly ScreenPanelSize[] = ["small", "medium", "large"];

function isSize(value: unknown): value is ScreenPanelSize {
  return SIZES.includes(value as ScreenPanelSize);
}

/** What was stored, or the default for anything that is not exactly what this module writes. */
export function parseScreenPanel(raw: string | null): ScreenPanel {
  if (!raw) return DEFAULT_SCREEN_PANEL;
  try {
    const stored = JSON.parse(raw) as Partial<ScreenPanel> | null;
    return {
      size: isSize(stored?.size) ? stored.size : DEFAULT_SCREEN_PANEL.size,
      // An older value carried `isFolded` instead. It is not read: folding went with the pane that
      // opened itself, and "open" was never stored, so the screen starts closed as it always did.
      isOpen:
        typeof stored?.isOpen === "boolean"
          ? stored.isOpen
          : DEFAULT_SCREEN_PANEL.isOpen,
    };
  } catch {
    // Somebody else's key, a half-written value, an older shape: the default is always drawable.
    return DEFAULT_SCREEN_PANEL;
  }
}

function read(): ScreenPanel {
  try {
    return parseScreenPanel(globalThis.localStorage?.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_SCREEN_PANEL;
  }
}

/*
 * HELD IN THE MODULE AS WELL AS IN STORAGE, because `useSyncExternalStore` compares snapshots by
 * identity: a `getSnapshot` that parsed the JSON on every call would hand React a new object every
 * render and loop forever. Storage is where it survives a reload; this is what React watches.
 */
let current: ScreenPanel | null = null;
const watchers = new Set<() => void>();

function snapshot(): ScreenPanel {
  current ??= read();
  return current;
}

/** The server's answer, and the first client render's: neither has a `localStorage` to read. */
const serverSnapshot = (): ScreenPanel => DEFAULT_SCREEN_PANEL;

function subscribe(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => {
    watchers.delete(onChange);
  };
}

export function setScreenPanel(next: ScreenPanel): void {
  current = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Nowhere to keep it. The choice still applies for as long as this tab is open, which is the
    // whole of what a person pressing the button is asking for in the moment they press it.
  }
  for (const watcher of watchers) watcher();
}

/** Open the live screen, or close it. The size stays what it was. */
export function setScreenOpen(isOpen: boolean): void {
  const panel = snapshot();
  if (panel.isOpen === isOpen) return;
  setScreenPanel({ ...panel, isOpen });
}

/** Test seam: forget what this module is holding, so a case starts from storage as a tab does. */
export function forgetScreenPanel(): void {
  current = null;
  for (const watcher of watchers) watcher();
}

/** What the screen is set to now, outside React. */
export function readScreenPanel(): ScreenPanel {
  return snapshot();
}

export function useScreenPanel(): ScreenPanel {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/**
 * THE WINDOW THE SCREEN IS DRAWN IN, because below `lg` it is not a column at all.
 *
 * `DetailPanel` lays its pane OVER the conversation under 64rem rather than beside it. Covered is
 * covered: a narrower overlay gives the conversation nothing back, and `large` is wider than a 390px
 * phone. So below `lg` the screen is a sheet the width of the window — the whole of it, with its own
 * close in the corner — and the size control is not drawn, since it would change nothing.
 */
const WIDE_QUERY = "(min-width: 64rem)";

export function screenPanelWidth(
  panel: ScreenPanel,
  {
    isWide,
    viewportWidth,
    isDriving = false,
  }: { isWide: boolean; viewportWidth: number; isDriving?: boolean },
): number {
  const hasWidth = Number.isFinite(viewportWidth) && viewportWidth > 0;
  if (!isWide && hasWidth) return viewportWidth;
  const chosen = SCREEN_PANEL_WIDTHS[panel.size];
  if (!hasWidth) return chosen;
  // Never below the smallest size: a screen too narrow to see is worse than a narrower conversation.
  const spare = Math.max(
    SCREEN_PANEL_WIDTHS.small,
    viewportWidth - ROOM_FOR_THE_REST,
  );
  if (!isDriving) return Math.min(chosen, spare);
  return Math.max(Math.min(chosen, spare), Math.min(DRIVING_MAX_WIDTH, spare));
}

export type Viewport = { isWide: boolean; viewportWidth: number };

let viewport: Viewport | null = null;

function readViewport(): Viewport {
  if (typeof window === "undefined") return { isWide: true, viewportWidth: 0 };
  return {
    isWide:
      typeof window.matchMedia === "function"
        ? window.matchMedia(WIDE_QUERY).matches
        : true,
    viewportWidth: window.innerWidth,
  };
}

function viewportSnapshot(): Viewport {
  viewport ??= readViewport();
  return viewport;
}

/**
 * Test seam: forget the window this module read, so the next reader asks its own.
 *
 * The value is read once and then only on `resize`, which is right for a tab and wrong for a test
 * process, where every file brings a window of its own: measured 2026-09-24, a file drawn at PC
 * width left the next file's 375px sheet reading as a column.
 */
export function forgetScreenPanelViewport(): void {
  viewport = null;
}

const WIDE_VIEWPORT: Viewport = { isWide: true, viewportWidth: 0 };

function subscribeToViewport(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const tell = () => {
    const next = readViewport();
    // Compared before it is stored: `useSyncExternalStore` re-renders on a new object, and `resize`
    // fires on every pixel of a dragged window edge.
    if (
      viewport &&
      viewport.isWide === next.isWide &&
      viewport.viewportWidth === next.viewportWidth
    ) {
      return;
    }
    viewport = next;
    onChange();
  };
  window.addEventListener("resize", tell);
  /*
   * AND the media query's own event, for the same reason the roster listens to both: `resize` is
   * not delivered to a backgrounded tab, and a window widened while the app was hidden would keep
   * the narrow rule until something else made it look (`app-sidebar/bot-sidebar.tsx`).
   */
  const query =
    typeof window.matchMedia === "function"
      ? window.matchMedia(WIDE_QUERY)
      : null;
  query?.addEventListener("change", tell);
  return () => {
    window.removeEventListener("resize", tell);
    query?.removeEventListener("change", tell);
  };
}

/**
 * The window, as the screen has to care about it.
 *
 * Read by the live view as well as by the width: below `lg` the size control changes nothing, so it
 * is not drawn. A control that saves and does nothing is worse than no control (CLAUDE.md).
 */
export function useScreenPanelViewport(): Viewport {
  return useSyncExternalStore(
    subscribeToViewport,
    viewportSnapshot,
    () => WIDE_VIEWPORT,
  );
}

/** The screen's width in pixels: the person's choice, as far as this window can honour it. */
export function useScreenPanelWidth(isDriving = false): number {
  return screenPanelWidth(useScreenPanel(), {
    ...useScreenPanelViewport(),
    isDriving,
  });
}
