/**
 * The doors a window uses on a turn the server owns: hand over what the person said, watch the turn
 * from a cursor, stop it, answer a card, and read the history a page at a time.
 *
 *   POST /api/turns/:threadId                  what the person said; starts the turn
 *   GET  /api/turns/:threadId/stream           the turn as it happens (SSE), from a cursor
 *   GET  /api/turns/:threadId                  how the turn stands, for a window that asks once
 *   POST /api/turns/:threadId/stop             stop it, from any window
 *   GET  /api/turns/:threadId/history          a page of the conversation, newest first
 *   POST /api/turns/:threadId/answers/:call    a person's choice on a card the Bot is waiting on
 *   POST /api/turns/skips                      건너뛰기 on a help request
 *
 * Every one of them is the conversation's owner's alone, read from `channel_threads` — the same
 * fact the thread routes and the runner's roster ask — and the Bot has to be one they may drive.
 */
import type { Message, Tool } from "@ag-ui/client";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentActor } from "../agents/profile-types";
import { type AppVariables, mayDriveBot } from "../auth/guards";
import type { Database } from "../db/client";
import { channelAgents, channelThreads } from "../db/schema";
import type { TurnEngine } from "./engine";
import { HISTORY_PAGE, historyPage } from "./history";
import type { TurnFrame, TurnHub, TurnSnapshot } from "./hub";
import type { PersonAnswers } from "./people";

const THREAD_NOT_FOUND = "laf:thread_not_found";

/** How often a watching window is written to while nothing happens, so no proxy calls it idle. */
const KEEPALIVE_MS = 15_000;

/** The most tools a window may offer, and the most a description of them may weigh. */
const MAX_TOOLS = 200;
const MAX_TOOLS_BYTES = 400_000;

type Routes = Hono<{ Variables: AppVariables }>;

/** The tools a window offered, as far as they are tools; null when it offered none we can read. */
function toolsOf(value: unknown): Tool[] | null {
  if (!Array.isArray(value) || value.length > MAX_TOOLS) return null;
  if (JSON.stringify(value).length > MAX_TOOLS_BYTES) return null;
  const tools = value.filter(
    (tool): tool is Tool =>
      !!tool &&
      typeof tool === "object" &&
      typeof (tool as Tool).name === "string" &&
      typeof (tool as Tool).description === "string" &&
      !!(tool as Tool).parameters &&
      typeof (tool as Tool).parameters === "object",
  );
  return tools.length === value.length ? tools : null;
}

/** A cursor as a window sends it: `epoch:seq`, from the query or from EventSource's own header. */
function cursorOf(raw: string | undefined): {
  epoch: string | null;
  after: number | null;
} {
  if (!raw) return { epoch: null, after: null };
  const at = raw.lastIndexOf(":");
  if (at <= 0) return { epoch: null, after: null };
  const after = Number(raw.slice(at + 1));
  return {
    epoch: raw.slice(0, at),
    after: Number.isInteger(after) && after >= 0 ? after : null,
  };
}

