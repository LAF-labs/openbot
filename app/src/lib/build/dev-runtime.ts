/**
 * THE DEV SERVER REFUSES TO RUN UNDER A BUN WHOSE `node:http` CANNOT PROXY A WEBSOCKET.
 *
 * `bun run dev` runs the `vite` bin under Node when `node` is on PATH — that is its shebang — and
 * under Bun itself when it is not, or under `--bun`. On Bun 1.3.x Vite's proxy (http-proxy-3,
 * bundled into Vite 7) cannot carry a single websocket, for two reasons that are Bun's and not
 * Vite's, both measured on 1.3.14:
 *
 *  - Bun's `http.ClientRequest` never emits `upgrade` for a 101: it emits `response` with status
 *    101 and closes the socket (oven-sh/bun#18945). So every upgrade the API server accepts — the
 *    events socket, the live screen — goes down the proxy's "plain HTTP answer" branch, which
 *    relays the 101 line and then calls `socket.destroySoon()`.
 *  - The socket Bun hands the server's `upgrade` event is a Duplex of its own without `destroySoon`
 *    (oven-sh/bun#24127), so that call is `TypeError: socket.destroySoon is not a function` and the
 *    dev server exits — on the FIRST socket the app opens. Giving the socket a `destroySoon` keeps
 *    the process up and changes nothing else: a 101 still never reaches the browser, and neither
 *    does anything written to that socket while it stays open (a raw TCP tunnel in place of the
 *    proxy was tried too; the browser never saw its `open`). A dev server that stays up with no
 *    live screen and no events socket, and a notice about a lost connection a few seconds in, is
 *    worse than one that says why it will not start.
 *
 * Both are fixed on Bun's `main` (#31587 and #32488, 2026-07) and 1.4.0 (2026-08-20) is the first
 * release cut after them — `BUN_SERVES_FROM`. Not verified: the machine this was written on has
 * 1.3.14, as CI does. If a 1.4.x still fails, raise the floor; once CI's Bun passes it, this check
 * is dead and can go. `vite build` never reaches it: there is no proxy in a build.
 *
 * Here and not in `vite.config.ts`, where it is used, because the gate's app worker runs under
 * happy-dom's registrator and importing the config there — Vite and all — fails at load.
 */
export const BUN_SERVES_FROM = "1.4.0";

/** Why Vite's dev server will not start under this Bun, or `null` where it will — Node included. */
export function devServerRefusal(
  bunVersion: string | undefined,
): string | null {
  if (bunVersion === undefined) return null;
  const [major = 0, minor = 0] = bunVersion
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const [fromMajor = 0, fromMinor = 0] = BUN_SERVES_FROM.split(".").map(Number);
  if (major > fromMajor || (major === fromMajor && minor >= fromMinor)) {
    return null;
  }
  return (
    `Vite's dev server cannot proxy the API's websockets under Bun ${bunVersion}: ` +
    "Bun's node:http never emits 'upgrade' for a 101 (oven-sh/bun#18945) and hands the proxy a " +
    "socket without destroySoon (oven-sh/bun#24127), so the live screen and the events socket " +
    "never open and the first one exits the server. " +
    `Run it under Node — \`bun run dev\` does when \`node\` is on PATH — or on Bun ${BUN_SERVES_FROM} or later.`
  );
}
