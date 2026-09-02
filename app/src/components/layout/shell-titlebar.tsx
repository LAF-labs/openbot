import { inShell } from "@/lib/notifications/shell";

/**
 * THE 44px THE INSTALLED APP'S WINDOW BUTTONS SIT IN.
 *
 * The shell sets `titleBarStyle: "Overlay"`, which puts the traffic lights over the page rather
 * than in a bar of their own. The roster reserves a row for them (`bot-sidebar.tsx`); Settings and
 * Admin drew from the top of the window, so in the installed app the close button landed on top of
 * "환경 설정" and on the sidebar's first row. Measured on macOS, where the lights are top-left and
 * therefore over the rail rather than over the pane.
 *
 * Overlay also takes away the bar the window used to be dragged by, so the strip carries
 * `data-tauri-drag-region` and is the handle. Both are inert in a browser tab, which is why the
 * whole thing is behind `inShell()`: a tab has no traffic lights to make room for, and 44px of
 * empty space at the top of the web app would be a bug of its own.
 *
 * Read at render, not through a hook. `inShell()` answers from a global the shell injects before
 * the page loads; it cannot change while the page is open.
 */
export const ShellTitleBar = () =>
  inShell() ? (
    <div
      className="fixed inset-x-0 top-0 z-30 h-[var(--sand-titlebar-block)]"
      data-tauri-drag-region
    />
  ) : null;

/** The padding that keeps content out from under `ShellTitleBar`. Empty in a browser tab. */
export const shellTopInset = (): string =>
  inShell() ? "pt-[var(--sand-titlebar-block)]" : "";
