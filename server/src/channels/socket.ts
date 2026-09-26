import { createBunWebSocket } from "hono/bun";
import { HEARTBEAT_MS } from "../../../shared/channel-socket";

/**
 * The one WebSocket adapter for the process.
 *
 * `createBunWebSocket` pairs a route-side `upgradeWebSocket` with a server-side `websocket` handler,
 * and the two halves have to come from the same call. Bun is given the handler once, when the
 * server starts, and it has to be the one the routes upgraded through. Calling it per route would
 * upgrade connections into a handler nothing is listening on.
 */
const { upgradeWebSocket, websocket } = createBunWebSocket();

export { upgradeWebSocket, websocket };

/**
 * The server's half of the heartbeat (`shared/channel-socket.ts` says why there is one).
 *
 * Bun's own `idleTimeout` and `sendPings` are protocol frames, and a suspended page's socket still
 * answers those: the network stack does it, not the page. Only a frame the page's code sends back
 * proves the page is there, so this keeps the time a page was last heard from, and nothing else.
 */
export type HeartbeatTiming = {
  /** How long a page may go unheard before the server pings it. */
  pingAfterMs: number;
  /** How long after it was last heard a page still counts as listening. */
  liveForMs: number;
  /** How long a page may go unheard before its socket is given up on. */
  closeAfterMs: number;
  /** How often the silence is looked at. */
  tickMs: number;
};

/**
 * WHY THESE NUMBERS. A page in view pings every ten seconds, so it is heard every ten plus a round
 * trip. A tab hidden long enough to have its timers throttled is pinged by the server once it has
 * been quiet for ten, looked at every five, so it answers within fifteen plus a round trip. Twenty-
 * five seconds of listening covers both with room for a busy page; every second past that is a
 * second a notice could be written to nobody and stamped delivered. Forty-five before the socket is
 * closed: three missed pings, never a throttled tab that is still answering.
 */
export const HEARTBEAT_TIMING: HeartbeatTiming = {
  pingAfterMs: HEARTBEAT_MS,
  liveForMs: 25_000,
  closeAfterMs: 45_000,
  tickMs: 5_000,
};

export type Heartbeat = {
  /** The page said something — a ping, a pong, anything at all. */
  heard(): void;
  /** Whether the page has been heard from recently enough to count as listening. */
  isLive(): boolean;
  stop(): void;
};

export function startHeartbeat(input: {
  /** Ping the page. May throw when the socket is already closing; that is the silence's to judge. */
  ping: () => void;
  /** The page has been silent past `closeAfterMs`. Called once, and the heartbeat stops. */
  onSilent: () => void;
  timing?: HeartbeatTiming;
  now?: () => number;
}): Heartbeat {
  const timing = input.timing ?? HEARTBEAT_TIMING;
  const now = input.now ?? Date.now;
  // Opening is hearing: the page just did the one thing only a page can do.
  let lastHeard = now();
  let stopped = false;

  const tick = setInterval(() => {
    const silence = now() - lastHeard;
    if (silence >= timing.closeAfterMs) {
      stop();
      input.onSilent();
      return;
    }
    if (silence >= timing.pingAfterMs) {
      try {
        input.ping();
      } catch {
        // A socket that cannot be written to is closing, and its close will say so.
      }
    }
  }, timing.tickMs);

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(tick);
  }

  return {
    heard: () => {
      lastHeard = now();
    },
    isLive: () => !stopped && now() - lastHeard < timing.liveForMs,
    stop,
  };
}
