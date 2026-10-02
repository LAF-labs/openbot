/**
 * A FILE DROPPED WHERE NOTHING TAKES IT IS LEFT ALONE, NOT OPENED.
 *
 * A browser's own answer to a file let go over a page that does not take it is to OPEN the file:
 * the page navigates to it. In a tab that is a spreadsheet where the conversation was and one
 * press of Back. In the installed app it is the whole app replaced by the file, in a window with
 * no address bar and no back button — the same way out of the app that a save link without
 * `download` was (`components/settings/export-button.tsx`). WebView2 and Chromium do it; WKWebView
 * has declined to since it stopped navigating on a drop by default.
 *
 * So the window says no to any file nobody below it claimed. A handler that takes a file calls
 * `preventDefault` — the composer's does, on the document — and that is how this knows to keep
 * out of the way. Text and links dragged about inside the page carry no files and are untouched.
 */
export function ignoreStrayDrops(
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  const refuse = (event: DragEvent) => {
    if (event.defaultPrevented) return;
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    // The pointer says so while the file is still held: nothing here will take it.
    event.dataTransfer.dropEffect = "none";
  };
  target.addEventListener("dragover", refuse);
  target.addEventListener("drop", refuse);
  return () => {
    target.removeEventListener("dragover", refuse);
    target.removeEventListener("drop", refuse);
  };
}
