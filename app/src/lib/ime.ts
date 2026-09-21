import type { KeyboardEvent } from "react";

/**
 * KOREAN IS NOT TYPED ONE KEY PER LETTER, AND ENTER IS ONE OF THE KEYS IT BORROWS.
 *
 * While an input method is assembling a syllable the keystrokes belong to the IME, not to the
 * page: each arrives with `isComposing` true (or, on the very first one, with `key === "Process"`
 * and `keyCode` 229, before `compositionstart` has fired). The Enter that finishes a syllable is
 * one of them — a Korean typist presses Enter to accept 한 and again to send — and so is the
 * Escape that abandons one.
 *
 * A handler that reads those as the person's own Enter acts on a word that is still being written:
 * measured on the Bot's name field, typing "가게" and accepting the syllable blurred the field and
 * saved, which is a save of whatever had been assembled so far. `live-screen.tsx` has carried this
 * check inline since rooms could be driven; this is the same check, named, so the next keydown
 * handler that needs it can find it.
 *
 * It is the wrong question for a printable key — `key.length === 1` with `isComposing` false is
 * already the person's own keystroke — and the right one for Enter, Escape, Backspace and Tab.
 */
export function isImeKey(
  event: KeyboardEvent | globalThis.KeyboardEvent,
): boolean {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return (
    native.isComposing || event.key === "Process" || native.keyCode === 229
  );
}
