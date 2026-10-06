/**
 * THE SERVER HAS MOVED PAST THE PAGE, AND THE PAGE CAN TELL.
 *
 * Nothing compared the page's build with the server's until 2026-10-06. A window open before an
 * upgrade kept the old bundle for as long as it stayed open — in the installed app, which lives in
 * the tray, for days — and became the new one only when a route's chunk failed to load
 * (`lib/build-reload.ts`) or the app was restarted. An old bundle against a new server is a pair
 * nobody tests.
 *
 * WHAT IS COMPARED: the commit baked into this page's own document at build
 * (`lib/build/revision-tag.ts`) against the commit the server says it runs NOW
 * (`GET /api/version`). Not the first answer the page happened to read: that one is the server's
 * too, and after an upgrade it names the new build on a page that is the old one. Only commits are
 * compared. The version is `edge` on every build of main and the channel is what was pulled, so
 * neither tells two builds apart.
 *
 * WHEN IT LOOKS: when the window comes into sight or takes the focus, every few minutes while it is
 * in sight, and when the connection to the server comes back — a restart is how an upgrade looks
 * from here, and that look says so in seconds rather than minutes. NEVER WHILE HIDDEN: a window in
 * the tray asks nothing, and is looked at the moment it is brought back. One small request each
 * time, and at most one in half a minute however often the window is flicked to.
 *
 * A FAILED READ IS SILENCE. The server restarting is the moment this exists for, and it is also
 * the moment every request fails: a look that could not be answered raises nothing and lowers
 * nothing. What the server last said stays known until it says something else.
 *
 * A PAGE WITH NO COMMIT NEVER ASKS. The dev server and a local build bake none; there is nothing to
 * compare, so nothing is requested and nothing is ever drawn.
 *
 * THE INSTALLED APP HAS A SECOND KIND OF NEW VERSION, AND THE SAME CONTROL SAYS IT. The shell
 * fetches a newer shell at launch and holds it for a restart (`update_ready` in
 * desktop/src-tauri/src/lib.rs). That fact is kept here beside the server's, so the one control
 * (`components/layout/update-notice.tsx`) has one place to read what it should offer — and a
 * restart wins, because the app that comes back loads the page afresh as well.
 */
import { useSyncExternalStore } from "react";
import { BUILD_REVISION_META } from "@/lib/build/revision-tag";
import { readServerBuild, reloadPage, sessionStore } from "@/lib/build-reload";
import {
  SOCKET_RECONNECTED,
  socketState,
} from "@/lib/channels/use-channel-events";
import {
  onShellUpdateReady,
  shellUpdateReady,
} from "@/lib/notifications/shell";

/** While the window is in sight: often enough to be told the same morning, seldom enough to cost nothing. */
const LOOK_EVERY_MS = 5 * 60_000;
/** The least time between two looks, however many times the window is brought forward. */
const LOOK_AGAIN_AFTER_MS = 30_000;

/** What is known, from which the offer is decided. */
export type BuildFacts = {
  /** The commit this page's bundle was built from, or null where none was baked (development). */
  bundleRevision: string | null;
  /** The commit the server last said it runs: null until it has said, and through every failed read. */
  serverRevision: string | null;
  /** The server's commit this tab has already reloaded for, at the person's press. */
  reloadedFor: string | null;
  /** The version the shell holds for a restart: null in a browser tab, and when it holds none. */
  shellUpdate: string | null;
};

/**
 * What the control offers.
 *
 * `isHeld` is "not now": the Bot is working, or waiting on the person, and the press is withheld
 * until it is neither (`update-notice.tsx` says why a turn is waited out rather than reloaded
 * into).
 */
export type UpdateOffer =
  | { kind: "none" }
  | { kind: "reload"; isHeld: boolean }
  | { kind: "restart"; version: string; isHeld: boolean };

