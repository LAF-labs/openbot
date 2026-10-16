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
import type { HubSocketFrame } from "../../shared/hub/protocol";
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
      let heardAt = Date.now();
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let remove: (() => void) | undefined;

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
          if (!closed) socket.close(1011, "laf:hub_unavailable");
        } finally {
          reading = false;
        }
      };

      return {
        onOpen(_event, socket) {
          remove = input.listeners.add({
            member: member.id,
            poke: () => void pull(socket),
            close: (code, reason) => socket.close(code, reason),
          });
          heartbeat = setInterval(() => {
            if (Date.now() - heardAt > SILENCE_PINGS * every) {
              socket.close(HEARTBEAT_CLOSE_CODE, HEARTBEAT_CLOSE_REASON);
              return;
            }
            socket.send(PING_FRAME);
          }, every);
          void pull(socket);
        },
        onMessage(event, socket) {
          heardAt = Date.now();
          if (heartbeatFrameKind(event.data) === "ping")
            socket.send(PONG_FRAME);
        },
        onClose() {
          closed = true;
          clearInterval(heartbeat);
          remove?.();
        },
      };
    },
  );
}
