/**
 * `work`, and then `after` however `work` ended: `try`…`finally`, as a function.
 *
 * React Compiler 1.0 cannot compile a component that holds a `finally` anywhere in it, even in a
 * handler, and it leaves such a component exactly as written — uncompiled, re-rendering everything
 * under it the way the whole app did before the compiler (`app/tests/react-compiler.test.ts` counts
 * them). The statement is kept here, where no component is, and a component says
 * `await ensure(work, after)` instead.
 *
 * It may stand in for the statement only because it behaves as the statement does: `work` is called
 * at once, before `ensure` returns; `after` runs once whatever `work` returned has settled — or at
 * once, if `work` threw before returning anything; `work`'s value is passed on; and what `work`
 * threw reaches the caller after `after` has run. An `after` that throws wins over `work`'s outcome,
 * as a throw out of a `finally` would.
 */
export async function ensure<T>(
  work: () => T | Promise<T>,
  after: () => void,
): Promise<T> {
  try {
    return await work();
  } finally {
    after();
  }
}
