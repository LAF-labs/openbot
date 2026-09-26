/**
 * THE ACCOUNT'S SOCKET KNOWS WHETHER ANYBODY IS ON THE OTHER END.
 *
 * Both halves read this file: the page's socket (`app/src/lib/channels/use-channel-events.ts`) and
 * the server's (`server/src/channels/socket.ts`).
 *
 * WHY THE PAGE ITSELF HAS TO ANSWER. A WebSocket's own ping is answered by the network stack, not by
 * the page. A laptop that slept, or an app window whose web view the system suspended, keeps a
 * socket that the server believes is open and that the operating system still answers pings on,
 * while the page behind it runs nothing. The P2 measurement (2026-09-26) lost notices exactly
 * there: a frame was written to a socket nobody was reading, and the row was stamped delivered.
 * So liveness is an application frame, sent and answered by the page's own code, and a socket
 * counts only while it is heard from.
 *
 * WHO PINGS. The page, every `HEARTBEAT_MS`, to learn that its socket still reaches the server. And
 * the server, when it has not heard from a page for that long, because a browser tab that has been
 * hidden for five minutes fires its timers about once a minute (measured 2026-08-24: a one-second
 * timer's last gaps were 52 and 60 seconds) — but a message handler still runs at once, so a ping
 * from the server is still answered. Either side answers the other's ping with a pong.
 *
 * A CAPABILITY, DECLARED AT THE DOOR. A page from before this file never pings and never answers.
 * The server applies these rules only to a socket opened with `HEARTBEAT_PARAM`; one opened without
 * it is held the way every socket was before, so a window left open across the upgrade that brought
 * this in is not closed every half-minute for a silence it cannot help.
 */

/** The query parameter a page opens the feed with to say it pings and answers pings. */
export const HEARTBEAT_PARAM = "heartbeat";

/** How often the page pings, and how long the server lets a page go unheard before it pings. */
export const HEARTBEAT_MS = 10_000;

/** A ping, from either side. */
export const PING_FRAME = JSON.stringify({ kind: "ping" });

/** The answer to one, from either side. */
export const PONG_FRAME = JSON.stringify({ kind: "pong" });

/**
 * The code the server closes a socket with when its page has gone quiet for too long.
 *
 * The application's own range, like 4401 for a revoked session; `laf:heartbeat_missed` is the reason.
 */
export const HEARTBEAT_CLOSE_CODE = 4408;

export const HEARTBEAT_CLOSE_REASON = "laf:heartbeat_missed";

/** Whether a frame, as it came off the wire, is the ping or the pong above. */
export function heartbeatFrameKind(data: unknown): "ping" | "pong" | null {
  if (data === PING_FRAME) return "ping";
  if (data === PONG_FRAME) return "pong";
  return null;
}
