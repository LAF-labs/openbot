/**
 * Who is in this conversation, changed while it is going on.
 *
 * Mounted only where the store can do it, so a deployment without those methods answers 404
 * rather than pretending the press worked. The refusals travel as codes; see
 * `ChannelMembershipError`.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { NOT_FOUND } from "../failure-text";
import { mapRefusal } from "./refusals";
import type { ChannelStore } from "./types";

export function createParticipantRoutes(
  store: ChannelStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/:channelId/participants", requireUser, async (context) => {
    if (!store.addParticipant)
      return context.json({ error: NOT_FOUND, code: NOT_FOUND }, 404);
    const body = (await context.req.json().catch(() => null)) as {
      agentId?: unknown;
    } | null;
    const agentId =
      typeof body?.agentId === "string" ? body.agentId.trim() : "";
    if (!agentId) {
      return context.json(
        { error: "laf:not_in_room", code: "laf:not_in_room" },
        400,
      );
    }
    try {
      const channel = await store.addParticipant(
        context.var.actor,
        context.req.param("channelId"),
        agentId,
      );
      return context.json({ channel });
    } catch (error) {
      return mapRefusal(context, error);
    }
  });

  routes.delete(
    "/:channelId/participants/:agentId",
    requireUser,
    async (context) => {
      if (!store.removeParticipant) {
        return context.json({ error: NOT_FOUND, code: NOT_FOUND }, 404);
      }
      try {
        const channel = await store.removeParticipant(
          context.var.actor,
          context.req.param("channelId"),
          context.req.param("agentId"),
        );
        return context.json({ channel });
      } catch (error) {
        return mapRefusal(context, error);
      }
    },
  );

  return routes;
}
