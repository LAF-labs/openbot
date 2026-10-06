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
 * `app/tests/own-keys.test.ts` walks `src/` so that a table indexed bare by a code fails a run.
 */
export function own<Value>(
  table: Readonly<Record<string, Value>>,
  key: string | null | undefined,
): Value | undefined {
  return typeof key === "string" && Object.hasOwn(table, key)
    ? table[key]
    : undefined;
}
