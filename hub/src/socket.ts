import type { Context } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import {
  HEARTBEAT_CLOSE_CODE,
  HEARTBEAT_CLOSE_REASON,
  HEARTBEAT_MS,
  heartbeatFrameKind,
  PING_FRAME,
  PONG_FRAME,
} from "../../shared/channel-socket";
import { HUB_FACTS, type HubSocketFrame } from "../../shared/hub/protocol";
import type { Logger } from "../../shared/log";
import type { AuthedMember, MemberVariables } from "./auth";
import type { HubDatabase } from "./db/client";
import { eventsSince, headSeq, type Listeners } from "./events";

/**
 * How long a VM may go unheard before its socket is closed: three pings' worth. The hub pings every
 * `HEARTBEAT_MS` and any frame from the VM counts as heard, so a VM whose process stopped reading
 * (a frozen container, a host that slept) is let go in about thirty seconds instead of being
 * written to forever. The VM reconnects with its cursor and loses nothing.
 */
const SILENCE_PINGS = 3;

/**
 * Pings every `everyMs`, and calls `onSilent` once (then stops) when nothing has been heard for
 * three of them.
 *
 * THE PING MAY THROW, AND MUST NOT ESCAPE. Bun throws from `send` on a socket that is already
 * closing — a member who just left, a peer that dropped between two ticks — and an exception out of
 * a timer is an uncaught one, which `reportCrashes` turns into the whole hub exiting. The product's
 * channel heartbeat (`server/src/channels/socket.ts`, `startHeartbeat`) swallows it for the same
 * reason: a socket that cannot be written to is closing, and its close says so.
 */
export function startPings(input: {
  everyMs: number;
  ping: () => void;
  onSilent: () => void;
  now?: () => number;
}): { heard(): void; stop(): void } {
  const now = input.now ?? Date.now;
  let heardAt = now();
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearInterval(tick);
  };
  const tick = setInterval(() => {
    if (stopped) return;
    if (now() - heardAt > SILENCE_PINGS * input.everyMs) {
      stop();
      try {
        input.onSilent();
      } catch {
        // Closing a socket that is already closing; its close handler runs either way.
      }
      return;
    }
    try {
      input.ping();
    } catch {
      // See above: the socket is closing.
    }
  }, input.everyMs);
  return {
    heard: () => {
      heardAt = now();
    },
    stop,
  };
}

/**
 * `WS /hub/v1/events?since=<seq>`.
 *
 * What a socket sends is read from the table, never handed over by the writer: each commit that
 * wrote an event pokes every socket, and each socket reads what is new for its member since its
 * own cursor with the same query `/sync` uses. So the catch-up and the live tail are one loop, and
 * a reconnect with `since` gets exactly what was missed — no more, no fewer.
 *
 * With no `since`, the socket starts at the newest event: a VM with no cursor has nothing to
 * catch up on, and replaying a hub's whole history to it would be noise.
 */
export function eventSocket(input: {
  database: HubDatabase;
  listeners: Listeners;
  upgradeWebSocket: UpgradeWebSocket;
  log: Logger;
  /** `HEARTBEAT_MS`; shorter only in tests. */
  heartbeatMs?: number;
}) {
  const every = input.heartbeatMs ?? HEARTBEAT_MS;
  return input.upgradeWebSocket(
    (context: Context<{ Variables: MemberVariables }>) => {
      const member: AuthedMember = context.get("member");
      const asked = context.req.query("since");
      let cursor: number | null = asked === undefined ? null : Number(asked);
      let reading = false;
      let again = false;
      let closed = false;
      let pings: ReturnType<typeof startPings> | undefined;
      let expiry: ReturnType<typeof setTimeout> | undefined;
      let remove: (() => void) | undefined;
      /** Every way a socket ends goes through here, so no timer outlives it. */
      const finish = () => {
        closed = true;
        pings?.stop();
        clearTimeout(expiry);
        remove?.();
      };
      const closeSafely = (socket: WSContext, code: number, reason: string) => {
        try {
          socket.close(code, reason);
        } catch {
          // Already closing.
        }
      };

      const pull = async (socket: WSContext) => {
        if (closed) return;
        if (reading) {
          again = true;
          return;
        }
        reading = true;
        try {
          do {
            again = false;
            if (cursor === null) cursor = await headSeq(input.database);
            let more = true;
            while (more && !closed) {
              const page = await eventsSince(input.database, member.id, cursor);
              for (const event of page.events) {
                const frame: HubSocketFrame = { kind: "event", ...event };
                socket.send(JSON.stringify(frame));
              }
              cursor = page.seq;
              more = page.more;
            }
          } while (again && !closed);
        } catch (error) {
          input.log.warn("socket_read_failed", { error });
          // 1011: the hub could not read its own table. The VM reconnects with its cursor.
          if (!closed) closeSafely(socket, 1011, "laf:hub_unavailable");
        } finally {
          reading = false;
        }
      };

      return {
        onOpen(_event, socket) {
          /*
           * A socket keeps the pass it was opened with for as long as it lives, and nothing on it
           * asks again. So a socket on a pass that is running out — opened inside a rotation's
           * grace, or opened before a rotation (`Listeners.expirePass`) — is closed when the pass
           * stops working, and the VM reconnects with the pass it holds now.
           */
          const expireAt = (until: Date) => {
            clearTimeout(expiry);
            expiry = setTimeout(
              () => closeSafely(socket, 4401, HUB_FACTS.passRefused),
              Math.max(0, until.getTime() - Date.now()),
            );
          };
          remove = input.listeners.add({
            member: member.id,
            passHash: member.passHash,
            poke: () => void pull(socket),
            close: (code, reason) => closeSafely(socket, code, reason),
            expireAt,
            send: (frame) => {
              try {
                socket.send(frame);
              } catch {
                // A socket that cannot be written to is closing; its close handler runs either way.
              }
            },
          });
          if (member.passUntil) expireAt(member.passUntil);
          pings = startPings({
            everyMs: every,
            ping: () => socket.send(PING_FRAME),
            onSilent: () =>
              closeSafely(socket, HEARTBEAT_CLOSE_CODE, HEARTBEAT_CLOSE_REASON),
          });
          void pull(socket);
        },
        onMessage(event, socket) {
          pings?.heard();
          if (heartbeatFrameKind(event.data) === "ping") {
            try {
              socket.send(PONG_FRAME);
            } catch {
              // Closing.
            }
          }
        },
        onClose: finish,
        onError: finish,
      };
    },
  );
}
