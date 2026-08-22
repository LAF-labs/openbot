/**
 * Telling the person something happened when they are not looking at it.
 *
 * The rule is the one this fork already wrote down for the approval buzz and the morning digest
 * (server/src/watch/digest.ts): what is blocked on you leads, what merely happened follows, and
 * everything else stays out of the way. A Bot speaking in a room you are reading is "everything
 * else" — you can see it. A Bot speaking in a room you are not reading is the case this exists for.
 *
 * It is the browser's own Notification, deliberately: no service worker, no push service, no
 * dependency. WHAT THAT COSTS, SAID PLAINLY: nothing arrives while the tab is closed. A person who
 * shuts the laptop at six and has a routine deliver at seven finds the answer in the room, unread,
 * when they come back — the roster is the durable notification and always was. This is for the
 * common case, which is a tab left open behind other windows.
 *
 * Permission is never requested on load. A page that asks the moment it opens is the pattern every
 * browser now buries behind a warning, and a person who has not yet seen a Bot answer has no way to
 * judge the request. It is asked for from the switch on a Bot's profile, which is a gesture that
 * means "yes, tell me about this one".
 */

export type NotificationSupport = "unsupported" | "granted" | "denied" | "ask";

/** What the browser will currently let us do, without asking it for anything. */
export function notificationSupport(): NotificationSupport {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  const permission = Notification.permission;
  if (permission === "granted") return "granted";
  if (permission === "denied") return "denied";
  return "ask";
}

/**
 * Ask, once, from a gesture.
 *
 * Safari's older signature hands the answer to a callback instead of a promise, so both are
 * accepted; `Notification.requestPermission()` returning undefined is what that looks like here.
 */
export async function requestNotificationPermission(): Promise<NotificationSupport> {
  if (notificationSupport() === "unsupported") return "unsupported";
  if (Notification.permission !== "default") return notificationSupport();
  const answer = await new Promise<NotificationPermission>((resolve) => {
    const returned = Notification.requestPermission((permission) =>
      resolve(permission),
    ) as Promise<NotificationPermission> | undefined;
    if (returned && typeof returned.then === "function") {
      returned.then(resolve).catch(() => resolve("default"));
    }
  });
  if (answer === "granted") return "granted";
  if (answer === "denied") return "denied";
  return "ask";
}

export type BotNotice = {
  /** The Bot's name, which is the only thing worth putting in a notification's title. */
  title: string;
  /** What it said, already flattened to one line by the server's preview. */
  body: string;
  /** Where clicking it should land. */
  channelId: string;
};

/**
 * Whether this event is worth interrupting for, from facts the caller already holds.
 *
 * Pulled out of the hook so it can be tested without a DOM: every one of these clauses was a
 * decision, and a decision nothing can pin is one that quietly rots.
 */
export function shouldNotify(input: {
  /** Null when the person themselves said it: a room is never unread for your own message. */
  agentId: string | null;
  /** The Bot's `notify` preference. Absent for a Bot that is not in the roster we loaded. */
  notify: boolean | undefined;
  /** The channel the person is looking at right now, if any. */
  openChannelId: string | null;
  channelId: string;
  /** `document.visibilityState === "visible"`. */
  visible: boolean;
}): boolean {
  if (!input.agentId) return false;
  if (input.notify === false) return false;
  // Looking straight at it. The transcript draws the reply; a notification would say it twice.
  if (input.visible && input.openChannelId === input.channelId) return false;
  return true;
}

/**
 * Show one, replacing any earlier one for the same room.
 *
 * `tag` is the channel: a Bot that answers three times while somebody is at lunch should leave one
 * notification saying the newest thing, not three saying three things. That is what a messaging app
 * does per conversation, and the roster behind it still carries the full count.
 */
export function showBotNotice(
  notice: BotNotice,
  onOpen: (channelId: string) => void,
): void {
  if (notificationSupport() !== "granted") return;
  try {
    const notification = new Notification(notice.title, {
      body: notice.body,
      tag: `laf-channel:${notice.channelId}`,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
      onOpen(notice.channelId);
    };
  } catch {
    // Some browsers throw here rather than resolve `denied` (older Chrome on Android). A
    // notification that cannot be shown is not a reason for anything else to stop.
  }
}
