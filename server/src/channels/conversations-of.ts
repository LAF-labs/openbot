/**
 * THE CONVERSATIONS THIS PERSON HAS, WITH THIS BOT OR WITH ANY: the one join every reader starts
 * from, with "not being deleted" built into it (review, 2026-10-10).
 *
 * A conversation is a channel this person is a member of and has a thread in — two of the four
 * rows one write makes (`conversations.ts` `writeConversation`) — holding the Bot asked for. Four
 * readers had written those joins out by hand, and three of them added `deleting_at IS NULL` by
 * hand too; a reader that forgets it shows a project while it is being deleted (`deleting.ts`).
 * So the condition is not a `where` a caller remembers to add: it is on the join, where nothing
 * a caller writes afterwards can replace it, and a reader that must see a conversation being
 * deleted — the deletion itself, the count behind the project limit — says `includingDeleting`
 * on the line that reads.
 *
 * What comes back is the query with its joins made and nothing narrowed, for the caller to
 * select from, narrow and order as it did before: `channels`, `channelMemberships`,
 * `channelThreads` and `channelAgents` are all in scope of its `where`.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { PgSelectBase, SelectedFields } from "drizzle-orm/pg-core";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
} from "../db/schema";

export type ConversationScope = {
  userId: string;
  /** One Bot's conversations. Absent, every Bot's: one row per Bot in each (`roster.ts`). */
  agentId?: string;
  /** Said where it is read, by the readers that mean it (the head of this file). */
  includingDeleting?: true;
};

/**
 * The query, with the four tables joined and open to more: dynamic, so the caller may go on
 * joining, narrowing and ordering it as it would have the chain it replaces.
 */
type Conversations<TSelection extends SelectedFields> = PgSelectBase<
  (typeof channels)["_"]["name"],
  TSelection,
  "partial",
  Record<
    | (typeof channels)["_"]["name"]
    | (typeof channelMemberships)["_"]["name"]
    | (typeof channelThreads)["_"]["name"]
    | (typeof channelAgents)["_"]["name"],
    "not-null"
  >,
  true
>;

export function conversationsOf<TSelection extends SelectedFields>(
  database: Pick<Database, "select">,
  selection: TSelection,
  { userId, agentId, includingDeleting }: ConversationScope,
): Conversations<TSelection> {
  /*
   * Joined on the selection's plain type and typed back on the way out. With the selection a type
   * parameter, the builder's own types cannot settle what a join returns, and the second join is
   * refused; the shape the caller gets is the one written above, which is what those joins make.
   */
  const fields: SelectedFields = selection;
  const query = database
    .select(fields)
    .from(channels)
    .$dynamic()
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channels.id),
        eq(channelMemberships.userId, userId),
        // One being deleted is not there any more, for every reader at once (`deleting.ts`).
        includingDeleting ? undefined : isNull(channels.deletingAt),
      ),
    )
    .innerJoin(
      channelThreads,
      and(
        eq(channelThreads.channelId, channels.id),
        eq(channelThreads.userId, userId),
      ),
    )
    .innerJoin(
      channelAgents,
      and(
        eq(channelAgents.channelId, channels.id),
        agentId ? eq(channelAgents.agentId, agentId) : undefined,
      ),
    );
  return query as Conversations<TSelection>;
}
