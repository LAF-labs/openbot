/**
 * A FILE DROPPED WHERE NOTHING TAKES IT IS REFUSED, NOT OPENED.
 *
 * A webview's own answer to a file dropped on a page that did not claim it is to open the file in
 * place of the page. In a browser that costs a Back press. In the installed app it costs the app:
 * the window has no address bar and no Back, and what is left on screen is a PDF or a photo where
 * the conversation was, with the draft that was being typed gone with it. Nothing in the window
 * could reach this until the shell stopped taking file drops for itself (`dragDropEnabled: false`
 * in `desktop/src-tauri/tauri.conf.json`), which was what the composer's own drop needed.
 *
 * So a drag carrying files that no drop target has claimed is answered here: `dropEffect` none, so
 * the pointer says it will not land, and a drop that arrives anyway is cancelled. A drop target —
 * the composer's form — claims its drag by calling `preventDefault` first, and is left alone.
 * Listened for on the window in the bubbling phase, so every target has had its turn.
 */
export function guardStrayDrops(target: Window = window): () => void {
  const carriesFiles = (event: DragEvent) =>
    event.dataTransfer?.types.includes("Files") ?? false;

  const onDragOver = (event: DragEvent) => {
    if (event.defaultPrevented || !carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };
  const onDrop = (event: DragEvent) => {
    if (event.defaultPrevented || !carriesFiles(event)) return;
    event.preventDefault();
  };

  target.addEventListener("dragover", onDragOver);
  target.addEventListener("drop", onDrop);
  return () => {
    target.removeEventListener("dragover", onDragOver);
    target.removeEventListener("drop", onDrop);
  };
}
