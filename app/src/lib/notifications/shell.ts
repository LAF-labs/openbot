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
 * behind others — which is the whole reason the person installed an app.
 */

type TauriGlobal = {
  core?: {
    invoke?: (
      command: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
  notification?: {
    isPermissionGranted?: () => Promise<boolean>;
    requestPermission?: () => Promise<string>;
    sendNotification?: (options: {
      title: string;
      body?: string;
      silent?: boolean;
    }) => void;
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
 * Show a native notification through the shell. Resolves false when there is no shell or it was
 * not permitted, so the caller can fall back to the webview's own `Notification`.
 *
 * The OS asks for permission on its own terms the first time; the answer is cached by the shell.
 */
export async function showShellNotice(options: {
  title: string;
  body: string;
  silent: boolean;
}): Promise<boolean> {
  const notification = shell()?.notification;
  if (!notification?.sendNotification) return false;
  try {
    let granted = (await notification.isPermissionGranted?.()) ?? false;
    if (!granted && notification.requestPermission) {
      granted = (await notification.requestPermission()) === "granted";
    }
    if (!granted) return false;
    notification.sendNotification({
      title: options.title,
      body: options.body,
      silent: options.silent,
    });
    return true;
  } catch {
    return false;
  }
}
