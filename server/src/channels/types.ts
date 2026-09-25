/**
 * What a channel is, to the store that keeps it and to the routes that answer for it.
 *
 * Its own file so the store's parts and the routes' parts can all name these without importing
 * each other.
 */
import type { AgentActor } from "../agents/profile-types";
import type { TurnFailure } from "./turn-failures";

export type AgentChannel = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
};

/** A channel plus the last thing said in it, which is what a roster renders. */
export type ChannelSummary = AgentChannel & {
  lastMessage: string | null;
  lastMessageAt: Date | null;
  lastMessageAgentId: string | null;
  /** A Bot has spoken here since this person last looked. */
  unread: boolean;
  createdAt: Date;
};

/** When each message in a thread was first seen, and which Bot said it. See runner/message-times. */
export type ReadMessageTimes = (threadId: string) => Promise<{
  times: Record<string, string>;
  speakers: Record<string, string>;
}>;

/** What a client that ran an agent reports back about the message it just saw. */
export type ChannelActivity = {
  text: string;
  /** The agent that said it, or null when a person did. */
  agentId: string | null;
  at: Date;
};

export type ChannelStore = {
  create(actor: AgentActor, agentIds: string[]): Promise<AgentChannel>;
  get(actor: AgentActor, channelId: string): Promise<AgentChannel | null>;
  list(actor: AgentActor): Promise<ChannelSummary[]>;
  /**
   * Move this person's read mark for a channel.
   *
   * `at` rather than a "mark read" verb, so the same call serves both directions: opening a room
   * sets it to now, and "mark unread" sets it back before the last thing said.
   */
  setLastRead(
    actor: AgentActor,
    channelId: string,
    at: Date | null,
    options?: {
      /**
       * Only ever move the mark BACK. What "mark unread" means, and it has to be enforced against
       * the stored mark rather than computed by the caller, because reading it first and writing it
       * second is the same two statements with a race in between.
       */
      neverForward?: boolean;
    },
  ): Promise<{ previous: Date | null; at: Date | null }>;
  recordActivity(
    actor: AgentActor,
    channelId: string,
    activity: ChannelActivity,
  ): Promise<void>;
  /**
   * The turns in this thread that ended without an answer.
   *
   * OPTIONAL, so every fake store in the suite keeps compiling and a deployment without it serves
   * an empty list rather than a 500. A transcript with no failure marks is what the app drew before
   * this existed, so absence degrades to exactly the old behaviour.
   */
  failuresFor?: (threadId: string) => Promise<TurnFailure[]>;
  /**
   * The last picture of a browsing task, kept on its last action's result (`frames.ts`).
   *
   * Optional for the same reason: a store without them answers every picture as absent, and a card
   * with no picture is what the transcript draws for one anyway.
   */
  frameFor?: (threadId: string, toolCallId: string) => Promise<string | null>;
  /** The calls in a thread that have a kept picture, so the surface asks only for those. */
  framedCalls?: (threadId: string) => Promise<string[]>;
  keepFrame?: (
    threadId: string,
    toolCallId: string,
    frame: string,
  ) => Promise<boolean>;
  /** Whether the thread holds the Bot's call with this id, answered or not. */
  holdsCall?: (threadId: string, toolCallId: string) => Promise<boolean>;
};
