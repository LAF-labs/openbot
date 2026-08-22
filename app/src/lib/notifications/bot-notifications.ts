/**
 * Telling the person something happened when they are not looking at it.
 *
 * The rules are Grok Bot 0.24's, read out of its main process and copied rather than re-derived:
 * ONE decider both kinds go through, so the mute, the hidden check and the throttle are
 * automatically true of both; a Bot blocked on you makes noise and asks to stay on screen while a
 * Bot that merely finished is silent; five seconds of quiet per Bot per kind; and a window the
 * person is looking at silences things, because the screen is already telling them.
 *
 * It is also the rule this fork wrote down for the approval buzz and the morning digest
 * (server/src/watch/digest.ts): what is blocked on you leads, what merely happened follows, and
 * everything else stays out of the way.
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

/**
 * The two things worth interrupting somebody for, and neither is "a message arrived".
 *
 * `needs-you` is a Bot blocked on a person; `finished` is a Bot that stopped working. The names
 * mirror the reference product's own kinds (`agent-needs-input`, `agent-done`), because every rule
 * below turns on the distinction.
 */
export type NoticeKind = "needs-you" | "finished";

/** How long one Bot stays quiet about one kind after a notice goes out. */
export const THROTTLE_MS = 5_000;

/** As much of a message as belongs on a lock screen. */
const BODY_LIMIT = 140;

export type NoticeDecision =
  | "deliver"
  | "muted"
  | "hidden"
  | "focused"
  | "throttled";

export type NoticeRequest = {
  kind: NoticeKind;
  /** Which Bot: the throttle key, and the name on the notice. */
  agentId: string;
  /** The Bot's `notify` preference. Absent for a Bot the roster has not loaded yet: notify. */
  notify: boolean | undefined;
  /** A Bot hidden from the roster is one somebody has already put away. */
  hidden: boolean | undefined;
  /** `document.visibilityState === "visible"`. */
  visible: boolean;
  /** The room on screen, and the room this is about. Only `finished` has a room. */
  openChannelId?: string | null;
  channelId?: string;
  /** Milliseconds, for the throttle. */
  now: number;
};

/**
 * One decider, both kinds, in this order: put away, muted, looking at it, too soon.
 *
 * The order is not cosmetic. Hidden is checked before the preference because hiding a Bot is the
 * stronger statement — it is already off the roster — and an unmuted-but-hidden Bot would
 * otherwise interrupt somebody who had put it away.
 *
 * "Looking at it" differs by kind, and that asymmetry is the point. A question is raised by a tool
 * call in the tab the person is driving, so a visible tab already draws the card on that call's own
 * line and a visible tab is enough to stay quiet. A message can arrive in any room, so it takes a
 * visible tab AND that room being the one on screen.
 */
export function decideNotice(
  request: NoticeRequest,
  lastNotifiedAt: number | undefined,
): NoticeDecision {
  if (request.hidden) return "hidden";
  if (request.notify === false) return "muted";
  if (request.visible) {
    if (request.kind === "needs-you") return "focused";
    if (request.openChannelId === request.channelId) return "focused";
  }
  if (
    lastNotifiedAt !== undefined &&
    request.now - lastNotifiedAt < THROTTLE_MS
  ) {
    return "throttled";
  }
  return "deliver";
}

/** One Bot may be quiet about finishing and still be able to say it needs you. */
export function throttleKey(request: {
  agentId: string;
  kind: NoticeKind;
}): string {
  return `${request.agentId}:${request.kind}`;
}

/** One line, clamped, because a lock screen shows about this much and then stops. */
export function noticeBody(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= BODY_LIMIT ? line : `${line.slice(0, BODY_LIMIT - 1)}…`;
}

/**
 * Show one.
 *
 * `tag` collapses repeats: three answers while somebody was at lunch leave one notification saying
 * the newest thing rather than three saying three. A finished Bot is SILENT and an asking one is
 * not — a sound for every completed errand is what teaches somebody to turn notifications off.
 * `requireInteraction` on the asking kind is the browser's nearest thing to the reference's
 * `urgency: "critical"`: a question expires in ten minutes, and a notice that fades after four
 * seconds is one somebody misses while making coffee.
 */
export function showNotice(
  kind: NoticeKind,
  options: { title: string; body: string; tag: string },
  onClick: () => void,
): void {
  if (notificationSupport() !== "granted") return;
  try {
    const notification = new Notification(options.title, {
      body: noticeBody(options.body),
      tag: options.tag,
      silent: kind === "finished",
      ...(kind === "needs-you" ? { requireInteraction: true } : {}),
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

/**
 * How many rooms are waiting, on the app's own icon.
 *
 * A MUTED Bot still counts: muting silences the popup, not the fact that something is waiting —
 * the same split the reference makes. A HIDDEN Bot does not, because it is not on the roster to be
 * counted.
 *
 * `setAppBadge` exists in installed Chromium apps and nowhere else, so the title carries the number
 * for everybody else. Written only when it changes: a title rewritten on every socket event is a
 * tab that flickers.
 */
let badged: number | null = null;

export function setUnreadBadge(count: number, baseTitle: string): void {
  if (badged === count) return;
  badged = count;
  const withBadge = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  if (count > 0) {
    void withBadge.setAppBadge?.(count).catch(() => {});
    document.title = `(${count}) ${baseTitle}`;
    return;
  }
  void withBadge.clearAppBadge?.().catch(() => {});
  document.title = baseTitle;
}
