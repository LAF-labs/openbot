import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import {
  type NotificationSupport,
  notificationSupport,
  readNotificationSupport,
  requestNotificationPermission,
} from "@/lib/notifications/bot-notifications";
import { inShell } from "@/lib/notifications/shell";

/**
 * When a notice can arrive, said in the words of wherever this page is running.
 *
 * Both lines that said it — the Settings row and a Bot's own switch — said "only while a tab is
 * open", and in the installed app, which is the surface this product leads with, there is no tab:
 * the audit read that sentence inside the PC app (0.5.3 item 10). What is true in the shell is
 * what the code does: closing the window only hides it, the page keeps listening, and quitting the
 * app from the tray or the platform's own Quit ends the process and every notice with it. Whether a
 * notice reaches somebody while the window is hidden has not been measured on a device, so the
 * sentence promises the running app and nothing about the window.
 */
export function noticeWindowNote(): string {
  return inShell()
    ? t("While the app is running. Quitting the app stops them.")
    : t("Only while a tab is open.");
}

/**
 * The one place the browser is asked, and the one place its answer is explained.
 *
 * `notify` is on for every Bot by default, which is right — a Bot you added is one you want to hear
 * from — and it is exactly why asking only when somebody flips that switch ON meant never asking at
 * all: a person would have had to mute a Bot and unmute it to be offered notifications. So the ask
 * is its own affordance, shown while the browser has not been asked and gone once it has. A
 * `denied` permission cannot be re-prompted by any API, so that state says so and stops rather than
 * offering a button that would do nothing.
 *
 * Held in state rather than read at render because `Notification.permission` tells nobody when it
 * changes.
 *
 * AND IT WAS INVISIBLE IN THE APP PEOPLE INSTALL. `"Notification" in window` is false in WKWebView,
 * so on the surface this product leads with — the desktop shell — the button was never drawn, and
 * a person had no way to turn notifications on from inside the thing they installed to get them.
 * Meanwhile the shell path worked: `showShellNotice` posts through the OS centre and had been
 * asking for permission on its own, silently, the first time a Bot happened to need somebody. So
 * in the shell the control is drawn and the permission goes through the bridge.
 */
export function NotificationPermission({
  /** Shown once there is nothing left to ask for. Absent renders nothing in that state. */
  grantedNote,
  /**
   * Shown where this environment cannot do notifications at all. Absent renders nothing, which is
   * right beside a Bot's own switch — that row is about the Bot, and a browser that cannot notify
   * is not something the Bot did. On the Settings row it is the whole answer: the heading and its
   * paragraph were drawn there unconditionally, so a person in an environment with no notifications
   * read a description of a feature followed by nothing at all, with no way to tell whether the
   * control had failed to load or had never existed.
   */
  unsupportedNote,
}: {
  grantedNote?: string;
  unsupportedNote?: string;
}) {
  /*
   * The browser can answer synchronously and the shell cannot, so the shell starts at "nothing to
   * draw" and the effect below fills it in a tick later. Starting at "ask" instead would flash a
   * "turn on notifications" button at somebody who had already turned them on.
   */
  const [support, setSupport] = useState<NotificationSupport>(() =>
    inShell() ? "unsupported" : notificationSupport(),
  );

  useEffect(() => {
    if (!inShell()) return;
    let live = true;
    void readNotificationSupport().then((answer) => {
      if (live) setSupport(answer);
    });
    return () => {
      live = false;
    };
  }, []);

  if (support === "unsupported") {
    return unsupportedNote ? (
      <p className="pt-1 text-muted-foreground text-sm">{unsupportedNote}</p>
    ) : null;
  }

  if (support === "ask") {
    return (
      <Button
        className="mt-1 self-start text-sm!"
        onClick={() => void requestNotificationPermission().then(setSupport)}
        size="sm"
        variant="outline"
      >
        {t("Turn on notifications")}
      </Button>
    );
  }

  /*
   * THE ROW USED TO DESCRIBE A CONTROL THAT WAS NOT THERE.
   *
   * A denied permission drew one grey sentence — "브라우저가 차단하고 있습니다" — under a heading
   * and a paragraph about notifications, and nothing else: no button, no switch, and no way to find
   * out what to do about it. From the other side of the screen that is a feature whose control has
   * failed to load.
   *
   * So the control stays, DISABLED, which is the true shape of this state: there is something to
   * press and this person cannot press it. No API can re-prompt after a denial and none can open a
   * browser's own settings, so the way out is words rather than a button that would do nothing — and
   * the words differ, because in the installed shell the setting is the operating system's and there
   * is no address bar to point at.
   */
  if (support === "denied") {
    return (
      <div className="flex flex-col items-start gap-1 pt-1">
        <Button
          className="text-sm!"
          disabled
          size="sm"
          type="button"
          variant="outline"
        >
          {t("Turn on notifications")}
        </Button>
        <p className="text-muted-foreground text-sm">
          {/* The installed app has no site and no browser to blame; its switch is the computer's. */}
          {inShell()
            ? t("This computer has notifications turned off for this app.")
            : t("Your browser is blocking notifications for this site.")}
        </p>
        <p className="text-muted-foreground text-sm">
          {inShell()
            ? t(
                "Allow notifications for this app in your computer's own settings, then reopen this screen.",
              )
            : t(
                "Press the icon at the left of the address bar, set Notifications to Allow, then reload.",
              )}
        </p>
      </div>
    );
  }

  return grantedNote ? (
    <p className="pt-1 text-muted-foreground text-sm">{grantedNote}</p>
  ) : null;
}
