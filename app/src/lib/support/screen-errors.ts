/**
 * A part of the screen failed: say so to our own server, in closed facts, once.
 *
 * The contract is `shared/screen-errors.ts`; this is the half that builds a report. It is called by
 * a section boundary that caught a render (`components/layout/section-boundary.tsx`), by the router's
 * own error screen, and by the window's `error` and `unhandledrejection` events, which is where an
 * error thrown outside React's drawing ends up — an event handler, a timer, a promise nobody awaited.
 *
 * WHAT IS READ FROM THE ERROR, AND WHAT IS NOT. Its constructor, for the kind. Its stack, for where
 * it was thrown: each frame's file name, line and column, and nothing else of the frame — then only
 * a digest of those goes, so even a frame the parser misread cannot put a word on the wire. From
 * React's component stack, when the failure was caught while drawing, the names of the components
 * around it and not their addresses (`componentsOf`). Never
 * `message`: an error's message quotes whatever the failing code was handed, and a URL that would
 * not parse is quoted with its query, a password field's value with it. `screen-errors.test.ts`
 * throws a password and a Korean sentence and searches the body that would be posted for both.
 *
 * ONCE PER FINGERPRINT PER PAGE LOAD. A section that keeps failing, a timer that throws every second,
 * two sections drawing the same broken component: one report. The server limits a session besides
 * (`server/src/support/screen-errors.ts`), because a client that forgot this rule is still a client.
 *
 * TO OUR OWN SERVER AND NOWHERE ELSE. The report goes to the origin that served the page — the
 * person's own deployment — with the session it already has, and only while somebody is signed in:
 * the route refuses anybody else, and a refusal on the sign-in screen is a request with no use.
 */
import {
  BUILD_REVISION,
  BUILD_VERSION,
  COMPONENT_NAME,
  ERROR_KIND,
  isScreenRoute,
  SCREEN_ERROR_MAX_COMPONENTS,
  type ScreenErrorReport,
  type ScreenSection,
  type ScreenSurface,
} from "@shared/screen-errors";

/** The frames that decide where an error came from. Past these it is the framework calling itself. */
const FRAMES = 5;

/**
 * A frame's location at the end of its line, in each engine's spelling: V8 writes
 * `    at name (URL:line:col)` or `    at URL:line:col`; JavaScriptCore (the Mac shell's webview) and
 * Gecko write `name@URL:line:col`. Anything else — `at <anonymous>`, `[native code]`, an `eval`
 * frame — has no location worth keeping and is passed over.
 */
const FRAME = /(?:\(|@|\bat\s+|^)([^\s()@]+):(\d{1,7}):(\d{1,7})\)?$/;

/** A script's file name, as a bundler or a dev server names one. An address with an id in it is not. */
const SCRIPT_NAME = /^[A-Za-z0-9_.$~-]{1,100}\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;

/**
 * The name of an error's constructor, or what a thrown thing that is not an object is.
 *
 * Walked up the prototypes to the first name that fits `ERROR_KIND`: a production build shortens
 * the app's own error classes to a letter or two, and "Error" is the truth about those.
 */
export function errorKind(error: unknown): string {
  if (error === null) return "null";
  if (typeof error !== "object" && typeof error !== "function") {
    return typeof error;
  }
  try {
    let prototype: unknown = Object.getPrototypeOf(error);
    while (prototype) {
      const name = (prototype as { constructor?: { name?: unknown } })
        .constructor?.name;
      if (typeof name === "string" && ERROR_KIND.test(name)) return name;
      prototype = Object.getPrototypeOf(prototype);
    }
  } catch {
    // A proxy that throws on being looked at is still a thrown object.
  }
  return typeof error === "function" ? "function" : "Object";
}

/** `stack` without the header V8 puts above the frames, which is the name and the message. */
function framesOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  try {
    const stack = (error as { stack?: unknown }).stack;
    if (typeof stack !== "string") return "";
    /*
     * V8 opens the stack with `Error.prototype.toString` of the error as it was made — the message,
     * newlines and all. It is cut off when it is still the same text; when it is not (a message
     * changed after the error was made), a message line that happened to look like a frame could be
     * read as one, which is the second reason only a digest of the frames is ever sent.
     */
    const header = Error.prototype.toString.call(error);
    return stack.startsWith(header) ? stack.slice(header.length) : stack;
  } catch {
    return "";
  }
}

