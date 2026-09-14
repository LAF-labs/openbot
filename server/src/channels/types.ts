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

/** A room's transcript, straight out of the snapshot column. See rooms/messages. */
export type ReadThreadMessages = (threadId: string) => Promise<unknown[]>;

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
   * Put another Bot into an existing conversation, or take one out.
   *
   * OPTIONAL, like `failuresFor` below and for the same reason: every fake store in the suite keeps
   * compiling, and a deployment without them serves 404 on the routes rather than a 500.
   *
   * There was no way to do either. A room's membership was decided once, when it was created, and
   * a person who wanted a fourth colleague in the conversation had to start a new room and lose
   * everything said in the old one.
   */
  addParticipant?: (
    actor: AgentActor,
    channelId: string,
    agentId: string,
  ) => Promise<AgentChannel>;
  removeParticipant?: (
    actor: AgentActor,
    channelId: string,
    agentId: string,
  ) => Promise<AgentChannel>;
  /**
   * The turns in this thread that ended without an answer.
   *
   * OPTIONAL, so every fake store in the suite keeps compiling and a deployment without it serves
   * an empty list rather than a 500. A transcript with no failure marks is what the app drew before
   * this existed, so absence degrades to exactly the old behaviour.
   */
  failuresFor?: (threadId: string) => Promise<TurnFailure[]>;
};
