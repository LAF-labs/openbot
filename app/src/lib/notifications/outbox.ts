/**
 * What the server says is waiting for this person, and how the page hears about it.
 *
 * BEFORE THIS, the page worked out "a Bot is waiting" from the tab the question was raised in
 * (`use-bot-notifications.ts` reading `openQuestions()`, which is a module in THIS browser). That is
 * exactly right for a question the person's own click caused, and it reaches nothing at all for a
 * question raised by a routine at seven in the morning, by a room turn running on the server, or in
 * the other window. The outbox is the server's list of things worth interrupting somebody about;
 * this is the client half of it.
 *
 * THE FRAME IS AN OPTIMISATION AND THE ENDPOINT IS THE TRUTH — the rule the roster already follows.
 * A frame can be missed: the tab was closed, the socket was reconnecting, the laptop was shut. So
 * the frame is a nudge to read `GET /api/me/notifications`, and a reconnect reads it again. Nothing
 * is knowable only through the socket.
 *
 * THE TYPE IS DECLARED TWICE, here and in `server/src/notifications/in-app.ts`, for the reason the
 * room frames are (`lib/channels/room-frames.ts`): this app's tsconfig includes only `src`, and a
 * type that quietly resolved across that boundary today would break the first time somebody
 * tightened the include.
 */

/** The outbox kinds, in the server's spelling. Anything else is a build talking to a newer server. */
export const NOTIFICATION_EVENTS = [
  "approval.requested",
  "approval.expired",
  "run.needs_you",
  "run.finished",
  "run.failed",
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export type NotificationFrame = {
  kind: "notification";
  /** The outbox row's id. What `markNotificationSeen` sends back. */
  id: string;
  event: string;
  botId: string;
  approvalId?: string;
  channelId?: string;
  /** An `AskSubject`, unparsed. `askSubjectOf` in `lib/approvals.ts` is what makes it one. */
  subject?: unknown;
  at: string;
};

/**
 * The socket's third kind of traffic, told apart before anything reads it.
 *
 * The roster's activity event is recognised by having no `kind` at all, so a frame the sidebar does
 * not recognise gets spread onto a roster row — which is how `approvalId` would end up on something
 * the sidebar draws. Checked here, once, in the same shape `isRoomFrame` uses.
 */
export function isNotificationFrame(
  value: unknown,
): value is NotificationFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<NotificationFrame>;
  return (
    frame.kind === "notification" &&
    typeof frame.id === "string" &&
    typeof frame.botId === "string" &&
    typeof frame.event === "string"
  );
}

/**
 * The same re-broadcast the channel events use: one socket, any number of listeners.
 *
 * The socket lives in the sidebar's hook and the notifications live in `_authed`; rather than thread
 * a callback between them, the frame is dispatched here and whoever cares listens.
 */
export const notificationFrames = new EventTarget();
export const NOTIFICATION_FRAME = "notification-frame";

/**
 * What is waiting, newest first. Null when the server could not be asked.
 *
 * Null and an empty list are kept apart for the same reason `readApprovals` keeps them apart: a
 * caller must never read a failed request as "nothing is waiting for you".
 */
export async function readNotifications(
  since?: string,
): Promise<NotificationFrame[] | null> {
  try {
    const query = since ? `?since=${encodeURIComponent(since)}` : "";
    const response = await fetch(`/api/me/notifications${query}`, {
      credentials: "include",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      notifications?: Array<{
        id: string;
        kind: string;
        botId: string;
        approvalId?: string;
        channelId?: string;
        subject?: unknown;
        createdAt: string;
      }>;
    };
    return (body.notifications ?? []).map((row) => ({
      kind: "notification" as const,
      id: row.id,
      event: row.kind,
      botId: row.botId,
      ...(row.approvalId ? { approvalId: row.approvalId } : {}),
      ...(row.channelId ? { channelId: row.channelId } : {}),
      ...(row.subject ? { subject: row.subject } : {}),
      at: row.createdAt,
    }));
  } catch {
    return null;
  }
}

/**
 * They looked at it.
 *
 * Sent when the person ACTS on a notice — clicks it — rather than when one is shown. A notification
 * that was raised on a lock screen behind a closed laptop has been delivered, not seen, and the two
 * are different columns because the difference is the whole of whether anybody was reached.
 */
export async function markNotificationSeen(id: string): Promise<boolean> {
  try {
    const response = await fetch(
      `/api/me/notifications/${encodeURIComponent(id)}/seen`,
      { method: "POST", credentials: "include" },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/** Where acting on this notification should land somebody, or null when it names no place. */
export function destinationOf(
  frame: NotificationFrame,
): { kind: "approve" | "channel"; id: string } | null {
  if (frame.approvalId) return { kind: "approve", id: frame.approvalId };
  if (frame.channelId) return { kind: "channel", id: frame.channelId };
  return null;
}