export function createTurnRoutes(input: {
  database: Database;
  engine: TurnEngine;
  hub: TurnHub;
  people: PersonAnswers;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  keepaliveMs?: number;
}): Routes {
  const { database, engine, hub, people, requireUser } = input;
  const routes: Routes = new Hono();

  /** The conversation, if it is this person's. */
  const conversationOf = async (threadId: string, userId: string) => {
    const [row] = await database
      .select({
        userId: channelThreads.userId,
        channelId: channelThreads.channelId,
      })
      .from(channelThreads)
      .where(eq(channelThreads.threadId, threadId))
      .limit(1);
    return row && row.userId === userId ? row : null;
  };

  const notFound = { error: THREAD_NOT_FOUND, code: THREAD_NOT_FOUND };

  routes.post("/skips", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      botId?: unknown;
      toolCallId?: unknown;
    } | null;
    const botId = typeof body?.botId === "string" ? body.botId : "";
    const toolCallId =
      typeof body?.toolCallId === "string" ? body.toolCallId : "";
    if (!botId || !toolCallId || !(await mayDriveBot(context, botId))) {
      return context.json(
        { error: "laf:bot_not_found", code: "laf:bot_not_found" },
        404,
      );
    }
    people.skip(toolCallId);
    return context.json({ skipped: true });
  });

  routes.post("/:threadId", requireUser, async (context) => {
    const threadId = context.req.param("threadId");
    const actor = context.var.actor;
    const conversation = await conversationOf(threadId, actor.id);
    if (!conversation) return context.json(notFound, 404);
    const body = (await context.req.json().catch(() => null)) as {
      botId?: unknown;
      messages?: unknown;
      tools?: unknown;
      device?: unknown;
    } | null;
    const botId = typeof body?.botId === "string" ? body.botId : "";
    const [linked] = botId
      ? await database
          .select({ agentId: channelAgents.agentId })
          .from(channelAgents)
          .where(
            and(
              eq(channelAgents.channelId, conversation.channelId),
              eq(channelAgents.agentId, botId),
            ),
          )
          .limit(1)
      : [];
    if (!linked || !(await mayDriveBot(context, botId))) {
      return context.json(
        { error: "laf:bot_not_found", code: "laf:bot_not_found" },
        404,
      );
    }
    const messages = Array.isArray(body?.messages)
      ? (body.messages as Message[])
      : [];
    const owner: AgentActor = { id: actor.id, role: actor.role };
    const sent = await engine.send({
      threadId,
      channelId: conversation.channelId,
      owner,
      botId,
      messages,
      tools: toolsOf(body?.tools),
      ...(body?.device === undefined ? {} : { device: body.device }),
    });
    if (!sent.ok) {
      return context.json(
        { error: sent.code, code: sent.code },
        sent.code === "laf:turn_in_progress" ? 409 : 400,
      );
    }
    return context.json({ turnId: sent.turnId, epoch: hub.epoch }, 202);
  });

  routes.get("/:threadId", requireUser, async (context) => {
    const threadId = context.req.param("threadId");
    if (!(await conversationOf(threadId, context.var.actor.id))) {
      return context.json(notFound, 404);
    }
    const state = hub.state(threadId);
    return context.json({
      epoch: hub.epoch,
      seq: state.seq,
      turn: state.turn,
      busy: engine.busy(threadId),
      waiting: people.awaiting(threadId),
    });
  });

  routes.post("/:threadId/stop", requireUser, async (context) => {
    const threadId = context.req.param("threadId");
    if (!(await conversationOf(threadId, context.var.actor.id))) {
      return context.json(notFound, 404);
    }
    return context.json({ stopped: engine.stop(threadId) });
  });

  routes.post(
    "/:threadId/answers/:toolCallId",
    requireUser,
    async (context) => {
      const threadId = context.req.param("threadId");
      if (!(await conversationOf(threadId, context.var.actor.id))) {
        return context.json(notFound, 404);
      }
      const body = (await context.req.json().catch(() => null)) as {
        value?: unknown;
      } | null;
      const answered = people.answer(
        threadId,
        context.req.param("toolCallId"),
        body?.value ?? null,
      );
      return answered
        ? context.json({ answered: true })
        : context.json(
            { error: "laf:no_longer_waiting", code: "laf:no_longer_waiting" },
            409,
          );
    },
  );

  routes.get("/:threadId/history", requireUser, async (context) => {
    const threadId = context.req.param("threadId");
    if (!(await conversationOf(threadId, context.var.actor.id))) {
      return context.json(notFound, 404);
    }
    // Any whole number: a cursor is the store's own `seq`, which says nothing about its sign.
    const raw = context.req.query("before");
    const before = raw === undefined || raw === "" ? Number.NaN : Number(raw);
    const limit = Number(context.req.query("limit"));
    const page = await historyPage(database, threadId, {
      before: Number.isInteger(before) ? before : null,
      limit: Number.isInteger(limit) && limit > 0 ? limit : HISTORY_PAGE,
    });
    context.header("cache-control", "no-store");
    return context.json(page);
  });

  routes.get("/:threadId/stream", requireUser, async (context) => {
    const threadId = context.req.param("threadId");
    if (!(await conversationOf(threadId, context.var.actor.id))) {
      return context.json(notFound, 404);
    }
    // EventSource's own reconnect says where it was; a first open says it in the query.
    const cursor = cursorOf(
      context.req.header("last-event-id") ?? context.req.query("cursor"),
    );
    context.header("cache-control", "no-store");
    // Some proxies hold a stream back to compress it; this one must arrive as it is written.
    context.header("x-accel-buffering", "no");
    return streamSSE(context, async (stream) => {
      const queue: Array<TurnFrame | TurnSnapshot> = [];
      let wake: (() => void) | null = null;
      let closed = false;
      const unsubscribe = hub.subscribe(threadId, cursor, (frame) => {
        queue.push(frame);
        wake?.();
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        wake?.();
      });
      const keepalive = setInterval(() => {
        queue.push({ kind: "keepalive" } as unknown as TurnFrame);
        wake?.();
      }, input.keepaliveMs ?? KEEPALIVE_MS);
      try {
        while (!closed) {
          const frame = queue.shift();
          if (!frame) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
            continue;
          }
          if ((frame as { kind: string }).kind === "keepalive") {
            // An event rather than a comment: a comment never reaches the page, and the page is
            // what has to tell a quiet stream from a dead one (`watchTurn` in the app).
            await stream.writeSSE({ event: "ping", data: "{}" });
            continue;
          }
          await stream.writeSSE({
            id: `${hub.epoch}:${frame.seq}`,
            data: JSON.stringify(frame),
          });
        }
      } finally {
        clearInterval(keepalive);
        unsubscribe();
      }
    });
  });

  return routes;
}
