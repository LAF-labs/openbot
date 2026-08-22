import { useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import {
  type NotificationSupport,
  notificationSupport,
  requestNotificationPermission,
} from "@/lib/notifications/bot-notifications";

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
 */
export function NotificationPermission({
  /** Shown once there is nothing left to ask for. Absent renders nothing in that state. */
  grantedNote,
}: {
  grantedNote?: string;
}) {
  const [support, setSupport] = useState<NotificationSupport>(() =>
    notificationSupport(),
  );

  if (support === "unsupported") return null;

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

  if (support === "denied") {
    return (
      <p className="pt-1 text-muted-foreground text-sm">
        {t("Your browser is blocking notifications for this site.")}
      </p>
    );
  }

  return grantedNote ? (
    <p className="pt-1 text-muted-foreground text-sm">{grantedNote}</p>
  ) : null;
}
