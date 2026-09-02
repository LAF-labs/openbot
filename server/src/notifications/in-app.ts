/**
 * The door the page itself is: one frame down the socket the roster already keeps open.
 *
 * WHAT IT REPLACES. The app worked out "a Bot is waiting" from the tab the question was raised in
 * (`app/src/lib/notifications/use-bot-notifications.ts`), which is exactly right for a question the
 * person's own click caused and reaches nothing for a question raised by a routine, by a room turn
 * on the server, or in the other window. The socket is the one thing this deployment already has
 * open to every signed-in page, so it is where the frame goes.
 *
 * A FRAME IS AN OPTIMISATION AND NEVER A SOURCE OF TRUTH — the rule `channels/events.ts` opens
 * with, and it holds here for the same reason. The row is the truth and `GET /api/me/notifications`
 * is how a page that missed a frame catches up. So the frame carries the id and the facts, the page
 * reads the door, and a reconnect recovers whatever happened while it was away.
 *
 * DELIVERED ONLY WHEN SOMEBODY IS LISTENING. `connectionCount` is asked first, and a frame written
 * to nobody reports false so the row stays undelivered for the next door and for the next page
 * load. This is the difference between "the page had it the whole time" and "nobody was there",
 * which is the difference `delivered_via` exists to record.
 */
import type { ChannelActivityEvent, ChannelEventHub } from "../channels/events";
import type {
  NotificationAdapter,
  NotificationOutbox,
  NotificationRecord,
} from "./outbox";

/**
 * The frame, as the page receives it.
 *
 * `kind: "notification"` is the discriminator, in the same position the room frames put theirs
 * (`rooms/frames.ts`), because the socket's other traffic — the roster's activity event — is
 * recognised by having no `kind` at all. A frame the page does not recognise must be ignorable, and
 * a frame that got spread onto a roster row would put `approvalId` on something the sidebar draws.
 *
 * `event` is the outbox kind rather than a second `kind`, so the two words are never confused: one
 * says what sort of frame this is on the wire, the other says what happened.
 *
 * Declared again in `app/src/lib/notifications/outbox.ts`, deliberately and for the reason the room
 * frames are: the app's tsconfig includes only its own `src`, and a type that resolved across that
 * boundary today would break the first time somebody tightened the include.
 */
export type NotificationFrame = {
  kind: "notification";
  /** The outbox row. What the page sends back to `POST /api/me/notifications/:id/seen`. */
  id: string;
  event: string;
  botId: string;
  approvalId?: string;
  channelId?: string;
  subject?: Record<string, unknown>;
  at: string;
};

export function notificationFrame(
  record: NotificationRecord,
): NotificationFrame {
  return {
    kind: "notification",
    id: record.id,
    event: record.kind,
    botId: record.botId,
    ...(record.approvalId ? { approvalId: record.approvalId } : {}),
    ...(record.channelId ? { channelId: record.channelId } : {}),
    ...(record.subject
      ? { subject: record.subject as unknown as Record<string, unknown> }
      : {}),
    at: record.createdAt,
  };
}

/** What this door needs of the hub, which is two of its four methods. */
export type NotificationSockets = Pick<
  ChannelEventHub,
  "deliverRoom" | "connectionCount"
>;

export function createSocketAdapter(
  hub: NotificationSockets,
): NotificationAdapter {
  return {
    name: "socket",
    deliver: async (record) => {
      if (hub.connectionCount(record.userId) === 0) return false;
      // `deliverRoom` is the hub's fan-out for a frame that is not a roster patch; it takes the
      // recipients on the frame itself. One person here, because a notification is addressed.
      hub.deliverRoom({
        memberIds: [record.userId],
        ...notificationFrame(record),
      });
      return true;
    },
  };
}

/**
 * "A routine or a room turn finished while nobody watched" — the second clause of the field rule.
 *
 * WHY IT IS CONDITIONAL ON THE SOCKET. A person with the app open already hears the activity event
 * and the page decides for itself whether to raise anything (`decideNotice`, which stays quiet for
 * the room on screen). Writing a row for that would be a second notification for something they are
 * looking at, and thirty rows an hour in a busy room. Nobody connected is the case the outbox
 * exists for: the answer is in the room when they come back, and now so is a notification saying so.
 *
 * A person's own message is never news, which is why an event with no Bot behind it writes nothing.
 */
export function createFinishedNotice(
  hub: Pick<ChannelEventHub, "connectionCount">,
  outbox: NotificationOutbox,
): (event: ChannelActivityEvent) => void {
  return (event) => {
    const botId = event.lastMessageAgentId;
    if (!botId) return;
    for (const userId of event.memberIds) {
      if (hub.connectionCount(userId) > 0) continue;
      void outbox
        .enqueue({
          kind: "run.finished",
          botId,
          userId,
          channelId: event.channelId,
        })
        .catch(() => undefined);
    }
  };
}
