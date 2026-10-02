/**
 * WHAT WAS TYPED AND NOT SENT IS STILL IN THE BOX WHEN THE PERSON COMES BACK.
 *
 * Measured on the running app, 2026-10-02: "내일 오전 회의 안건 세 가지만 정리해" typed into the
 * conversation, 소식 opened, the conversation opened again — an empty box. Half a message is lost
 * by looking something up, which is what somebody halfway through a message does. The composer
 * held its text for one thing only, a reload for a new build (`lib/build-reload.ts`), and let go
 * of it whenever it left the screen.
 *
 * So the words are kept on the device as they are typed, by conversation, and handed back to that
 * conversation's composer when it is drawn again — after another screen, a reload, or the app
 * being quit and opened. Beside `outbox.ts`, and the same kind of thing: the person's own words,
 * on their own device, for as long as they have not been sent or taken back.
 *
 * Words only. A `/` skill chip comes back as its name, and a file that was attached is not kept:
 * it is on the server already, and what is kept here is what can be typed.
 */
const KEY_PREFIX = "laf:draft:";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // A browser that refuses storage outright (site data blocked) throws on the property itself.
    return null;
  }
}

/** Keep what is in this conversation's box. Nothing typed keeps nothing, and forgets what was. */
export function keepDraft(key: string, text: string): void {
  const store = storage();
  if (!store) return;
  try {
    if (text.trim()) store.setItem(`${KEY_PREFIX}${key}`, text);
    else store.removeItem(`${KEY_PREFIX}${key}`);
  } catch {
    // Full, or refused: the box still holds the words for as long as it is on screen.
  }
}

/** What was left in this conversation's box, or null. Read, not taken: the box may not be ready. */
export function keptDraft(key: string): string | null {
  try {
    const text = storage()?.getItem(`${KEY_PREFIX}${key}`);
    return text?.trim() ? text : null;
  } catch {
    return null;
  }
}
