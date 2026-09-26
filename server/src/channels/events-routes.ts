/**
 * The live feed: one socket per open tab, told when a roster row moves. See `events.ts`.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  HEARTBEAT_CLOSE_CODE,
  HEARTBEAT_CLOSE_REASON,
  HEARTBEAT_PARAM,
  heartbeatFrameKind,
  PING_FRAME,
  PONG_FRAME,
} from "../../../shared/channel-socket";
import { CONNECTION_PROBE_PARAM } from "../../../shared/support/connection-check";
import type { AppVariables } from "../auth/guards";
import { originRefusalBody, upgradeOriginAllowed } from "../auth/origin";
import type { ChannelEventHub } from "./events";
import {
  type Heartbeat,
  type HeartbeatTiming,
  startHeartbeat,
  upgradeWebSocket,
} from "./socket";

/**
 * What a probe is answered with: the one frame this socket ever sends first.
 *
 * `kind`, like every frame the feed carries, so a reader that switches on it never mistakes this for
 * a roster row — though no reader but the connection check ever asks for one.
 */
export const EVENTS_PROBE_FRAME = JSON.stringify({ kind: "probe" });

export function createEventRoutes(
  events: ChannelEventHub,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  trustedOrigins: readonly string[],
  /** The heartbeat's clock, shortened by a test; production takes the default. */
  heartbeatTiming?: HeartbeatTiming,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get(
    "/events",
    requireUser,
    /*
     * Where the socket was opened from, before it is upgraded at all.
     *
     * `requireUser` proves who is asking and not where from, and a browser sends the session
     * cookie on a socket opened by any same-site page — which on this product means any other
     * customer's deployment. A handshake with no `Origin` is refused too: browsers always send
     * one, and nothing but a browser opens this.
     */
    async (context, next) => {
      if (!upgradeOriginAllowed(context.req.raw.headers, trustedOrigins)) {
        return context.json(originRefusalBody, 403);
      }
      await next();
    },
    upgradeWebSocket((context) => {
      /*
       * THE CONNECTION CHECK'S SOCKET (`app/src/lib/support/connection-check.ts`): through the
       * session and the origin like any other, then one frame and a close.
       *
       * The feed sends nothing of its own accord until something moves, so a socket opened only to
       * see whether this network lets one through would wait on silence and learn nothing. And it is
       * NEVER registered with the hub. A notification counts as delivered once a socket of its
       * person's took it (`notifications/in-app.ts`): a check's socket counted there could take a
       * frame meant for the app's own and close with it, and the row would say it had arrived.
       */
      if (context.req.query(CONNECTION_PROBE_PARAM) !== undefined) {
        return {
          onOpen: (_event, ws) => {
            ws.send(EVENTS_PROBE_FRAME);
            ws.close(1000, "laf:probe_answered");
          },
        };
      }
      // Resolved at upgrade, not per message: the connection belongs to whoever authenticated it,
      // and nothing it later sends can change that.
      const { id: userId } = context.var.actor;
      // Asked for by the page (`shared/channel-socket.ts`); a page from before it is held as before.
      const isHeartbeat = context.req.query(HEARTBEAT_PARAM) !== undefined;
      let heartbeat: Heartbeat | undefined;
      let detach = () => {};
      const release = () => {
        heartbeat?.stop();
        detach();
      };
      return {
        onOpen: (_event, ws) => {
          if (isHeartbeat) {
            heartbeat = startHeartbeat({
              ping: () => ws.send(PING_FRAME),
              /*
               * OUT OF THE HUB FIRST, THEN CLOSED. A close on a connection whose other end is gone
               * waits on a handshake nobody will finish, and `onClose` with it; a notice in that
               * wait must already find nobody here.
               */
              onSilent: () => {
                detach();
                ws.close(HEARTBEAT_CLOSE_CODE, HEARTBEAT_CLOSE_REASON);
              },
              timing: heartbeatTiming,
            });
          }
          detach = events.register(
            userId,
            (payload) => ws.send(payload),
            // Their sessions were ended: 4401, the application's own code for the 401 every door answers.
            () => ws.close(4401, "laf:session_revoked"),
            heartbeat?.isLive,
          );
        },
        onMessage: (event, ws) => {
          // Anything the page says is the page being there; a ping is also owed its answer.
          heartbeat?.heard();
          if (heartbeatFrameKind(event.data) === "ping") ws.send(PONG_FRAME);
        },
        onClose: release,
        onError: release,
      };
    }),
  );

  return routes;
}
