import { createContext, useContext, useSyncExternalStore } from "react";
import {
  CONVERSATION_MIN,
  useScreenPanelViewport,
  type Viewport,
} from "@/lib/computer/screen-panel";

/**
 * 홈: WHETHER THE PANEL AT THE LEFT OF THE WINDOW IS OPEN, AND HOW WIDE (2026-10-10, record §1,
 * piece 3-2).
 *
 * The record's sentence, in numbers. Open, the panel is a fifth of the window and never under
 * 280px; a person may drag it as wide as seven tenths, but never so wide that the conversation
 * beside it is left under 360 (`CONVERSATION_MIN`) — the installed app's smallest window is 1024,
 * and seven tenths of that would leave 307. Folded, it is nothing at all: the home button in the
 * top row is what brings it back.
 *
 * 홈 GIVES WAY TO WHAT IS OPEN AT THE RIGHT OF THE SCREEN. A conversation can have the Bot's live
 * screen beside it (360 / 480 / 640), or its settings; 루틴 and 스킬 open a detail the same way
 * (`layout/detail-panel.tsx`). Those are things somebody just asked to see, and 홈 is there all
 * day — so each tells this module the width it took (`takeBesideMain`), 홈 is drawn no wider than
 * what is left after the conversation's least, and where what is left is under 홈's own least it
 * is not drawn until the other thing closes. Measured at the smallest window: with the screen at
 * its smallest (360) 홈 keeps 304; at the middle size (480) and the largest (640) 홈 steps aside
 * and the conversation has 544 and 384. What the person chose is not forgotten by any of this.
 *
 * NOT DRAWN BELOW `lg`. That is exactly the installed window's floor; under it is a browser
 * narrower than the PC app can be, which this app is not made for (owner, 2026-10-10).
 *
 * ONE PERSON PER DEPLOYMENT (CLAUDE.md), so `localStorage` is the whole store, as it is for the
 * Bot's screen (`lib/computer/screen-panel.ts`, which this follows line for line): every read and
 * write is wrapped, and anything that is not exactly what this module writes is the default.
 */

export type HomePanel = {
  isOpen: boolean;
  /** Pixels, as dragged; null until somebody drags it, which is "a fifth of the window". */
  width: number | null;
};

/** The least 홈 is drawn at. Under this it is not a narrower panel, it is no panel. */
export const HOME_PANEL_MIN = 280;
/** Undragged: a fifth of the window. */
const DEFAULT_SHARE = 0.2;
/** Dragged: no more than seven tenths of it. */
const MAX_SHARE = 0.7;

export const DEFAULT_HOME_PANEL: HomePanel = { isOpen: true, width: null };

const STORAGE_KEY = "laf.home-panel";

