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
 * judge the request. It is asked for by its own control, on a Bot's profile and in Settings — see
 * `components/notifications/notification-permission.tsx` for why it is not the mute switch.
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
 * Whether a Bot stopping to ask is worth interrupting for.
 *
 * Deliberately a different rule from `shouldNotify`, and the asymmetry is the point. A question is
 * raised by a tool call in the tab the person is driving, so "the room is on screen" and "the tab
 * is visible" are the same fact here — there is no other room it could have come from. A visible
 * tab already says it: the card is drawn on the tool call's own line and the transcript's status
 * slot keeps saying so wherever the reader has scrolled (`anyQuestionOpen`). Interrupting somebody
 * who is looking straight at the question would be the notification saying it twice.
 */
export function shouldNotifyApproval(input: {
  /** The Bot's `notify` preference. Absent for a Bot the roster has not loaded. */
  notify: boolean | undefined;
  /** `document.visibilityState === "visible"`. */
  visible: boolean;
}): boolean {
  if (input.notify === false) return false;
  return !input.visible;
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
  show(
    {
      title: notice.title,
      body: notice.body,
      tag: `laf-channel:${notice.channelId}`,
    },
    () => onOpen(notice.channelId),
  );
}

/**
 * A Bot has stopped and is waiting on a person.
 *
 * `requireInteraction` because unlike a delivered answer this one burns a ten-minute window — the
 * server expires an unanswered question (`APPROVAL_TTL_MS`) and the Bot gives up. A notice that
 * fades after four seconds is one somebody misses while making coffee, and the thing they miss is
 * the only thing in this product that is genuinely blocked on them.
 *
 * Clicking it only focuses the window. The card is already on screen in the tab that raised the
 * question, and sending somebody to a route would be sending them somewhere they already are.
 */
export function showApprovalNotice(
  approvalId: string,
  title: string,
  question: string,
): void {
  show(
    {
      title,
      body: question,
      tag: `laf-approval:${approvalId}`,
      requireInteraction: true,
    },
    () => {},
  );
}

function show(
  options: {
    title: string;
    body: string;
    tag: string;
    requireInteraction?: boolean;
  },
  onClick: () => void,
): void {
  if (notificationSupport() !== "granted") return;
  try {
    const notification = new Notification(options.title, {
      body: options.body,
      tag: options.tag,
      ...(options.requireInteraction ? { requireInteraction: true } : {}),
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
      onClick();
    };
  } catch {
    // Some browsers throw here rather than resolve `denied` (older Chrome on Android). A
    // notification that cannot be shown is not a reason for anything else to stop.
  }
}
