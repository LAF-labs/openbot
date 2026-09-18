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
