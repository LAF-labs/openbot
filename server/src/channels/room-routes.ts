/**
 * A ROOM'S TURN, RUN ON THE SERVER.
 *
 * A room is a channel with more than one Bot in it. Its turn does not run in the browser — several
 * Bots answering in rounds is a minute of work that must survive a closed tab, and two tabs must
 * not each drive their own version of it. The browser posts the message and then watches.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { createRoomService, RoomTurnStart } from "../rooms/service";
import { parseRoomTurnInput } from "./input";
import { mapRefusal, refusal } from "./refusals";
import type { ChannelStore } from "./types";

type RoomService = ReturnType<typeof createRoomService>;

/**
 * The two things these routes ask of the room service, in the service's own types.
 *
 * The input is the service's rather than a copy of it: the channel routes used to declare the same
 * shape again by hand (audit A1 §6), which is a second place for it to drift. The answer is
 * narrowed to what the route sends back — the promise a test waits on stays on the service.
 */
export type RoomTurns = {
  post: (
    input: Parameters<RoomService["post"]>[0],
  ) => Promise<Pick<RoomTurnStart, "turnId" | "messageId" | "epoch">>;
  stop: RoomService["stop"];
};

export function createRoomRoutes(
  store: ChannelStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  rooms: RoomTurns,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/:channelId/room-turn", requireUser, async (context) => {
    const parsed = parseRoomTurnInput(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) return context.json(refusal(parsed.code), 400);
    const channelId = context.req.param("channelId");
    const channel = await store.get(context.var.actor, channelId);
    if (!channel) return context.json(refusal("laf:channel_not_found"), 404);

    try {
      const started = await rooms.post({
        actor: {
          id: context.var.actor.id,
          role: context.var.actor.role === "admin" ? "admin" : "user",
        },
        actorLabel: context.var.actor.email,
        channelId,
        threadId: channel.threadId,
        text: parsed.value.text,
        ...(parsed.value.messageId !== undefined
          ? { messageId: parsed.value.messageId }
          : {}),
        addressedAgentIds: parsed.value.addressedAgentIds,
        personName: context.var.actor.name?.trim() || "User",
      });
      return context.json(
        {
          turnId: started.turnId,
          messageId: started.messageId,
          epoch: started.epoch,
        },
        202,
      );
    } catch (error) {
      return mapRefusal(context, error);
    }
  });

  routes.post("/:channelId/room-turn/stop", requireUser, async (context) => {
    try {
      await rooms.stop(context.var.actor, context.req.param("channelId"));
      return context.body(null, 204);
    } catch (error) {
      return mapRefusal(context, error);
    }
  });

  return routes;
}
