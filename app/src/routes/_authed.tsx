import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { currentUserQueryOptions } from "../lib/auth/queries";
import { CopilotProvider } from "../lib/copilot/provider";

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
  component: () => (
    <CopilotProvider>
      <Outlet />
    </CopilotProvider>
  ),
});