/**
 * The whole decision, as a table (`build-watch.test.ts` walks it).
 *
 *   the shell holds an update            → restart, whatever the page's build
 *   no commit baked into the page        → nothing (development)
 *   the server has not said, or could not → nothing
 *   the same commit                      → nothing
 *   another commit, already reloaded for → nothing: see below
 *   another commit                       → reload
 *   …and the Bot is mid-turn             → the same offer, held
 *
 * RELOADED FOR IT ONCE, AND STILL NOT IT. A reload that does not bring the server's build — the web
 * image and the server's pulled apart, or the press landing in the seconds of an upgrade before the
 * new files are served — would leave a control that reloads into itself for ever. A control that
 * does nothing is worse than none, so having reloaded once for that commit the page stops offering
 * it — until the connection next returns (`watchBuild`, `handleBack`), or the server names another
 * commit.
 */
export function updateOffer(
  facts: BuildFacts & { isBotBusy: boolean },
): UpdateOffer {
  if (facts.shellUpdate) {
    return {
      kind: "restart",
      version: facts.shellUpdate,
      isHeld: facts.isBotBusy,
    };
  }
  const { bundleRevision, serverRevision } = facts;
  if (!bundleRevision || !serverRevision) return { kind: "none" };
  if (bundleRevision === serverRevision) return { kind: "none" };
  if (facts.reloadedFor === serverRevision) return { kind: "none" };
  return { kind: "reload", isHeld: facts.isBotBusy };
}

/** What this module asks of the page. `configureBuildWatch` replaces it in a test. */
export type BuildWatchDeps = {
  /** The commit baked into this page, or null. */
  bundleRevision: () => string | null;
  /** The build the server runs now, or null when it could not say. */
  readBuild: () => Promise<{ revision?: string } | null>;
  isVisible: () => boolean;
  now: () => number;
  storage: () => Storage | null;
  /** How long between looks while the window stays in sight. */
  lookEveryMs: number;
};

/** The commit this page's own document carries, or null where the build wrote none. */
export function readBundleRevision(): string | null {
  const revision = globalThis.document
    ?.querySelector(`meta[name="${BUILD_REVISION_META}"]`)
    ?.getAttribute("content")
    ?.trim();
  return revision || null;
}

const DEFAULT_DEPS: BuildWatchDeps = {
  bundleRevision: readBundleRevision,
  readBuild: readServerBuild,
  isVisible: () => globalThis.document?.visibilityState === "visible",
  now: () => Date.now(),
  storage: sessionStore,
  lookEveryMs: LOOK_EVERY_MS,
};

const NOTHING_KNOWN: BuildFacts = {
  bundleRevision: null,
  serverRevision: null,
  reloadedFor: null,
  shellUpdate: null,
};

const RELOADED_FOR_KEY = "laf:reloaded-for-revision";

let deps: BuildWatchDeps = DEFAULT_DEPS;
let facts: BuildFacts = NOTHING_KNOWN;
let lookedAt = Number.NEGATIVE_INFINITY;
let isLooking = false;
const watchers = new Set<() => void>();

function announce() {
  for (const watcher of watchers) watcher();
}

function learn(next: Partial<BuildFacts>) {
  const known = { ...facts, ...next };
  const names = Object.keys(known) as (keyof BuildFacts)[];
  if (names.every((name) => known[name] === facts[name])) return;
  facts = known;
  announce();
}

/** Replace what the module asks of the page, and forget what it knew; `null` puts the real page back. For tests. */
export function configureBuildWatch(next: Partial<BuildWatchDeps> | null) {
  deps = next ? { ...DEFAULT_DEPS, ...next } : DEFAULT_DEPS;
  facts = NOTHING_KNOWN;
  lookedAt = Number.NEGATIVE_INFINITY;
  isLooking = false;
  announce();
}

