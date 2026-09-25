/**
 * What a conversation's transcript is drawn from: the messages, when each was said and by whom, and
 * the questions that never got an answer.
 *
 * Keyed on the CHANNEL rather than the thread, even though all three are properties of the thread,
 * because the channel is where membership is enforced: `store.get` returns null for somebody who
 * is not in the room. A thread-keyed route would have had to re-derive that, and a transcript's
 * timing is enough to tell you when somebody was working.
 */
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentActor } from "../agents/profile-types";
import type { AppVariables } from "../auth/guards";
import { isKeepableFrame } from "./frames";
import { mapRefusal, refusal } from "./refusals";
import type { ChannelStore, ReadMessageTimes } from "./types";

export function createTranscriptRoutes(
  store: ChannelStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  readMessageTimes: ReadMessageTimes | undefined,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * The questions in this channel that never got an answer.
   *
   * Beside the transcript rather than inside it: a failure is not something anybody said, and the
   * transcript is replayed to the model on the next turn. See `turn-failures.ts`.
   */
  routes.get("/:channelId/failures", requireUser, (context) =>
    fromVisibleThread(
      context,
      store,
      context.var.actor,
      context.req.param("channelId"),
      async (threadId) => ({
        failures: store.failuresFor ? await store.failuresFor(threadId) : [],
      }),
    ),
  );

  routes.get("/:channelId/message-times", requireUser, (context) =>
    fromVisibleThread(
      context,
      store,
      context.var.actor,
      context.req.param("channelId"),
      async (threadId) => {
        const marks = readMessageTimes
          ? await readMessageTimes(threadId)
          : { times: {}, speakers: {} };
        /*
         * No backfill for rows written before speakers were recorded: `attribute()` refuses to guess
         * a speaker, this refuses too, and an old message simply carries no name.
         */
        return { times: marks.times, speakers: marks.speakers };
      },
    ),
  );

  /**
   * The last picture of a browsing task, as the image itself, so the card is an `<img>` and nothing
   * more — no JSON to unwrap, and the browser's own cache keeps it.
   *
   * `no-store` on the miss: the picture is kept a moment after the card first asks, and a cached
   * absence would hide it until the cache forgot.
   */
  /**
   * Which of this channel's browsing tasks have a kept picture, by call id.
   *
   * The card asks for a picture only when this says there is one: every ended card used to ask, and
   * every task that never kept one — from before pictures, or ended with a person at the wheel —
   * was a 404 in the console (0.5.4 QA).
   */
  routes.get("/:channelId/frames", requireUser, (context) =>
    fromVisibleThread(
      context,
      store,
      context.var.actor,
      context.req.param("channelId"),
      async (threadId) => ({
        toolCallIds: store.framedCalls ? await store.framedCalls(threadId) : [],
      }),
    ),
  );

  routes.get("/:channelId/frames/:toolCallId", requireUser, async (context) => {
    try {
      const channel = await store.get(
        context.var.actor,
        context.req.param("channelId"),
      );
      if (!channel) return context.json(refusal("laf:channel_not_found"), 404);
      const frame = store.frameFor
        ? await store.frameFor(
            channel.threadId,
            context.req.param("toolCallId"),
          )
        : null;
      if (!frame) {
        context.header("cache-control", "no-store");
        return context.json(refusal("laf:frame_not_found"), 404);
      }
      return context.body(Buffer.from(frame, "base64"), 200, {
        "content-type": "image/jpeg",
        // Written once, when its task ends. Private: it is a picture of somebody's screen.
        "cache-control": "private, max-age=86400",
      });
    } catch (error) {
      return mapRefusal(context, error);
    }
  });

  /**
   * Keep that picture. The surface makes it (`app/src/lib/computer/last-frame.ts`); this checks it
   * is what the surface makes — a small JPEG — and puts it on the task's last result.
   *
   * 202 while the call is in the thread and its result is not yet: the result arrives with the
   * next run's input — at once as a rule, and only with the person's next turn when the step was
   * stopped while its window was making it — and the surface asks again then. 404 is for a call
   * the thread does not hold, which asking again cannot change.
   */
  routes.put("/:channelId/frames/:toolCallId", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      jpeg?: unknown;
    } | null;
    const jpeg = body?.jpeg;
    if (!isKeepableFrame(jpeg)) {
      return context.json(refusal("laf:frame_invalid"), 400);
    }
    try {
      const channel = await store.get(
        context.var.actor,
        context.req.param("channelId"),
      );
      if (!channel) return context.json(refusal("laf:channel_not_found"), 404);
      const toolCallId = context.req.param("toolCallId");
      const kept = store.keepFrame
        ? await store.keepFrame(channel.threadId, toolCallId, jpeg)
        : false;
      if (!kept) {
        const early = store.holdsCall
          ? await store.holdsCall(channel.threadId, toolCallId)
          : false;
        if (early) return context.json({ waiting: true }, 202);
        return context.json(refusal("laf:frame_not_found"), 404);
      }
      return context.body(null, 204);
    } catch (error) {
      return mapRefusal(context, error);
    }
  });

  return routes;
}

/**
 * Something read off the thread behind a channel this person can see, as the answer — or the refusal
 * that says there is no such channel, which is the same answer as one they are not in.
 */
async function fromVisibleThread(
  context: Context,
  store: ChannelStore,
  actor: AgentActor,
  channelId: string,
  read: (threadId: string) => Promise<Record<string, unknown>>,
): Promise<Response> {
  try {
    const channel = await store.get(actor, channelId);
    if (!channel) return context.json(refusal("laf:channel_not_found"), 404);
    return context.json(await read(channel.threadId));
  } catch (error) {
    return mapRefusal(context, error);
  }
}
