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
import { mapRefusal, refusal } from "./refusals";
import type {
  ChannelStore,
  ReadMessageTimes,
  ReadThreadMessages,
} from "./types";

export function createTranscriptRoutes(
  store: ChannelStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  readMessageTimes: ReadMessageTimes | undefined,
  readThreadMessages: ReadThreadMessages | undefined,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /*
   * The room's transcript, read from the snapshot column directly.
   *
   * NOT the runtime's `/api/copilotkit/threads/:id/messages`: that route answers from what a run
   * put through the runner, and a room's messages are written by the server rather than by a run —
   * so a room read that way showed an empty screen.
   */
  routes.get("/:channelId/messages", requireUser, (context) =>
    fromVisibleThread(
      context,
      store,
      context.var.actor,
      context.req.param("channelId"),
      async (threadId) => ({
        messages: readThreadMessages ? await readThreadMessages(threadId) : [],
      }),
    ),
  );

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
         * No backfill for rows written before speakers were recorded. It used to fill them in with
         * the room's first member — true of how the old code ran, but recomputed on every request
         * against the CURRENT membership, so adding a Bot whose id sorts first relabelled the whole
         * pre-attribution history to somebody who was not in the room when it was said.
         * `attribute()` refuses to guess a speaker for exactly this reason; this now refuses too,
         * and an old message simply carries no name.
         */
        return { times: marks.times, speakers: marks.speakers };
      },
    ),
  );

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
