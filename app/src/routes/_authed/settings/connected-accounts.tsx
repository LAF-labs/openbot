import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  ConnectionStrip,
  ConnectOutcome,
} from "@/components/plugins/connections";
import { Item, ItemContent, ItemTitle } from "@/components/ui/item";
import { t } from "@/lib/i18n";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * The services one person has connected with their own account.
 *
 * A personal page, not an administrator's. Which servers this deployment can reach is somebody
 * else's decision and it is made on the Plugins page; whether YOUR account is behind one of them is
 * only ever yours, and nobody can answer it on your behalf. So this page lists what an
 * administrator added and says nothing about it except what you did with it.
 */

/** `failed`, or the id of the server that was connected. See the same schema on the Plugins page. */
const connectedSearchSchema = z
  .object({ connected: z.string().optional() })
  .catch({});

const ConnectedAccountsPage = () => {
  const { data, isPending, isError } = useQuery(pluginsPageQueryOptions());
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

  /*
   * Only the servers answered with the asker's own grant. A deployment-wide token is an
   * administrator's arrangement and there is nothing here for a person to do about it, so listing
   * one would be offering a decision that is not theirs to make.
   */
  const servers = (data?.servers ?? []).filter(
    (server) => server.authKind === "user-oauth",
  );

  return (
    <PageShell
      description={t(
        "Services you have connected with your own account. A Bot answers with what your account can see, and nothing it cannot.",
      )}
      title={t("Connected accounts")}
    >
      <PageSection>
        <ConnectOutcome
          connected={connected}
          onClear={handleClearConnected}
          titleFor={(serverId) =>
            servers.find((server) => server.id === serverId)?.title ?? serverId
          }
        />

        {isPending ? (
          <PageEmpty>{t("Loading…")}</PageEmpty>
        ) : isError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {t("Connected accounts could not be loaded.")}
          </p>
        ) : servers.length === 0 ? (
          /* Said as a fact rather than as an instruction: most people reading this page cannot add
             a service themselves, and telling them to would be sending them at a locked door. */
          <PageEmpty>
            {t(
              "Nothing to connect yet. An administrator has to set one up first.",
            )}
          </PageEmpty>
        ) : (
          <PageRows>
            {servers.map((server) => (
              /* The vendor's own name and nothing else. Its catalogue summary is the server's
                 English prose, and an English sentence on a Korean-first screen is worse than the
                 blank it replaces — the connection state below is what this row is for. */
              <Item key={server.id} size="sm">
                <ItemContent>
                  <ItemTitle>{server.title}</ItemTitle>
                  <div className="mt-1 w-full">
                    <ConnectionStrip returnTo="settings" server={server} />
                  </div>
                </ItemContent>
              </Item>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
};

// Below the component it names: a `const` arrow is not hoisted, and naming it above is a TDZ error.
export const Route = createFileRoute("/_authed/settings/connected-accounts")({
  validateSearch: connectedSearchSchema,
  component: ConnectedAccountsPage,
});
