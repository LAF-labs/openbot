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
import { PartnerConnections } from "@/components/partners/partner-connections";
import { SiteConnections } from "@/components/sites/site-connections";
import { Item, ItemContent, ItemTitle } from "@/components/ui/item";
import { t } from "@/lib/i18n";
import { catalogueSummaryKey } from "@/lib/plugins/catalogue-copy";
import { connectionsQueryOptions } from "@/lib/plugins/queries";

/**
 * The services one person has connected with their own account.
 *
 * THE LIST IS THE CATALOGUE, not what somebody added. It used to be the servers an administrator
 * had registered, which on a deployment belonging to one person meant the page said "an
 * administrator has to set one up first" to the only person there. The application behind each of
 * these is the fleet's, the address is reviewed in code, and the row is made on the press — so
 * there is no administrator step left to wait for, and the server sends the entries it can actually
 * finish a consent for.
 *
 * Below it, two more lists, because there are three different promises on this screen and not one.
 * The first is an account this deployment holds a grant for. The second is a service LAF has the
 * account at, where the shop registers its own thing underneath and never obtains a key. The third
 * is a session living in the Bot's own browser, which is a login the person does themselves.
 */

/** `failed`, or the id of the server that was connected. See the same schema on the Plugins page. */
const connectedSearchSchema = z
  .object({ connected: z.string().optional() })
  .catch({});

const ConnectedAccountsPage = () => {
  const { data, isPending, isError } = useQuery(connectionsQueryOptions());
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

  const available = data?.available ?? [];

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
            t(
              available.find((entry) => entry.id === serverId)?.title ??
                serverId,
            )
          }
        />

        {isPending ? (
          <PageEmpty>{t("Loading…")}</PageEmpty>
        ) : isError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {t("Connected accounts could not be loaded.")}
          </p>
        ) : available.length === 0 ? (
          /* Said as a fact and nothing more. There is nobody to send this person to: the services
             this deployment can offer are decided by the fleet, not on this machine. */
          <PageEmpty>{t("There is nothing to connect here yet.")}</PageEmpty>
        ) : (
          <PageRows>
            {available.map((entry) => (
              <Item key={entry.id} size="sm">
                <ItemContent>
                  {/* Both through `t()` on a variable, which `i18n-coverage.test.ts` cannot see —
                      `plugin-catalogue-copy.test.ts` walks the table instead. The summary falls back
                      to the server's English line, which is the visible-and-fixable failure. */}
                  <ItemTitle>{t(entry.title)}</ItemTitle>
                  <p className="text-muted-foreground text-xs">
                    {t(catalogueSummaryKey(entry.id, entry.summary))}
                  </p>
                  <div className="mt-1 w-full">
                    <ConnectionStrip
                      instanceName={entry.instanceName}
                      needsInstanceHost={entry.needsInstanceHost}
                      returnTo="settings"
                      serverId={entry.id}
                    />
                  </div>
                </ItemContent>
              </Item>
            ))}
          </PageRows>
        )}
      </PageSection>

      {/* Between the two, and that is the order they are useful in: a service LAF has the account
          at is one press and one code, and a site the Bot signs into is a login you do yourself. */}
      <PartnerConnections />

      <SiteConnections />
    </PageShell>
  );
};

// Below the component it names: a `const` arrow is not hoisted, and naming it above is a TDZ error.
export const Route = createFileRoute("/_authed/settings/connected-accounts")({
  validateSearch: connectedSearchSchema,
  component: ConnectedAccountsPage,
});
