/**
 * The conversations themselves: start one, list them, read one.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { ProjectDeletion } from "./deleting";
import { parseChannelInput, parseProjectInput } from "./input";
import { mapRefusal, refusal } from "./refusals";
import type { AgentChannel, ChannelStore, ChannelSummary } from "./types";

export function createConversationRoutes(
  store: ChannelStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** Absent where nothing deletes a project: the door is then not there (404), not a no-op. */
  projectDeletion?: ProjectDeletion,
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

  /*
   * A project, beside the Bot's main conversation (piece 4-2). Its own door: `POST /` answers the
   * conversation a Bot already has, and this one always makes a new one, of kind `project`.
   * Registered before `/:channelId` reads, and a POST, so `projects` is never taken for an id.
   */
  routes.post("/projects", requireUser, async (context) => {
    const parsed = parseProjectInput(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) {
      return context.json({ error: parsed.code, code: parsed.code }, 400);
    }
    try {
      const channel = await store.createProject(
        context.var.actor,
        parsed.value.agentId,
        parsed.value.name,
      );
      return context.json({ channel: channelDto(channel) }, 201);
    } catch (error) {
      return mapRefusal(context, error);
    }
  });

  /*
   * Delete a project (piece 4-5): its conversation and every row that named it, in the order
   * `deleting.ts` holds. ITS PARAMETER IS `:projectId`, NOT `:channelId`, ON PURPOSE: the gate
   * refuses every write whose path names a conversation being deleted, and this is the one door
   * that must go on answering for one — asked again after a restart cut it short, it finishes.
   */
  if (projectDeletion) {
    routes.delete("/projects/:projectId", requireUser, async (context) => {
      try {
        const outcome = await projectDeletion.delete({
          userId: context.var.actor.id,
          channelId: context.req.param("projectId"),
        });
        if (!outcome.ok) {
          return context.json(
            refusal(outcome.code),
            outcome.code === "laf:channel_not_found" ? 404 : 409,
          );
        }
        return context.json({ deleted: true });
      } catch (error) {
        return mapRefusal(context, error);
      }
    });
  }

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
    kind: channel.kind,
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
