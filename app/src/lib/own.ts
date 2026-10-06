/**
 * What a table holds under a key — only what this code put there.
 *
 * NEVER `TABLE[code]` WITH A CODE THAT ARRIVED FROM OUTSIDE. The app keeps its sentences in tables
 * and looks them up by the code a response, a tool's result or a connected service's answer
 * carries. A plain object answers to more names than it was given: `constructor` is one, and it
 * answers with a function. Indexed bare, that code "had a sentence", `t()` handed the function
 * back, and a component was given a function where a string belongs — React draws nothing and
 * says so in the console. A connected service's answer that matches our envelope can carry any
 * `code` it likes, so this was live (the second read of #114, 2026-10-06; the same hole was closed
 * in `shared/` by #119 and #114, and in the control plane's count merging the same night).
 *
 * THE RULE, AND IT HAS NO EXCEPTION: a table declared with `string` keys is read through this.
 * Not "where the key is called `code`" — the first version of this change swept those, and a
 * second reader found the same answer under other names: a step's line by the tool's name (a model
 * writes it), a notice by an event's name, a refusal by a word in the address, and `t()` itself,
 * which read its dictionary bare: `?connected=constructor` said
 * "function Object() { [native code] }에 연결했어요". `app/tests/own-keys.test.ts` finds every
 * string-keyed table declared in `src/` and fails on a bare read.
 *
 * WHAT THAT TEST DOES NOT SEE, so that nobody reads it as more. A table keyed by one of this
 * app's own unions is typed by that union, and the compiler holds what OUR code may index it with
 * — not what a model's arguments turn out to be at run time: a gallery card's `tone` is typed as
 * one of four and arrives unchecked, so `TONES[tone]` and `TONE_WORD[tone]` read through this too.
 * A table declared in `shared/` and indexed here is outside the walk (`activity.tsx` reads one
 * through this). And a record handed in as a parameter or a prop — a message's time, a rating, by
 * a message's id — is found only if somebody thinks of it. Where the key is somebody else's word,
 * read through this, whatever the type says.
 *
 * `hasOwnProperty.call`, not `Object.hasOwn`: `t()` reads through this, and `t()` also draws the
 * notice shown on an engine too old for the app, where `Object.hasOwn` may not exist.
 */
export function own<Value>(
  table: Readonly<Record<string, Value>>,
  key: string | null | undefined,
): Value | undefined {
  return typeof key === "string" &&
    // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn may not exist where the too-old-engine notice is drawn, and t() reads through this
    Object.prototype.hasOwnProperty.call(table, key)
    ? table[key]
    : undefined;
}
