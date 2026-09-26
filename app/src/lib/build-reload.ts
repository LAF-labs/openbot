/**
 * A PAGE FROM BEFORE A DEPLOY, ASKING FOR CODE THE SERVER NO LONGER HAS.
 *
 * Every route's screen is its own chunk (`vite.config.ts`, `autoCodeSplitting`), fetched the first
 * time somebody opens it, under a name with the build's hash in it. When `IMAGE_TAG` moves, the web
 * container serves the new build's chunks and none of the old ones — and a window left open since
 * yesterday still names the old ones. Its first visit to 루틴 after the upgrade asked for a file that
 * no longer exists (Caddy answers the missing file with the app's own page, which is not a script),
 * and the screen fell over. It hits every owner on every upgrade, and the installed app has no
 * address bar to reload from.
 *
 * WHAT IS DONE ABOUT IT: the page reloads, once, and is the new build. Once PER BUILD, remembered
 * in this tab's `sessionStorage` under the build `GET /api/version` names, so a build that is really
 * broken — its own chunks failing after the reload — reloads once and then stops, and says so,
 * rather than reloading forever. The server is asked first: a chunk that failed because the server
 * could not be reached at all is a dropped connection, and reloading into that is the /unreachable
 * screen, not a fix.
 *
 * WHAT IS KEPT THROUGH IT. What was sent and did not arrive is kept already (`composer/outbox.ts`).
 * What was TYPED and not sent is held here by the composer that has it (`holdDraft`), written to
 * `sessionStorage` in the moment before the reload, and handed back to that conversation's composer
 * when it is drawn again (`takeKeptDraft`) — which may be later, because the reload lands on the
 * screen the person was going to, not the one they typed in.
 *
 * WHO ELSE READS THE STATE. A chunk that fails through Vite's preload is handed here first, and the
 * failure is stopped from going on (`vite:preloadError`, `preventDefault`) — so what reaches a
 * boundary instead is an unrelated-looking error from the code that expected the module. The
 * boundaries read `staleBuildState()` and, while it is anything but `idle`, treat whatever they
 * caught as this and not as a crash: no error card, and no report of a failure that is really the
 * page being out of date (`section-boundary.tsx`, `router.tsx`, `lib/support/screen-errors.ts`).
 */
import { useSyncExternalStore } from "react";

/**
 * - `idle`: nothing is known to be wrong with this page's code.
 * - `checking`: a chunk failed and the server is being asked which build it runs.
 * - `reloading`: the page is going; nothing on it matters now.
 * - `stale`: it reloaded for this build already and a chunk still failed. It stays, and says so.
 * - `unreachable`: the server did not answer; this is a dropped connection, not a deploy.
 */
export type StaleBuildState =
  | "idle"
  | "checking"
  | "reloading"
  | "stale"
  | "unreachable";

export type StaleBuildOutcome = "reloading" | "stale" | "unreachable";

/**
 * How a chunk that could not be loaded says so, in each engine: Chromium, Gecko, WebKit (the Mac
 * shell's web view), and Vite's own for a stylesheet a chunk needed. The same three module phrases
 * TanStack Router reads for its own reload. Read here and never sent anywhere — see `classifyError`.
 */
const CHUNK_FAILURES = [
  "Failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "Importing a module script failed",
  "Unable to preload CSS",
];

export function isChunkLoadError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { message, name } = error as { message?: unknown; name?: unknown };
  if (name === "ChunkLoadError") return true;
  return (
    typeof message === "string" &&
    CHUNK_FAILURES.some((failure) => message.startsWith(failure))
  );
}

/** What this module asks of the page. `configureBuildReload` replaces it in a test. */
export type BuildReloadDeps = {
  /** The build the server runs now, or null when it could not say. */
  readBuild: () => Promise<{ version: string; revision?: string } | null>;
  reload: () => void;
  storage: () => Storage | null;
};

/** How long the server is given to say which build it runs, before this is a dropped connection. */
const BUILD_WAIT_MS = 5_000;

