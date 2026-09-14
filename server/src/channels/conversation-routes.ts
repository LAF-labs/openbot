/**
 * The conversations themselves: start one, list them, read one.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { parseChannelInput } from "./input";
import { mapRefusal, refusal } from "./refusals";
import type { AgentChannel, ChannelStore, ChannelSummary } from "./types";

export function createConversationRoutes(
  store: ChannelStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/", requireUser, async (context) => {
    const parsed = parseChannelInput(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) {
      return context.json({ error: parsed.code, code: parsed.code }, 400);
    }

    try {
      const channel = await store.create(
        context.var.actor,
        parsed.value.agentIds,
      );
      return context.json({ channel: channelDto(channel) }, 201);
    } catch (error) {
      return mapRefusal(context, error);
    }
  });

  routes.get("/", requireUser, async (context) => {
    try {
      const channels = await store.list(context.var.actor);
      return context.json({ channels: channels.map(channelSummaryDto) });
    } catch (error) {
      return mapRefusal(context, error);
    }
  });

  routes.get("/:channelId", requireUser, async (context) => {
    try {
      const channel = await store.get(
        context.var.actor,
        context.req.param("channelId"),
      );
      if (!channel) {
        return context.json(refusal("laf:channel_not_found"), 404);
      }
      return context.json({ channel: channelDto(channel) });
    } catch (error) {
      return mapRefusal(context, error);
    }
  });

  return routes;
}

function channelDto(channel: AgentChannel): AgentChannel {
  return {
    id: channel.id,
    name: channel.name,
    agentIds: channel.agentIds,
    threadId: channel.threadId,
    active: channel.active,
  };
}

function channelSummaryDto(channel: ChannelSummary) {
  return {
    ...channelDto(channel),
    lastMessage: channel.lastMessage,
    // Serialised as ISO-8601 so the browser gets a string it can sort and format.
    lastMessageAt: channel.lastMessageAt?.toISOString() ?? null,
    lastMessageAgentId: channel.lastMessageAgentId,
    unread: channel.unread,
    createdAt: channel.createdAt.toISOString(),
  };
}
