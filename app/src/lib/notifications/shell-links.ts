/**
 * Links, when the app is a window rather than a tab.
 *
 * Every link a Bot writes goes through `lib/markdown.tsx`, which renders it `target="_blank"` —
 * right in a browser, and inert in a webview, which has no second window to open. Before this,
 * clicking any link in any message inside the desktop shell did nothing whatsoever: no navigation,
 * no new window, no error. The same is true of the handful of `_blank` links elsewhere in the app.
 *
 * ONE LISTENER ON THE DOCUMENT, not a change to every link. A capturing listener catches the click
 * before React sees it, so links rendered by any component — today's and tomorrow's — are covered
 * without each of them having to know the app might be running in a shell.
 *
 * In a browser tab this installs nothing and the links behave exactly as they always have.
 */
import { inShell, openExternal } from "./shell";

/** Whether this click should be handed to the person's browser rather than to the webview. */
function externalLink(event: MouseEvent): string | null {
  // Modified clicks are the person asking their platform for something specific; leave them alone.
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return null;
  const anchor = (event.target as Element | null)?.closest?.("a");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.target !== "_blank") return null;
  const href = anchor.href;
  return href.startsWith("http://") || href.startsWith("https://")
    ? href
    : null;
}

/**
 * Start handing `_blank` links to the browser. Returns a function that stops again, so a caller in
 * React can clean up; in a browser tab it is a no-op both ways.
 */
export function handleShellLinks(): () => void {
  if (!inShell()) return () => {};
  const onClick = (event: MouseEvent) => {
    const href = externalLink(event);
    if (!href) return;
    /*
     * Prevented BEFORE the shell answers, not after. `openExternal` is a round trip to Rust, and by
     * the time it resolves the click is long over — a link that only prevented the default on
     * success would be a link that sometimes did nothing, depending on how busy the shell was.
     */
    event.preventDefault();
    void openExternal(href);
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}
