/**
 * What the desktop shell can do that a browser tab cannot, reached only when the shell is there.
 *
 * The app is not bundled into the shell; it is the deployed origin loaded in a window. So it cannot
 * `import` `@tauri-apps/api` — nothing would resolve it in a browser — and the shell instead
 * exposes `window.__TAURI__` (`withGlobalTauri`). This module is the one place that global is read,
 * and every caller feature-detects through it: in a browser tab the answers are "no" and the app is
 * exactly the web app it always was.
 *
 * Two things ride it, and only two, because they are the two a webview genuinely cannot do:
 *
 * THE DOCK BADGE. `navigator.setAppBadge` is a Chromium-PWA API; WKWebView and WebView2 have no
 * equivalent, and the tab-title fallback is invisible on a dock icon. The shell sets the real one.
 *
 * NATIVE NOTIFICATIONS. A webview's `Notification` is unsupported (WKWebView) or bound to the
 * webview's own lifetime. The shell's go through the OS centre and survive the window being hidden
 * behind others — which is the whole reason the person installed an app. They carry a destination,
 * because since the shell grew a tray the window it should come back to may not be on screen at all.
 *
 * LINKS OUT. Every link a Bot writes is rendered `target="_blank"` (`lib/markdown.tsx`), and a
 * webview has no second window to put one in: in the shell, clicking any link in any message did
 * nothing at all. `openExternal` hands it to the person's own browser. It goes through the shell's
 * own `open_external` command rather than the opener plugin, because a general-purpose opener
 * reachable from a web page can launch whatever a scheme handler is registered for.
 *
 * And, since 2026-09-26, what keeps the installed app awake and reachable with its window put away:
 * the tray's status, the summon shortcut's setting and the update waiting for a restart — at the
 * end of this file.
 */

import type { PresenceKind } from "@/lib/agents/presence";