function readReloadedFor(): string | null {
  try {
    return deps.storage()?.getItem(RELOADED_FOR_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Ask the server which build it runs, if this is a moment to.
 *
 * `isBack` is the connection returning, which is not held to the half-minute: the look before it
 * may have been seconds ago, on the server that has just been replaced.
 */
async function look(isBack = false): Promise<void> {
  if (!facts.bundleRevision) return;
  if (!deps.isVisible()) return;
  const at = deps.now();
  if (isLooking) return;
  if (!isBack && at - lookedAt < LOOK_AGAIN_AFTER_MS) return;
  isLooking = true;
  lookedAt = at;
  const build = await deps.readBuild().catch(() => null);
  isLooking = false;
  const revision = build?.revision?.trim();
  // Unanswered, or answered by a server that names no commit: what was known stays known.
  if (revision) learn({ serverRevision: revision });
}

/**
 * Begin watching, for as long as somebody is signed in (`routes/_authed.tsx`). Returns the stop.
 *
 * NO LOOK AS IT BEGINS. A page that has just loaded is the bundle the web server holds now, and
 * during an upgrade the two halves of a deployment are replaced seconds apart: a look in that
 * window would greet a fresh page with a notice about itself.
 */
export function watchBuild(): () => void {
  learn({
    bundleRevision: deps.bundleRevision(),
    reloadedFor: readReloadedFor(),
  });
  let isWatching = true;
  const handleSeen = () => {
    void look();
  };
  /*
   * THE CONNECTION RETURNING IS WHEN A RELOAD CAN WORK AGAIN, so the mark of one that did not is
   * dropped first. The fleet's upgrade replaces the server, waits for it, and replaces the front
   * door last: in between, this page reconnects through the old front door and offers the reload,
   * and a press there brings the OLD page back and marks the new commit as tried. With the mark
   * kept, the control then stayed silent for that whole release — in the installed app, until it
   * was quit — though the new page was seconds away (review of pull request 112). The front door
   * cannot be replaced without dropping this page's socket, so its return is the moment to ask
   * again; a deployment whose two halves really have pulled apart offers once per reconnect, and
   * falls silent again on a press that does not help.
   */
  const handleBack = () => {
    try {
      deps.storage()?.removeItem(RELOADED_FOR_KEY);
    } catch {
      // Storage refused: what is remembered in this page is still forgotten below.
    }
    learn({ reloadedFor: null });
    void look(true);
  };
  /*
   * The shell's half. Read once and again whenever the shell says one has arrived — its event is
   * only a nudge, since a page can emit events too, so the version is always read back
   * (`onShellUpdateReady`). In a browser tab both answer nothing and nothing is learned.
   */
  const readShell = () => {
    void shellUpdateReady().then((version) => {
      if (isWatching) learn({ shellUpdate: version });
    });
  };
  globalThis.document?.addEventListener("visibilitychange", handleSeen);
  globalThis.addEventListener?.("focus", handleSeen);
  socketState.addEventListener(SOCKET_RECONNECTED, handleBack);
  const timer = setInterval(handleSeen, deps.lookEveryMs);
  readShell();
  const stopShell = onShellUpdateReady(readShell);
  return () => {
    isWatching = false;
    globalThis.document?.removeEventListener("visibilitychange", handleSeen);
    globalThis.removeEventListener?.("focus", handleSeen);
    socketState.removeEventListener(SOCKET_RECONNECTED, handleBack);
    clearInterval(timer);
    stopShell();
  };
}

function subscribe(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => {
    watchers.delete(onChange);
  };
}

/** What is known now. One object per change, so a reader that has seen it is not drawn again. */
export function buildFacts(): BuildFacts {
  return facts;
}

export function useBuildFacts(): BuildFacts {
  return useSyncExternalStore(subscribe, buildFacts, () => NOTHING_KNOWN);
}

/**
 * The press on 새로고침: the page reloads into the server's build, keeping what was typed
 * (`reloadPage`), and remembers which commit it reloaded for — see `updateOffer`.
 */
export function reloadIntoNewBuild(): void {
  const revision = facts.serverRevision;
  if (revision) {
    try {
      deps.storage()?.setItem(RELOADED_FOR_KEY, revision);
    } catch {
      // Storage full or refused: the reload still goes, and may be offered once more after it.
    }
  }
  reloadPage();
}