/** What was stored, or the default for anything that is not exactly what this module writes. */
export function parseHomePanel(raw: string | null): HomePanel {
  if (!raw) return DEFAULT_HOME_PANEL;
  try {
    const stored = JSON.parse(raw) as Partial<HomePanel> | null;
    const width = stored?.width;
    return {
      isOpen:
        typeof stored?.isOpen === "boolean"
          ? stored.isOpen
          : DEFAULT_HOME_PANEL.isOpen,
      // A number a window could be, or the default: never NaN, a string or a negative into a width.
      width:
        typeof width === "number" && Number.isFinite(width) && width > 0
          ? width
          : null,
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
 * HELD IN THE MODULE AS WELL AS IN STORAGE: `useSyncExternalStore` compares snapshots by identity,
 * and a `getSnapshot` that parsed the JSON on every call would hand React a new object every
 * render (`screen-panel.ts` says the same of its own).
 */
let current: HomePanel | null = null;
const watchers = new Set<() => void>();

function snapshot(): HomePanel {
  current ??= read();
  return current;
}

function subscribe(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => {
    watchers.delete(onChange);
  };
}

function tell(): void {
  for (const watcher of watchers) watcher();
}

export function setHomePanel(next: HomePanel): void {
  current = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Nowhere to keep it. The choice still holds for as long as this window is open.
  }
  tell();
}

/** Open 홈, or fold it. The width stays what it was. */
export function setHomeOpen(isOpen: boolean): void {
  const panel = snapshot();
  if (panel.isOpen === isOpen) return;
  setHomePanel({ ...panel, isOpen });
}

/** The width somebody dragged it to. Dragging is done on an open panel, so it stays open. */
export function setHomeWidth(width: number): void {
  setHomePanel({ isOpen: true, width });
}

/*
 * WHAT IS OPEN AT THE RIGHT OF THE SCREEN, IN PIXELS. In the module and not in storage: it is true
 * of this window for as long as the thing is open and of nothing after. Each taker is kept apart,
 * so two panes closing in either order leave the right number.
 */
const takers = new Map<symbol, number>();
let taken = 0;

/**
 * Say that `width` pixels beside the conversation are in use; the answer takes it back.
 *
 * Called from an effect by whatever lays a pane beside the conversation, with the answer returned
 * as that effect's cleanup.
 */
export function takeBesideMain(width: number): () => void {
  const taker = Symbol("beside-main");
  takers.set(taker, Math.max(0, width));
  retally();
  return () => {
    takers.delete(taker);
    retally();
  };
}

function retally(): void {
  let next = 0;
  for (const width of takers.values()) next += width;
  if (next === taken) return;
  taken = next;
  tell();
}

const takenSnapshot = (): number => taken;

/** What 홈 is set to now, outside React. */
export function readHomePanel(): HomePanel {
  return snapshot();
}

/** Test seam: forget what this module is holding, so a case starts from storage as a tab does. */
export function forgetHomePanel(): void {
  current = null;
  takers.clear();
  taken = 0;
  tell();
}

/** The widest 홈 may be in this window, with `besideMain` pixels in use at the screen's right. */
export function homePanelMax(viewportWidth: number, besideMain = 0): number {
  return Math.floor(
    Math.min(
      viewportWidth * MAX_SHARE,
      viewportWidth - CONVERSATION_MIN - besideMain,
    ),
  );
}

/**
 * How wide 홈 is drawn, in pixels. Nothing when it is folded, when the window is narrower than the
 * PC app can be, and when what is open at the right leaves it less than its least.
 */
export function homePanelWidth(
  panel: HomePanel,
  { isWide, viewportWidth }: Viewport,
  besideMain = 0,
): number {
  if (!panel.isOpen || !isWide) return 0;
  // Before the first measurement — a test with no window — there is nothing to fit it to.
  if (!(Number.isFinite(viewportWidth) && viewportWidth > 0)) {
    return Math.max(panel.width ?? HOME_PANEL_MIN, HOME_PANEL_MIN);
  }
  const max = homePanelMax(viewportWidth, besideMain);
  if (max < HOME_PANEL_MIN) return 0;
  const chosen = panel.width ?? viewportWidth * DEFAULT_SHARE;
  return Math.round(Math.min(Math.max(chosen, HOME_PANEL_MIN), max));
}

export function useHomePanel(): HomePanel {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_HOME_PANEL);
}

function useTakenBesideMain(): number {
  return useSyncExternalStore(subscribe, takenSnapshot, () => 0);
}

/**
 * 홈 as this window can draw it: how wide it is now, how wide it may be dragged, and whether there
 * is room for it at all — which is what the home button has to say when there is not.
 */
export function useHomePanelFit(): {
  isOpen: boolean;
  width: number;
  max: number;
  hasRoom: boolean;
} {
  const panel = useHomePanel();
  const viewport = useScreenPanelViewport();
  const besideMain = useTakenBesideMain();
  const width = homePanelWidth(panel, viewport, besideMain);
  // A window that has not said how wide it is yet has no limit to state: the panel's own width.
  const isMeasured =
    Number.isFinite(viewport.viewportWidth) && viewport.viewportWidth > 0;
  const max = isMeasured
    ? homePanelMax(viewport.viewportWidth, besideMain)
    : Math.max(panel.width ?? HOME_PANEL_MIN, HOME_PANEL_MIN);
  return {
    hasRoom: viewport.isWide && max >= HOME_PANEL_MIN,
    isOpen: panel.isOpen,
    max,
    width,
  };
}

/**
 * WHETHER 홈 IS ON THE SCREEN NOW, for a page that would otherwise repeat what it holds.
 *
 * Said by the app's frame, which is what draws the panel (`routes/_authed/_app.tsx`), and not
 * worked out here from the setting: a page drawn with no frame around it — the settings' own
 * layout, a test — has no 홈 beside it whatever was chosen, and would have drawn nothing in the
 * belief that somebody else had.
 */
export const HomeDrawn = createContext(false);

export function useIsHomeDrawn(): boolean {
  return useContext(HomeDrawn);
}
