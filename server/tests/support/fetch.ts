/**
 * A stand-in for `fetch`, of the type the seams that take one actually declare.
 *
 * `testAgentConnection` and `ComputerClient` both take `fetchImpl?: typeof fetch`, and in Bun
 * `typeof fetch` is a callable WITH a `preconnect` method on it. Every stub in the suite is a bare
 * arrow function, so none of them satisfies that type — which nothing noticed while `server/tests`
 * sat outside `tsc`. Rather than scatter `as unknown as typeof fetch` (a cast that would go on
 * lying if the seam's shape ever changed for a reason that mattered), this attaches the one member
 * the stubs were missing, so the stub really is the thing the parameter asks for.
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