/**
 * Whether a frame is the framework's rather than the app's: a dependency the dev server serves out
 * of `node_modules`, or one of the `vendor-*` chunks a build puts them in (`vite.config.ts`).
 */
const isFrameworkFrame = (path: string, file: string): boolean =>
  path.includes("/node_modules/") || file.startsWith("vendor-");

/**
 * Where each of the first few frames OF THE APP'S OWN CODE is: `file.tsx:88:3`, and nothing else.
 *
 * THE APP'S, BECAUSE REACT'S OWN FRAMES MOVE. Measured 2026-09-18 on the roster: one broken answer
 * threw from the same line of `bot-sidebar.tsx` twice, once while the roster was updating and once
 * when it was drawn afresh, and the frames between the throw and the component were React's
 * `updateMemo` in one stack and `mountMemo` in the other — two fingerprints for one failure, and a
 * second report of it. Skipping the framework's frames leaves the throw site and the components
 * above it, which is the failure. A stack that is ALL framework — something React itself refused —
 * keeps its first frames as they are, rather than having none.
 */
export function stackLocations(error: unknown): string[] {
  const own: string[] = [];
  const all: string[] = [];
  for (const line of framesOf(error).split("\n")) {
    const match = FRAME.exec(line.trim());
    if (!match) continue;
    const [, url = "", row, column] = match;
    const path = url.split(/[?#]/, 1)[0] ?? "";
    const file = path.split("/").pop() ?? "";
    if (!SCRIPT_NAME.test(file)) continue;
    const location = `${file}:${row}:${column}`;
    if (all.length < FRAMES) all.push(location);
    if (!isFrameworkFrame(path, file)) own.push(location);
    if (own.length === FRAMES) break;
  }
  return own.length > 0 ? own : all;
}

/** FNV-1a, 32 bits. A grouping key, not a secret: nothing here needs a cryptographic digest. */
function fnv1a(text: string, basis: number): string {
  let hash = basis >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Twelve hex digits made from where the error was thrown.
 *
 * The kind goes in too, so that two things thrown with no stack at all — a string, a `null` — are
 * still told apart by what they were. Two passes with different starting values make the 48 bits.
 */
export function fingerprintOf(
  kind: string,
  locations: readonly string[],
): string {
  const text = [kind, ...locations].join("\n");
  return `${fnv1a(text, 0x811c9dc5)}${fnv1a(text, 0x5bd1e995)}`.slice(0, 12);
}

/**
 * The components a failure was drawn inside, innermost first, from React's component stack.
 *
 * NAMES ONLY. Each line of the stack is a name and where its function lives — an address, which in
 * development carries Vite's `?t=` query — and only the name is kept, and only when it has the shape
 * of a component's (`COMPONENT_NAME`). Host elements (`div`), a context's `Context.Provider`, and
 * anything a misread line would make of an address are left out by that shape, not by a list.
 */
export function componentsOf(
  componentStack: string | null | undefined,
): string[] {
  const names: string[] = [];
  for (const line of (componentStack ?? "").split("\n")) {
    // `at Name (address)` in Chromium, `Name@address` in WebKit and Firefox.
    const name = line
      .trim()
      .replace(/^at\s+/, "")
      .split(/[\s@(]/, 1)[0];
    if (name && COMPONENT_NAME.test(name)) names.push(name);
    if (names.length === SCREEN_ERROR_MAX_COMPONENTS) break;
  }
  return names;
}

/** What the page knows about itself at the moment of the report. */
export type ScreenFacts = {
  /** The router's template for the route on screen, if it is on the list. */
  route: string | undefined;
  /** What `GET /api/version` said, when the page asked. */
  build: { version: string; revision?: string } | null;
  surface: ScreenSurface;
};

/**
 * The report, from the section, the error and what the page knows. Pure.
 *
 * An optional fact that does not fit its shape is LEFT OUT rather than sent: the server refuses a
 * whole report for one bad field, and a build under a tag of the operator's own naming is not a
 * reason to lose the report of a broken screen.
 */
export function screenErrorReport(
  section: ScreenSection,
  error: unknown,
  facts: ScreenFacts,
  /** React's `componentStack`, where the failure was caught while drawing. */
  componentStack?: string | null,
): ScreenErrorReport {
  const kind = errorKind(error);
  const version = facts.build?.version;
  const revision = facts.build?.revision;
  const hasBuild = typeof version === "string" && BUILD_VERSION.test(version);
  const components = componentsOf(componentStack);
  return {
    section,
    ...(isScreenRoute(facts.route) ? { route: facts.route } : {}),
    kind,
    fingerprint: fingerprintOf(kind, stackLocations(error)),
    ...(components.length > 0 ? { components } : {}),
    ...(hasBuild ? { build: version } : {}),
    ...(hasBuild &&
    typeof revision === "string" &&
    BUILD_REVISION.test(revision)
      ? { revision }
      : {}),
    surface: facts.surface,
  };
}

/** The one request a report is, exactly as it leaves. */
export async function sendScreenErrorReport(
  report: ScreenErrorReport,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await fetchImpl("/api/support/screen-errors", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
  });
}

/**
 * The route on screen, as its template: the deepest match's `fullPath` — `/channel/$channelId`
 * while `/channel/0f9c…` is in the address bar. The router's own name for it, never the location.
 */
export const routeTemplateOf = (router: {
  state: { matches: ReadonlyArray<{ fullPath: string }> };
}): string | undefined => router.state.matches.at(-1)?.fullPath;

/** What the reporter asks the running app, handed over once by `main.tsx`. */
export type ScreenErrorReporting = {
  /** The template of the route on screen: the deepest match's `fullPath`. */
  route: () => string | undefined;
  /** The build the page read from its server — asked for only once something has failed. */
  build: () => Promise<{ version: string; revision?: string } | null>;
  surface: () => ScreenSurface;
  /** Whether anybody is signed in to report as. */
  isSignedIn: () => boolean;
  send?: (report: ScreenErrorReport) => Promise<void>;
};

let reporting: ScreenErrorReporting | null = null;
const reported = new Set<string>();

/** Where reports go from now on. `null` stops them, which is what a test does between cases. */
export function configureScreenErrorReports(
  next: ScreenErrorReporting | null,
): void {
  reporting = next;
  reported.clear();
}

/**
 * Report one failure, unless this page has reported its fingerprint already. Never throws: a
 * report that could not be made is not a second failure for the screen to have.
 *
 * Resolves to the report that was sent, or null when none was — for the tests and nothing else.
 */
export async function reportScreenError(
  section: ScreenSection,
  error: unknown,
  componentStack?: string | null,
): Promise<ScreenErrorReport | null> {
  const current = reporting;
  if (!current) return null;
  try {
    if (!current.isSignedIn()) return null;
    // Read before anything is awaited: by the time the build comes back the screen may have moved.
    const route = current.route();
    const surface = current.surface();
    const kind = errorKind(error);
    const fingerprint = fingerprintOf(kind, stackLocations(error));
    if (reported.has(fingerprint)) return null;
    reported.add(fingerprint);
    const build = await current.build().catch(() => null);
    const report = screenErrorReport(
      section,
      error,
      { route, build, surface },
      componentStack,
    );
    await (current.send ?? sendScreenErrorReport)(report);
    return report;
  } catch {
    return null;
  }
}

/** A deliberate cancel — the person pressed stop, a screen was left — is not a failure. */
const isAbort = (reason: unknown): boolean =>
  typeof reason === "object" &&
  reason !== null &&
  (reason as { name?: unknown }).name === "AbortError";

/**
 * The window's two events for what nothing on screen caught. Returns the way to stop listening.
 *
 * An `error` event with no error object is passed over: it is the browser saying that something it
 * will not show us failed — a script from another origin ("Script error.") or a `ResizeObserver`
 * that ran out of frames — and there is nothing in it a report could be made of.
 */
export function listenForScreenErrors(target: Window = window): () => void {
  const handleError = (event: ErrorEvent) => {
    if (event.error === null || event.error === undefined) return;
    void reportScreenError("window_error", event.error);
  };
  const handleRejection = (event: PromiseRejectionEvent) => {
    if (isAbort(event.reason)) return;
    void reportScreenError("unhandled_rejection", event.reason);
  };
  target.addEventListener("error", handleError);
  target.addEventListener("unhandledrejection", handleRejection);
  return () => {
    target.removeEventListener("error", handleError);
    target.removeEventListener("unhandledrejection", handleRejection);
  };
}
