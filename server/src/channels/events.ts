/**
 * Live channel activity, from whoever ran an agent to everybody else in the channel.
 *
 * The person who ran it already has the reply and reports it over HTTP; this is the other direction,
 * telling the channel's other members that something was said. It is an optimisation and never a
 * source of truth: the roster query stays authoritative, and a client that misses events while
 * disconnected recovers by refetching on reconnect. Nothing may be knowable only through the socket.
 *
 * DELIVERED IN THIS PROCESS, AFTER THE COMMIT. It used to go out through Postgres LISTEN/NOTIFY on
 * a connection of its own, so that a second server instance would hear what the first announced —
 * a deployment this product does not have (docs/laf/deployment-model.md: one API process per VM).
 * The writer and every socket are on the same heap, so the carrier was a round trip, an 8000-byte
 * payload cap and a SIGINT handler that existed for nothing else.
 *
 * WHAT NOTIFY WAS GIVING FOR FREE, AND IS NOW SOMEBODY'S JOB: a NOTIFY issued inside a transaction
 * is delivered when it commits and never when it rolls back. So the rule that replaced it is that
 * the code owning the transaction announces, once the transaction has returned — never from inside
 * it. Announced early, a member's roster would move for a message that then rolled back, and the
 * only thing that would correct it is a refetch nobody has a reason to make.
 */
export type ChannelActivityEvent = {
  channelId: string;
  /** Who may receive it. Resolved by the writer, which already had to check membership. */
  memberIds: string[];
  /**
   * The channel's name as of this activity. Usually unchanged, but the first thing a person says
   * in a channel becomes its title, and the roster hears about that the same way it hears about
   * the message itself.
   */
  name: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
};

type Send = (payload: string) => void;

export type ChannelEventHub = {
  /** Attach a connection for a person. Returns the detach. */
  register(userId: string, send: Send): () => void;
  /**
   * Fan one event out to the connections open here.
   *
   * Called by whoever owns the transaction that wrote the thing being announced, once it has
   * committed. See the note at the top on what NOTIFY used to guarantee about that.
   */
  deliver(event: ChannelActivityEvent): void;
  /** Fan one room frame out. A turn produces one every few tokens, so it never goes near a write. */
  deliverRoom(frame: { memberIds: string[] } & Record<string, unknown>): void;
  connectionCount(userId: string): number;
};

export function createChannelEventHub(): ChannelEventHub {
  const connections = new Map<string, Set<Send>>();

  return {
    register(userId, send) {
      const existing = connections.get(userId) ?? new Set<Send>();
      existing.add(send);
      connections.set(userId, existing);

      return () => {
        const remaining = connections.get(userId);
        if (!remaining) return;
        remaining.delete(send);
        // Dropped entirely rather than left empty, so a long-lived process does not accumulate a
        // set per person who ever connected.
        if (remaining.size === 0) connections.delete(userId);
      };
    },

    deliverRoom(frame) {
      const payload = JSON.stringify(frame);
      for (const userId of frame.memberIds) {
        for (const send of connections.get(userId) ?? []) {
          try {
            send(payload);
          } catch {
            // Same rule as `deliver`: a connection that cannot be written to is one that is
            // closing, and failing here would deny the frame to everybody after it in the set.
          }
        }
      }
    },

    deliver(event) {
      for (const userId of event.memberIds) {
        for (const send of connections.get(userId) ?? []) {
          try {
            send(JSON.stringify(event));
          } catch {
            // A connection that cannot be written to is one that is closing. Its own close handler
            // detaches it; failing here would deny the event to everybody after it in the set.
          }
        }
      }
    },

    connectionCount(userId) {
      return connections.get(userId)?.size ?? 0;
    },
  };
}

/**
 * The announcement a write has earned, handed to whoever will deliver it after the commit.
 *
 * A function rather than the hub itself, so the things that write into a channel — the channel
 * store, the room transcript, a routine's delivery — depend on "somebody wants to be told" and not
 * on sockets. Absent in tests that only care about the row.
 */
export type AnnounceChannelActivity = (event: ChannelActivityEvent) => void;
