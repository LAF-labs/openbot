import { useSyncExternalStore } from "react";

/**
 * HOW MUCH OF THE WINDOW THE BOT'S SCREEN IS ALLOWED, AND WHETHER IT IS FOLDED AWAY.
 *
 * The pane beside a conversation was a fixed 320px with no way to change it: glancing at what a Bot
 * was doing cost the same 320px whether the Bot was mid-way through a login or had been idle for an
 * hour, and the only control was 닫기 — which also stops the pane telling you anything at all.
 *
 * So there are two settings, and they are different questions. SIZE is how much room the picture
 * deserves right now. FOLDED is whether the picture is wanted at all; folded, the pane keeps one
 * line saying where the Bot is (`screenLine`) and the conversation gets the rest.
 *
 * ONE PERSON PER DEPLOYMENT (CLAUDE.md), so `localStorage` is the whole store — no row, no route,
 * no sync. Every read and every write is wrapped: a private window, blocked site data or a quota
 * that is full throws on the getter itself, and a pane that will not draw because it could not read
 * a preference is a worse failure than a pane at its default width. Both directions fall back to
 * `DEFAULT`, which is exactly what shipped before this module existed.
 */

export type ScreenPanelSize = "small" | "medium" | "large";

export type ScreenPanel = {
  size: ScreenPanelSize;
  isFolded: boolean;
};

/**
 * The three widths, in pixels.
 *
 * `medium` is 320 — `DEFAULT_DETAIL_WIDTH`, what the pane has always been, so a person who never
 * touches the control sees no change. `small` is 240, the narrowest a 4:3 thumbnail stays readable
 * at inside the card's padding; `large` is 440, which is what the pane used to widen to for
 * watching before that was taken out for eating the conversation.
 */
export const SCREEN_PANEL_WIDTHS: Readonly<Record<ScreenPanelSize, number>> = {
  small: 240,
  medium: 320,
  large: 440,
};

/**
 * Folded: wide enough for the one line and the button that unfolds it, and no wider.
 *
 * Measured against the longest sentence this strip can hold — "봇이 보고 있던 페이지를 닫았습니다."
 * — which wraps to three lines at 200px inside the pane's padding. That is a strip, not a panel,
 * and it is 120px of conversation back at the medium size.
 */
export const FOLDED_WIDTH = 200;

export const DEFAULT_SCREEN_PANEL: ScreenPanel = {
  size: "medium",
  isFolded: false,
};

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
      isFolded:
        typeof stored?.isFolded === "boolean"
          ? stored.isFolded
          : DEFAULT_SCREEN_PANEL.isFolded,
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

/** Test seam: forget what this module is holding, so a case starts from storage as a tab does. */
export function forgetScreenPanel(): void {
  current = null;
  for (const watcher of watchers) watcher();
}

export function useScreenPanel(): ScreenPanel {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/**
 * THE WINDOW THE PANE IS BEING DRAWN IN, because below `lg` it is not a column at all.
 *
 * `DetailPanel` lays the pane OVER the conversation under 64rem rather than beside it. Two things
 * follow, and both are why the chosen size is not simply handed through at every width:
 *
 *  - A narrower overlay gives the conversation nothing: it is covered either way. The only setting
 *    that buys anything on a phone is folding, and that one buys more there, not less.
 *  - `large` is 440px, which is wider than a 390px phone. The pane is absolutely positioned and its
 *    parent clips, so the overflow is not a scrollbar — it is the whole conversation covered by a
 *    panel that cannot be seen past. Either way it is 440px of a 390px window.
 *
 * So below `lg` the size control is ignored and the pane takes `medium`, capped so a strip of the
 * conversation stays visible behind it — that strip is what says the conversation is still there.
 */
const WIDE_QUERY = "(min-width: 64rem)";

/** The conversation left showing beside an overlaid pane, so it reads as covered and not gone. */
const NARROW_GUTTER = 48;

export function screenPanelWidth(
  panel: ScreenPanel,
  { isWide, viewportWidth }: { isWide: boolean; viewportWidth: number },
): number {
  const chosen = panel.isFolded
    ? FOLDED_WIDTH
    : SCREEN_PANEL_WIDTHS[isWide ? panel.size : "medium"];
  if (isWide || !Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return chosen;
  }
  // Never below the folded strip: a pane too narrow to read is worse than one that covers more.
  return Math.max(
    FOLDED_WIDTH,
    Math.min(chosen, viewportWidth - NARROW_GUTTER),
  );
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
 * The window, as the pane has to care about it.
 *
 * Read by the panel itself as well as by the width: below `lg` the size control changes nothing, so
 * the panel does not draw it. A control that saves and does nothing is worse than no control
 * (CLAUDE.md) — three buttons that a phone quietly ignores is exactly that.
 */
export function useScreenPanelViewport(): Viewport {
  return useSyncExternalStore(
    subscribeToViewport,
    viewportSnapshot,
    () => WIDE_VIEWPORT,
  );
}

/** The pane's width in pixels: the person's choice, as far as this window can honour it. */
export function useScreenPanelWidth(): number {
  return screenPanelWidth(useScreenPanel(), useScreenPanelViewport());
}
