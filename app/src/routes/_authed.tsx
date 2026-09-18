import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { ShellConnectionCheck } from "../components/help/connection-check-dialog";
import { ConnectionNotice } from "../components/layout/connection-notice";
import { TrialBanner } from "../components/layout/trial-banner";
import { loadCurrentUser } from "../lib/auth/load-current-user";
import { useSessionGate } from "../lib/auth/use-session-gate";
import { useChannelEvents } from "../lib/channels/use-channel-events";
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
  component: AuthedShell,
});

/**
 * The account's one socket, and what listens to it.
 *
 * Here rather than in the sidebar, which is where it started. The sidebar renders only under
 * `_authed/_app`, so a person sitting on Settings or an admin screen had no socket at all: their
 * roster went stale and a Bot that finished work while they were reading their own settings told
 * them nothing. Every authenticated screen is inside this route, and one socket is the point.
 *
 * NO COPILOTKIT PROVIDER HERE ANY MORE. It wrapped this Outlet, so its 800 kB — and the transcript
 * renderer it drags in — were a static part of every signed-in screen, Home and Settings included
 * (audit A4, finding 5: 706 kB of a 894 kB first load was these two, on a screen with no
 * transcript). The screens that run a Bot mount it themselves (`lib/copilot/provider.tsx`), and
 * those are route components, which the router splits into chunks fetched on the way there.
 */
function AuthedShell() {
  useChannelEvents();
  useBotNotifications();
  useSessionGate();
  // In the desktop shell, a `target="_blank"` link has nowhere to go; hand it to the browser.
  useEffect(handleShellLinks, []);

  return (
    <>
      {/*
       * A free trial's countdown, on every signed-in screen — Settings and the first run included,
       * because it is the only place the end date is ever said. Draws nothing off a trial.
       */}
      <TrialBanner />
      <ConnectionNotice />
      {/* 연결 점검, opened from the line above and from the help page. */}
      <ShellConnectionCheck />
      <Outlet />
    </>
  );
}