type TauriGlobal = {
  core?: {
    invoke?: (
      command: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
  /*
   * Permission only. Posting a notice goes through the shell's own `post_notice` command instead of
   * this plugin's `sendNotification`, so that the tray's mute and the notice's destination have one
   * place to live rather than being things the page could route around or drop on the floor.
   */
  notification?: {
    isPermissionGranted?: () => Promise<boolean>;
    requestPermission?: () => Promise<string>;
  };
  /** The shell's own version — `core:app:default`, part of `core:default` in the capability. */
  app?: {
    getVersion?: () => Promise<string>;
  };
  /** `core:event:default`, also part of `core:default`: how the shell says an update is ready. */
  event?: {
    listen?: (
      event: string,
      handler: (event: { payload: unknown }) => void,
    ) => Promise<() => void>;
  };
};

function shell(): TauriGlobal | null {
  // `globalThis`, not `window`: the same object in a browser, and the only one in a test runtime.
  const global = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;
  return global && typeof global === "object" ? global : null;
}

/** Whether the app is running inside the desktop shell rather than a browser tab. */
export function inShell(): boolean {
  return shell() !== null;
}

/**
 * Which shell this page is running in, or null when it is a browser tab.
 *
 * The server's build is on `/api/version`; this is the other half of "what are you running", and
 * the only half a page cannot learn from the origin. Null rather than an empty string so a footer
 * draws nothing about a shell that is not there.
 */
export async function shellVersion(): Promise<string | null> {
  const getVersion = shell()?.app?.getVersion;
  if (!getVersion) return null;
  try {
    const version = await getVersion();
    return typeof version === "string" && version.trim()
      ? version.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Put the count on the dock icon. Resolves false when there is no shell, so the caller falls back
 * to whatever a browser can do; it never throws, because a badge that could not be set is not a
 * reason for anything else to stop.
 */
export async function setShellBadge(count: number): Promise<boolean> {
  const invoke = shell()?.core?.invoke;
  if (!invoke) return false;
  try {
    await invoke("set_badge", { count });
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a link in the person's browser. False when there is no shell, or the shell refused it — the
 * caller then lets the browser do what it was always going to do.
 */
export async function openExternal(url: string): Promise<boolean> {
  const invoke = shell()?.core?.invoke;
  if (!invoke) return false;
  try {
    await invoke("open_external", { url });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the shell may already post notices, or nothing when there is no shell.
 *
 * The shell answers with a boolean and no third state: Tauri's plugin has `isPermissionGranted`,
 * which is false both for "the person said no" and for "nobody has asked yet". So "not granted" is
 * reported as something still worth asking about, which is the honest reading of a boolean — and
 * asking again on a denied system is a no-op rather than a second popup.
 */
export async function shellNoticePermission(): Promise<
  "granted" | "ask" | null
> {
  const notification = shell()?.notification;
  if (!notification?.isPermissionGranted) return null;
  try {
    return (await notification.isPermissionGranted?.()) ? "granted" : "ask";
  } catch {
    return null;
  }
}

/** Ask the OS, through the shell. Null when there is no shell to ask through. */
export async function requestShellNoticePermission(): Promise<
  "granted" | "denied" | null
> {
  const notification = shell()?.notification;
  if (!notification?.isPermissionGranted) return null;
  try {
    if (await notification.isPermissionGranted?.()) return "granted";
    if (!notification.requestPermission) return null;
    return (await notification.requestPermission()) === "granted"
      ? "granted"
      : "denied";
  } catch {
    return null;
  }
}

/**
 * Where a notice should land, if the person acts on it.
 *
 * A kind and an id, not a path. The shell keeps the list of paths it is willing to open — the same
 * list its `lafagent://` links go through — so nothing this page says can point that window at an
 * address somebody did not choose to visit.
 */
export type NoticeDestination = { kind: "approve" | "channel"; id: string };

/**
 * Show a native notification through the shell. Resolves false when there is no shell or it could
 * not be posted, so the caller can fall back to the webview's own `Notification`.
 *
 * TRUE MEANS THE SHELL DEALT WITH IT, WHICH INCLUDES DELIBERATE SILENCE. The shell's tray carries a
 * "알림 받기" switch, and a mute the page could route around by falling back to its own notification
 * would be no mute at all. A shell that refuses because the person asked for quiet answers the same
 * way as one that posted: handled.
 *
 * It goes through the shell's own `post_notice` rather than the notification plugin's binding for
 * that reason and one more — the destination has to be recorded somewhere the shell can reach it,
 * because the desktop plugin cannot report a click (see `bot-notifications.ts`).
 */
export async function showShellNotice(options: {
  title: string;
  body: string;
  silent: boolean;
  destination?: NoticeDestination;
}): Promise<boolean> {
  const invoke = shell()?.core?.invoke;
  const notification = shell()?.notification;
  if (!invoke || !notification) return false;
  try {
    let granted = (await notification.isPermissionGranted?.()) ?? false;
    if (!granted && notification.requestPermission) {
      granted = (await notification.requestPermission()) === "granted";
    }
    if (!granted) return false;
    await invoke("post_notice", {
      title: options.title,
      body: options.body,
      silent: options.silent,
      destination: options.destination ?? null,
    });
    return true;
  } catch {
    return false;
  }
}

/*
 * —— Awake and reachable (2026-09-26) ————————————————————————————————————————————————————————————
 *
 * Each of these is one of the shell's own commands, named in `build.rs` and granted in
 * `capabilities/default.json`. Each answers "no shell" — null or false — when the shell is absent or
 * too old to have the command, so a browser tab, and an app installed before this change, draw
 * nothing rather than a control that does nothing.
 */

async function ask<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  const invoke = shell()?.core?.invoke;
  if (!invoke) return null;
  try {
    return ((await invoke(command, args)) ?? null) as T | null;
  } catch {
    return null;
  }
}

/** Whether the shell took the command, for the ones that answer nothing when they succeed. */
async function tell(
  command: string,
  args?: Record<string, unknown>,
): Promise<boolean> {
  const invoke = shell()?.core?.invoke;
  if (!invoke) return false;
  try {
    await invoke(command, args);
    return true;
  } catch {
    return false;
  }
}

/** What the tray says the Bot is doing. Three codes; the shell holds the words. */
export type ShellStatus = "working" | "waiting" | "idle";

/**
 * The pill's answer, folded to the tray's three.
 *
 * The person's turn is its own word because it is the one worth seeing from the menu bar. Every
 * kind of busy is one word there: the tray is not where somebody reads which kind.
 */
export function shellStatusOf(kind: PresenceKind): ShellStatus {
  switch (kind) {
    case "approval":
    case "help":
      return "waiting";
    case "working":
    case "routine":
    case "answering":
    case "thinking":
      return "working";
    case "idle":
      return "idle";
  }
}

export function setShellStatus(status: ShellStatus): Promise<boolean> {
  return tell("set_status", { status });
}

/** The version the shell has fetched and is holding for a restart, or null when there is none. */
export async function shellUpdateReady(): Promise<string | null> {
  const version = await ask<unknown>("update_ready");
  return typeof version === "string" && version.trim() ? version.trim() : null;
}

/**
 * Called when the shell says an update has arrived. Only a nudge — a page can emit events too — so
 * the caller reads the version back with `shellUpdateReady`.
 */
export function onShellUpdateReady(handler: () => void): () => void {
  const listen = shell()?.event?.listen;
  if (!listen) return () => {};
  let unlisten: (() => void) | null = null;
  let isStopped = false;
  listen("update-ready", () => handler())
    .then((stop) => {
      if (isStopped) stop();
      else unlisten = stop;
    })
    .catch(() => undefined);
  return () => {
    isStopped = true;
    unlisten?.();
  };
}

/**
 * Restart into the update the shell is holding. The shell refuses when it holds none, and this is
 * false then. When it succeeds the page is gone before anything reads the answer.
 */
export function restartToUpdate(): Promise<boolean> {
  return tell("restart_to_update");
}

/** The summon shortcut: the one chosen, the ids to choose from, and whether it is really held. */
export type SummonSetting = {
  choice: string;
  choices: string[];
  active: boolean;
};

export function summonSettingOf(value: unknown): SummonSetting | null {
  if (!value || typeof value !== "object") return null;
  const { choice, choices, active } = value as Record<string, unknown>;
  if (typeof choice !== "string" || !Array.isArray(choices)) return null;
  return {
    choice,
    choices: choices.filter((id): id is string => typeof id === "string"),
    active: active === true,
  };
}

export async function shellSummonShortcut(): Promise<SummonSetting | null> {
  return summonSettingOf(await ask<unknown>("summon_shortcut"));
}

export async function setShellSummonShortcut(
  choice: string,
): Promise<SummonSetting | null> {
  return summonSettingOf(await ask<unknown>("set_summon_shortcut", { choice }));
}

const SUMMON_KEYS: Readonly<Record<string, readonly [string[], string]>> = {
  "control-alt-l": [["control", "alt"], "L"],
  "alt-shift-l": [["alt", "shift"], "L"],
  "alt-space": [["alt"], "Space"],
};
const MAC_MODIFIERS: Readonly<Record<string, string>> = {
  control: "⌃",
  alt: "⌥",
  shift: "⇧",
};
const PC_MODIFIERS: Readonly<Record<string, string>> = {
  control: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};

/**
 * The keys a summon id means, drawn the way the person's keyboard labels them: symbols on a Mac,
 * where the menus print ⌃⌥⇧, and names elsewhere, where the keycaps say Ctrl and Alt. Null for
 * `off` and for an id this build does not know; the caller has its own word for off.
 */
export function summonKeysOf(id: string, isMac: boolean): string | null {
  const found = SUMMON_KEYS[id];
  if (!found) return null;
  const [modifiers, key] = found;
  return isMac
    ? `${modifiers.map((name) => MAC_MODIFIERS[name]).join("")}${key}`
    : [...modifiers.map((name) => PC_MODIFIERS[name]), key].join("+");
}

let isHoldingAwake = false;

/**
 * Keep this page from being put to sleep while the window is put away — on Windows.
 *
 * On macOS 14 and later the shell's own `backgroundThrottling: "disabled"` does this (measured:
 * desktop/README.md, "And the hidden page keeps running"). WebView2 on Windows has no such setting;
 * tauri-utils 2.9.3 names it unsupported there and points at a held Web Lock as the workaround. So
 * the page takes one lock and never lets it go. Unmeasured on Windows — there is no Windows machine
 * here — and it changes nothing where it is not needed. Once per page.
 */
export function holdShellAwake(): void {
  if (isHoldingAwake || !inShell()) return;
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return;
  isHoldingAwake = true;
  locks
    .request("laf-shell-awake", () => new Promise<never>(() => {}))
    .catch(() => {
      isHoldingAwake = false;
    });
}
