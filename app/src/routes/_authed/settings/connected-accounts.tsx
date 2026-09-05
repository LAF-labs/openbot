import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { ConnectionsScreen } from "@/components/connections/connections-screen";

/**
 * 연결 — everything a Bot works with, in one list.
 *
 * THE PATH IS THE OLD ONE ON PURPOSE. `/settings/connected-accounts` is linked from Settings, from
 * the sidebar and from the address a vendor sends somebody back to after a consent; the screen was
 * rewritten, not moved. What it is called in Korean is "연결", which is what the sidebar says.
 *
 * Everything the screen does lives in `components/connections/connections-screen.tsx`. What is left
 * here is the one thing that is genuinely the route's: the `?connected=` a vendor's redirect
 * carries, and clearing it the moment it has been read.
 */

/** `failed`, or the id of the server that was connected. See the same schema on the Plugins page. */
const connectedSearchSchema = z
  .object({ connected: z.string().optional() })
  .catch({});

const ConnectedAccountsPage = () => {
  const { connected } = Route.useSearch();
  const navigate = Route.useNavigate();

  // Replaced rather than pushed: the URL a vendor sent somebody back to is not a step anybody
  // should be able to walk back into.
  const handleClearConnected = useCallback(() => {
    void navigate({
      replace: true,
      search: (previous) => ({ ...previous, connected: undefined }),
    });
  }, [navigate]);

  return (
    <ConnectionsScreen
      connected={connected}
      onClearConnected={handleClearConnected}
    />
  );
};

// Below the component it names: a `const` arrow is not hoisted, and naming it above is a TDZ error.
export const Route = createFileRoute("/_authed/settings/connected-accounts")({
  validateSearch: connectedSearchSchema,
  component: ConnectedAccountsPage,
});
