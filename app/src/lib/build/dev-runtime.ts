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
 * 1.3.14, as CI does. If a 1.4.x still fails, raise the floor — to a patch, which is why the WHOLE
 * version is compared, and a prerelease of the floor (`1.4.0-canary.1`) counts as before it: a
 * canary cut before the fix merged carries the bug under the fixed number. Once CI's Bun passes
 * the floor, this check is dead and can go. `vite build` never reaches it: there is no proxy in a
 * build. The plugin that asks is in `vite.config.ts` (`devRuntime`); the sentence and the
 * comparison are here so the app's other code can read them without loading Vite.
 */
export const BUN_SERVES_FROM = "1.4.0";

/** `major.minor.patch` as numbers, and whether a prerelease tag follows (`1.4.0-canary.1`). */
function parse(version: string): { parts: number[]; isPrerelease: boolean } {
  const [release = "", prerelease] = version.split("-", 2);
  const parts = release
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return { parts: parts.slice(0, 3), isPrerelease: prerelease !== undefined };
}

/** Is this Bun before the floor — by every part of the version, a prerelease of the floor included. */
function isBefore(version: string, floor: string): boolean {
  const have = parse(version);
  const want = parse(floor);
  for (let index = 0; index < 3; index += 1) {
    const got = have.parts[index] ?? 0;
    const need = want.parts[index] ?? 0;
    if (got !== need) return got < need;
  }
  return have.isPrerelease && !want.isPrerelease;
}

/**
 * Why Vite's dev server will not start under this Bun, or `null` where it will — Node included.
 * `from` is the floor; a parameter so a test can hold the comparison against another one.
 */
export function devServerRefusal(
  bunVersion: string | undefined,
  from = BUN_SERVES_FROM,
): string | null {
  if (bunVersion === undefined) return null;
  if (!isBefore(bunVersion, from)) return null;
  return (
    `Vite's dev server cannot proxy the API's websockets under Bun ${bunVersion}: ` +
    "Bun's node:http never emits 'upgrade' for a 101 (oven-sh/bun#18945) and hands the proxy a " +
    "socket without destroySoon (oven-sh/bun#24127), so the live screen and the events socket " +
    "never open and the first one exits the server. " +
    `Run it under Node — \`bun run dev\` does when \`node\` is on PATH — or on Bun ${from} or later.`
  );
}
