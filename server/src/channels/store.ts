/**
 * The channel store: each operation lives with its concern, and this only puts them together.
 *
 *   conversations.ts  starting one — the Bot's own, or a new channel with its thread
 *   roster.ts         what a person can see, and where they stopped reading
 *   activity.ts       the last thing said, as the browser that saw it reports it
 *   turn-failures.ts  the questions that never got an answer
 */
import type { AgentProfileStore } from "../agents/profile-store";
import type { Database } from "../db/client";
import { recordActivity } from "./activity";
import { createConversation } from "./conversations";
import type { AnnounceChannelActivity } from "./events";
import { listChannels, readChannel, setLastRead } from "./roster";
import type { ThreadIdentity } from "./thread-identity";
import { createTurnFailureReader } from "./turn-failures";
import type { ChannelStore } from "./types";

export function createChannelStore(
  database: Database,
  profileStore: AgentProfileStore,
  threadIdentity: ThreadIdentity,
  /**
   * Told what to announce, once the write that earned it has committed.
   *
   * Absent in tests that only care about the row, and absent is silence rather than an error: the
   * roster query is authoritative and a client that hears nothing refetches. See `events.ts`.
   */
  announce?: AnnounceChannelActivity,
): ChannelStore {
  return {
    create: (actor, agentIds) =>
      createConversation(
        { database, profileStore, threadIdentity },
        actor,
        agentIds,
      ),
    get: (actor, channelId) => readChannel(database, actor, channelId),
    list: (actor) => listChannels(database, actor),
    setLastRead: (actor, channelId, at, options) =>
      setLastRead(database, actor, channelId, at, options),
    recordActivity: (actor, channelId, activity) =>
      recordActivity(database, announce, actor, channelId, activity),
    // Nothing is written for this; it joins the run ledger to the transcript. See `turn-failures`.
    failuresFor: createTurnFailureReader(database),
  };
}
