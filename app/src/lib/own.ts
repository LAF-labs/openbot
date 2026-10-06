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
 * "function Object() { [native code] }에 연결했어요". A table whose keys are one of this app's own
 * unions is typed by that union and needs none of this; the compiler holds what may index it.
 * `app/tests/own-keys.test.ts` finds every string-keyed table in `src/` and fails on a bare read.
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
