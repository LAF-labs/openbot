/**
 * A stand-in for `fetch`, of the type `globalThis.fetch` actually has.
 *
 * In Bun `typeof fetch` is a callable WITH a `preconnect` method on it, so a bare arrow function is
 * not one — `as typeof fetch` on one is an assertion between types that do not overlap, which
 * TypeScript refuses outright. Nothing noticed while `app/tests` sat outside `tsc`. Attaching the
 * missing member makes the stub genuinely the thing it is being assigned to.
 */
export function stubFetch(
  handler: (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, {
    preconnect: () => {},
  }) as unknown as typeof fetch;
}
