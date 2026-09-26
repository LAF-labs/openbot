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
import { log } from "../log";

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

/** Whether the page behind a connection is still there. See `channels/socket.ts`, `startHeartbeat`. */
type IsLive = () => boolean;

const ALWAYS = () => true;

export type ChannelEventHub = {
  /**
   * Attach a connection for a person, how to close it, and how to tell whether its page is still
   * there. Returns the detach. A connection with no `isLive` counts for as long as it is attached:
   * a page from before the heartbeat, which cannot be judged by one.
   */
  register(
    userId: string,
    send: Send,
    close?: () => void,
    isLive?: IsLive,
  ): () => void;
  /**
   * Close every connection a person holds, because their sessions were ended — struck off the
   * sign-in list, or removed by an administrator (`auth/session-revocation.ts`).
   */
  closeFor(userId: string): number;
  /**
   * Fan one event out to the connections open here.
   *
   * Called by whoever owns the transaction that wrote the thing being announced, once it has
   * committed. See the note at the top on what NOTIFY used to guarantee about that.
   */
  deliver(event: ChannelActivityEvent): void;
  /** Fan one frame that is not a roster patch out — a notification, addressed on the frame. */
  deliverFrame(frame: { memberIds: string[] } & Record<string, unknown>): void;
  /**
   * How many of a person's connections have a page LISTENING behind them — not how many are open.
   *
   * The notification doors decide by this (`notifications/in-app.ts`): above zero, a frame goes
   * down the socket and the row is stamped delivered; at zero, the row waits for the next door and
   * a finished run writes a notice. A socket whose page went silent — a laptop asleep, a window
   * the system suspended — used to count here for as long as the operating system kept it open,
   * and every notice in that time was delivered to nobody (P2 measurement, 2026-09-26).
   */
  connectionCount(userId: string): number;
};

type Held = { close: () => void; isLive: IsLive };

export function createChannelEventHub(): ChannelEventHub {
  /** Each person's connections: how to write to one, how to close it, whether it is listening. */
  const connections = new Map<string, Map<Send, Held>>();

  return {
    register(userId, send, close = () => {}, isLive = ALWAYS) {
      const existing = connections.get(userId) ?? new Map<Send, Held>();
      existing.set(send, { close, isLive });
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

    closeFor(userId) {
      const held = connections.get(userId);
      if (!held) return 0;
      // Out of the map first: a frame delivered while these close must already find nobody here.
      connections.delete(userId);
      for (const { close } of held.values()) {
        try {
          close();
        } catch {
          // Already closing. The rest of this person's connections still have to go.
        }
      }
      log.info("activity_sockets_closed", {
        user: userId,
        sockets: held.size,
      });
      return held.size;
    },

    deliverFrame(frame) {
      const payload = JSON.stringify(frame);
      for (const userId of frame.memberIds) {
        for (const send of connections.get(userId)?.keys() ?? []) {
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
        for (const send of connections.get(userId)?.keys() ?? []) {
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
      let listening = 0;
      for (const { isLive } of connections.get(userId)?.values() ?? []) {
        if (isLive()) listening += 1;
      }
      return listening;
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
