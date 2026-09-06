import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { loadCurrentUser } from "../lib/auth/load-current-user";
import { useChannelEvents } from "../lib/channels/use-channel-events";
import { CopilotProvider } from "../lib/copilot/provider";
import { handleShellLinks } from "../lib/notifications/shell-links";
import { useBotNotifications } from "../lib/notifications/use-bot-notifications";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const user = await loadCurrentUser(context.queryClient);
    if (!user) {
      /*
       * WHERE THEY WERE GOING, CARRIED THROUGH THE DOOR.
       *
       * A link to a channel opened by somebody not signed in used to land on the sign-in screen and
       * then, having signed in, on Home — the thing they were sent to was gone, and the only way
       * back was to ask for the link again.
       */
      throw redirect({ to: "/sign", search: { redirect: location.href } });
    }
    /*
     * NOBODY GETS PAST THIS WITHOUT A BOT OF THEIR OWN.
     *
     * The product is a roster of Bots you made; there is nothing to look at before the first one
     * exists, and the deployment no longer hands anybody a Bot it designed. Checked here rather
     * than on the main layout so Settings and the admin screens are behind it too — a first-run
     * person who lands on a deep link should still meet the product before its preferences.
     */
    if (!user.onboarded && location.pathname !== "/welcome") {
      throw redirect({ to: "/welcome" });
    }
    /*
     * AND NOBODY GETS PAST IT ON AN AGREEMENT TO A TEXT THAT HAS SINCE CHANGED.
     *
     * After the first-run check, because the first run carries the sentence itself: its first
     * screen says continuing means agreeing, and 다음 records it. Everybody else whose recorded
     * version is not the current one — including people who joined before there was a text —
     * meets one screen that says so and asks again, and reaches nothing else until they answer.
     */
    if (
      user.onboarded &&
      user.consentRequired &&
      location.pathname !== "/consent"
    ) {
      throw redirect({ to: "/consent" });
    }
  },
  // Mounted INSIDE the authed boundary, not at the root: the runtime endpoint requires a session, so
  // a provider above the sign-in gate would open a run for a visitor who has not signed in yet.
  component: AuthedShell,
});

/**
 * The account's one socket, and what listens to it.
 *
 * Here rather than in the sidebar, which is where it started. The sidebar renders only under
 * `_authed/_app`, so a person sitting on Settings or an admin screen had no socket at all: their
 * roster went stale and a Bot that finished work while they were reading their own settings told
 * them nothing. Every authenticated screen is inside this route, and one socket is the point.
 */
function AuthedShell() {
  useChannelEvents();
  useBotNotifications();
  // In the desktop shell, a `target="_blank"` link has nowhere to go; hand it to the browser.
  useEffect(handleShellLinks, []);

  return (
    <CopilotProvider>
      <Outlet />
    </CopilotProvider>
  );
}
