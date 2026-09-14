/**
 * What a roster row says: the last thing said in a conversation, and whether this person has read it.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentActor } from "../agents/profile-types";
import type { AppVariables } from "../auth/guards";
import { parseActivityInput } from "./input";
import { mapRefusal, refusal } from "./refusals";
import type { ChannelStore, ReadMessageTimes } from "./types";

/** Both ends of the unread window, as the browser reads them. */
type ReadWindow = { previousReadAt: string | null; readAt: string | null };

export function createRosterRoutes(
  store: ChannelStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  readMessageTimes: ReadMessageTimes | undefined,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/:channelId/activity", requireUser, async (context) => {
    const parsed = parseActivityInput(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) {
      return context.json({ error: parsed.code, code: parsed.code }, 400);
    }

    try {
      await store.recordActivity(
        context.var.actor,
        context.req.param("channelId"),
        parsed.value,
      );
      return context.body(null, 204);
    } catch (error) {
      return mapRefusal(context, error);
    }
  });

  /**
   * Move the caller's read mark. `{ read: true }` on open, `{ read: false }` for "mark unread".
   *
   * Marking unread sets the mark to one millisecond BEFORE the last thing said rather than to null.
   * Null means "never opened", and a room you have read and deliberately flagged to come back to is
   * not the same as one you have never seen — collapsing them would lose the distinction the moment
   * anybody used the feature.
   */
  routes.post("/:channelId/read", requireUser, async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const read =
      typeof body === "object" && body !== null
        ? (body as { read?: unknown }).read
        : undefined;
    if (typeof read !== "boolean") {
      return context.json(refusal("laf:read_flag_invalid"), 400);
    }

    try {
      const channelId = context.req.param("channelId");
      if (read) {
        return context.json(
          await markRead(store, context.var.actor, channelId),
        );
      }
      const marked = await markUnread(
        store,
        readMessageTimes,
        context.var.actor,
        channelId,
      );
      if (!marked) return context.json(refusal("laf:channel_not_found"), 404);
      return context.json(marked);
    } catch (error) {
      return mapRefusal(context, error);
    }
  });

  return routes;
}

async function markRead(
  store: ChannelStore,
  actor: AgentActor,
  channelId: string,
): Promise<ReadWindow> {
  const readAt = new Date();
  const { previous } = await store.setLastRead(actor, channelId, readAt);
  /*
   * Both ends of the unread window, on the server's clock — the clock the message stamps
   * are on. `previousReadAt` is where the reading stopped; `readAt` is where it resumed. A
   * reply that lands AFTER `readAt` was watched arrive, and a line drawn above it would tell
   * the person they had missed the thing they just read.
   */
  return {
    previousReadAt: previous?.toISOString() ?? null,
    readAt: readAt.toISOString(),
  };
}

/** Null when this person cannot see the channel, which the route answers as not found. */
async function markUnread(
  store: ChannelStore,
  readMessageTimes: ReadMessageTimes | undefined,
  actor: AgentActor,
  channelId: string,
): Promise<ReadWindow | null> {
  /*
   * THE BOUNDARY COMES FROM THE MESSAGE STAMPS, NOT FROM `last_message_at`.
   *
   * Those are two different clocks for the same event. `last_message_at` is reported by the
   * browser once a reply has finished arriving; a message's own stamp is taken on the server as
   * it STARTS streaming, which is earlier by however long the answer took. Marking unread
   * against the browser's clock therefore placed the mark after every message the transcript
   * knows about, and the "unread from here" line had nothing left to sit above — it silently
   * did nothing, which is exactly how it first shipped.
   *
   * Read state is compared against message stamps, so it is set from message stamps.
   */
  const channel = await store.get(actor, channelId);
  if (!channel) return null;
  const marks = readMessageTimes
    ? await readMessageTimes(channel.threadId)
    : { times: {}, speakers: {} };
  const newest = Object.values(marks.times)
    .map((iso) => new Date(iso).getTime())
    .filter((value) => !Number.isNaN(value))
    .reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY);
  /*
   * NEVER FORWARDS. Marking unread moves the boundary BACK to just before the newest thing
   * said, and taking that literally moved it forward on a room that already had unread
   * messages: five replies somebody had not read collapsed to one, because the mark jumped
   * past the other four. "I have not read this" cannot be an instruction that marks four
   * messages read. The reference product takes the same minimum
   * (`Math.min(lastViewedAt, …)`); this is that, with the existing mark included.
   */
  const wanted = Number.isFinite(newest) ? new Date(newest - 1) : null;
  const { previous, at: mark } = await store.setLastRead(
    actor,
    channelId,
    wanted,
    { neverForward: true },
  );
  return {
    previousReadAt: previous?.toISOString() ?? null,
    readAt: mark?.toISOString() ?? null,
  };
}
