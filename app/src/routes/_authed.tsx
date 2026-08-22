import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { currentUserQueryOptions } from "../lib/auth/queries";
import { useChannelEvents } from "../lib/channels/use-channel-events";
import { CopilotProvider } from "../lib/copilot/provider";
import { useBotNotifications } from "../lib/notifications/use-bot-notifications";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
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

  return (
    <CopilotProvider>
      <Outlet />
    </CopilotProvider>
  );
}
