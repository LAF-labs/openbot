import { useSyncExternalStore } from "react";

/**
 * WHETHER THE HOME PANEL IS OPEN, AND HOW WIDE THE PERSON LEFT IT.
 *
 * The panel is the column of widgets at the left of the PC app (`docs/laf/redesign-2026-10.md`
 * §1). The home button folds it away entirely and brings it back; its right edge is dragged
 * between a fifth of the window and seven tenths of it.
 *
 * KEPT PER DEVICE, in `localStorage`, which the record chose by name: a width is one person's
 * convenience on one screen, and a laptop's is not a monitor's. No row, no route, no sync. Every
 * read and every write is wrapped, as `screen-panel.ts` wraps its own: a private window or blocked
 * site data throws on the getter itself, and a panel at its default width is always drawable.
 *
 * THE WIDTH IS WHAT THE PERSON CHOSE, NOT WHAT IS DRAWN. What is drawn is that number held between
 * the two bounds by the stylesheet (`--spacing-home-panel`), so a window made narrower afterwards
 * narrows the panel without anything here hearing about it. `null` is "never dragged": a fifth of
 * the window, which the stylesheet also knows.
 */
export type HomePanel = {
  isOpen: boolean;
  /** In pixels, or `null` before the edge has ever been dragged. */
  width: number | null;
};

export const DEFAULT_HOME_PANEL: HomePanel = { isOpen: true, width: null };

/** The panel is never narrower than this, and never narrower than a fifth of the window. */
export const HOME_PANEL_MIN_WIDTH = 280;

/**
 * What the screen beside a fully opened panel keeps. The PC app's smallest window is 1024px, where
 * seven tenths would leave a 307px conversation, and the conversation's cards are drawn for a
 * phone's 360.
 */
export const ROOM_FOR_THE_SCREEN = 360;

/** One press of an arrow key on the panel's edge. */
export const HOME_PANEL_STEP = 16;

const STORAGE_KEY = "laf.home-panel";

/**
 * The same two bounds the stylesheet holds, for the moment a width is chosen: without them a drag
 * past the far bound stored a number the stylesheet then held still, and dragging back did nothing
 * until the pointer had crossed all of it again.
 */
export function clampHomePanelWidth(
  width: number,
  viewportWidth: number,
): number {
  const least = Math.max(viewportWidth * 0.2, HOME_PANEL_MIN_WIDTH);
  const most = Math.min(
    viewportWidth * 0.7,
    viewportWidth - ROOM_FOR_THE_SCREEN,
  );
  // On a window too narrow for both, the least wins — as `clamp()` decides it in the stylesheet.
  return Math.round(Math.max(least, Math.min(width, most)));
}

/** What was stored, or the default for anything that is not exactly what this module writes. */
export function parseHomePanel(raw: string | null | undefined): HomePanel {
  if (!raw) return DEFAULT_HOME_PANEL;
  try {
    const stored = JSON.parse(raw) as Partial<HomePanel> | null;
    return {
      isOpen:
        typeof stored?.isOpen === "boolean"
          ? stored.isOpen
          : DEFAULT_HOME_PANEL.isOpen,
      width:
        typeof stored?.width === "number" &&
        Number.isFinite(stored.width) &&
        stored.width > 0
          ? stored.width
          : DEFAULT_HOME_PANEL.width,
    };
  } catch {
    // Somebody else's key, a half-written value, an older shape: the default is always drawable.
    return DEFAULT_HOME_PANEL;
  }
}

function read(): HomePanel {
  try {
    return parseHomePanel(globalThis.localStorage?.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_HOME_PANEL;
  }
}

/*
 * HELD IN THE MODULE AS WELL AS IN STORAGE, because `useSyncExternalStore` compares snapshots by
 * identity: a `getSnapshot` that parsed the JSON on every call would hand React a new object every
 * render and loop forever.
 */
let current: HomePanel | null = null;
const watchers = new Set<() => void>();

function snapshot(): HomePanel {
  current ??= read();
  return current;
}

const serverSnapshot = (): HomePanel => DEFAULT_HOME_PANEL;

function subscribe(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => {
    watchers.delete(onChange);
  };
}

function setHomePanel(next: HomePanel): void {
  current = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Nowhere to keep it. The choice still applies for as long as this window is open.
  }
  for (const watcher of watchers) watcher();
}

/** Fold the panel away, or bring it back. The width stays what it was. */
export function setHomePanelOpen(isOpen: boolean): void {
  const panel = snapshot();
  if (panel.isOpen === isOpen) return;
  setHomePanel({ ...panel, isOpen });
}

/** The width a person dragged or stepped the edge to, held to what this window allows. */
export function setHomePanelWidth(width: number, viewportWidth: number): void {
  const panel = snapshot();
  const next = clampHomePanelWidth(width, viewportWidth);
  if (panel.width === next) return;
  setHomePanel({ ...panel, width: next });
}

/** Test seam: forget what this module is holding, so a case starts from storage as a tab does. */
export function forgetHomePanel(): void {
  current = null;
  for (const watcher of watchers) watcher();
}

export function useHomePanel(): HomePanel {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
