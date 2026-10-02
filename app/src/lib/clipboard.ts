/**
 * Put words on the clipboard, and say whether they got there.
 *
 * The async Clipboard API is the one door, in a browser tab and in the desktop shell alike: the
 * shell is a webview on the deployed origin, which is a secure context, and every caller here writes
 * in answer to a press — the user activation both engines ask for. No shell command is involved, so
 * the shell's capability list (`desktop/src-tauri/capabilities`) grants nothing for it.
 *
 * FALSE RATHER THAN A FALSE "COPIED". `navigator.clipboard` is undefined on an insecure origin, and
 * `navigator.clipboard?.writeText(…)` then evaluates to undefined — which awaits cleanly, so the copy
 * button this replaced drew its check mark over a clipboard nothing had been written to.
 * `writeText` also rejects when the document is not focused. Both are the same fact for a caller:
 * say nothing happened, because nothing did.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard =
    typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== "function") return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Put an answer on the clipboard as words and, where the clipboard takes it, as it was drawn.
 *
 * Two flavours in one item, so the thing pasted into picks: a chat box takes the words, a document
 * takes the table. Where only words can be written — no `ClipboardItem`, or the engine refuses the
 * write — the words go by themselves, which is what this did before it knew of anything else.
 * False only when nothing reached the clipboard at all.
 */
export async function copyRich(parts: {
  text: string;
  html: string | null;
}): Promise<boolean> {
  const clipboard =
    typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (
    parts.html &&
    clipboard &&
    typeof clipboard.write === "function" &&
    typeof ClipboardItem !== "undefined"
  ) {
    try {
      await clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([parts.text], { type: "text/plain" }),
          "text/html": new Blob([parts.html], { type: "text/html" }),
        }),
      ]);
      return true;
    } catch {
      // Refused as a rich item — some engines take only text. The words alone, below.
    }
  }
  return copyText(parts.text);
}
