/**
 * The live feed: one socket per open tab, told when a roster row moves. See `events.ts`.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { originRefusalBody, upgradeOriginAllowed } from "../auth/origin";
import type { ChannelEventHub } from "./events";
import { upgradeWebSocket } from "./socket";

export function createEventRoutes(
  events: ChannelEventHub,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  trustedOrigins: readonly string[],
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
      // Resolved at upgrade, not per message: the connection belongs to whoever authenticated it,
      // and nothing it later sends can change that.
      const { id: userId } = context.var.actor;
      let detach = () => {};
      return {
        onOpen: (_event, ws) => {
          detach = events.register(userId, (payload) => ws.send(payload));
        },
        onClose: () => detach(),
        onError: () => detach(),
      };
    }),
  );

  return routes;
}