async function readServerBuild(): Promise<{
  version: string;
  revision?: string;
} | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUILD_WAIT_MS);
  try {
    const response = await fetch("/api/version", {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      version?: unknown;
      revision?: unknown;
    };
    if (typeof body.version !== "string" || !body.version) return null;
    return {
      version: body.version,
      ...(typeof body.revision === "string" ? { revision: body.revision } : {}),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    // A browser that refuses storage altogether (some private windows) throws on the getter.
    return null;
  }
}

const DEFAULT_DEPS: BuildReloadDeps = {
  readBuild: readServerBuild,
  reload: () => window.location.reload(),
  storage: sessionStore,
};

let deps: BuildReloadDeps = DEFAULT_DEPS;
let state: StaleBuildState = "idle";
let pending: Promise<StaleBuildOutcome> | null = null;
const watchers = new Set<() => void>();
/** The composers' unsent text, by conversation, while they are on screen. */
const held = new Map<string, string>();

/** Replace what the module asks of the page; `null` puts the real page back. For tests. */
export function configureBuildReload(next: Partial<BuildReloadDeps> | null) {
  deps = next ? { ...DEFAULT_DEPS, ...next } : DEFAULT_DEPS;
  state = "idle";
  pending = null;
  held.clear();
  announce();
}

function announce() {
  for (const watcher of watchers) watcher();
}

function setState(next: StaleBuildState) {
  if (state === next) return;
  state = next;
  announce();
}

export function staleBuildState(): StaleBuildState {
  return state;
}

export function subscribeStaleBuild(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => {
    watchers.delete(onChange);
  };
}

export function useStaleBuildState(): StaleBuildState {
  return useSyncExternalStore(
    subscribeStaleBuild,
    staleBuildState,
    () => "idle",
  );
}

const RELOADED_PREFIX = "laf:reloaded-for-build:";
const DRAFTS_KEY = "laf:drafts-kept-through-reload";

/**
 * A conversation's composer, holding what is typed in it for as long as it is on screen. Returns
 * the release. Empty text holds nothing.
 */
export function holdDraft(channelId: string, text: string): () => void {
  if (!text.trim()) {
    held.delete(channelId);
    return () => {};
  }
  held.set(channelId, text);
  return () => {
    if (held.get(channelId) === text) held.delete(channelId);
  };
}

/** What was typed in this conversation before the page reloaded, once, or null. */
export function takeKeptDraft(channelId: string): string | null {
  const storage = deps.storage();
  if (!storage) return null;
  try {
    const kept = JSON.parse(storage.getItem(DRAFTS_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    const text = kept[channelId];
    if (typeof text !== "string") return null;
    delete kept[channelId];
    if (Object.keys(kept).length === 0) storage.removeItem(DRAFTS_KEY);
    else storage.setItem(DRAFTS_KEY, JSON.stringify(kept));
    return text;
  } catch {
    return null;
  }
}

function keepDrafts(storage: Storage, drafts: ReadonlyMap<string, string>) {
  if (drafts.size === 0) return;
  try {
    storage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(drafts)));
  } catch {
    // Storage full or refused: the reload still goes; what was typed is the one thing lost.
  }
}

/** The page reloads because the person asked it to — no guard, and what is typed is kept. */
export function reloadPage(): void {
  const storage = deps.storage();
  if (storage) keepDrafts(storage, held);
  setState("reloading");
  deps.reload();
}

/*
 * WHAT IS TYPED IS TAKEN WHEN THE FAILURE IS SEEN, NOT WHEN THE RELOAD GOES. Measured 2026-09-26 in
 * a real deploy under an open tab: the route that failed was committed while the server was still
 * being asked for its build, the conversation's composer unmounted and let go of its text, and the
 * page reloaded with nothing kept. The copy below is made before anything is awaited.
 */
async function recover(
  drafts: ReadonlyMap<string, string>,
): Promise<StaleBuildOutcome> {
  const build = await deps.readBuild().catch(() => null);
  if (!build) {
    setState("unreachable");
    return "unreachable";
  }
  const storage = deps.storage();
  const key = `${RELOADED_PREFIX}${build.version}@${build.revision ?? ""}`;
  /*
   * NO STORAGE, NO AUTOMATIC RELOAD. The guard is the only thing standing between a broken build
   * and a page that reloads itself forever; where it cannot be written, the person is asked.
   */
  try {
    if (!storage || storage.getItem(key) !== null) {
      setState("stale");
      return "stale";
    }
    storage.setItem(key, "1");
  } catch {
    setState("stale");
    return "stale";
  }
  keepDrafts(storage, drafts);
  setState("reloading");
  deps.reload();
  return "reloading";
}

/**
 * A chunk could not be loaded: reload into the new build, once per build. Resolves to what was done;
 * every caller while one is being worked out gets the same answer.
 */
export function recoverFromStaleBuild(): Promise<StaleBuildOutcome> {
  if (state === "reloading") return Promise.resolve("reloading");
  /*
   * A page already `stale` asks again rather than answering from memory: the guard is per build, so
   * the same build stays stale without a second reload, and a LATER deploy is a new build the page
   * reloads into. Answering "stale" here left such a page waiting for the person to press reload
   * after every upgrade that followed a broken one (P1's follow-up, 2026-09-26).
   */
  if (pending) return pending;
  setState("checking");
  pending = recover(new Map(held)).then((outcome) => {
    pending = null;
    return outcome;
  });
  return pending;
}

/**
 * Vite's preload failed a chunk: take it from here. Returns the way to stop listening.
 *
 * `preventDefault` stops Vite throwing the failure on; the reload decides instead. It is called at
 * once, because the event wants its answer now and the build is only known a request later — which
 * is why the state turns to `checking` before anything is awaited.
 */
export function listenForStaleChunks(target: Window = window): () => void {
  const handlePreloadError = (event: Event) => {
    event.preventDefault();
    void recoverFromStaleBuild();
  };
  target.addEventListener("vite:preloadError", handlePreloadError);
  return () => {
    target.removeEventListener("vite:preloadError", handlePreloadError);
  };
}
