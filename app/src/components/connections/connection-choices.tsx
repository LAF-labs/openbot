import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionRowSkeleton } from "@/components/connections/connection-row";
import { OauthRow } from "@/components/connections/oauth-row";
import { SiteRows } from "@/components/connections/site-rows";
import { focusRing } from "@/components/ui/focus";
import { agentKeys } from "@/lib/agents/queries";
import {
  connectionsOverviewQueryOptions,
  isStillWaiting,
  type OauthAccount,
  withWaiting,
} from "@/lib/connections/queries";
import { t } from "@/lib/i18n";
import { pluginKeys } from "@/lib/plugins/queries";

/**
 * A few of 연결's switches, drawn inside the conversation.
 *
 * THE SAME ROWS, NOT A COPY. The first run's 연결 step and the card a Bot puts on screen when a task
 * needs an account both draw `OauthRow` and `SiteRows` — the switch, the consent in the person's own
 * browser, the handoff for a site login — so a row here and its row on 연결 cannot disagree about
 * what "connected" means, and a switch turned on here reads 연결됨 there. Muse's in-chat connect
 * card works the same way, reading live state rather than drawing a button that stays "연결" after
 * the account is on (`~/laf/docs/muse-ux-teardown-2026-09-27.md` §1).
 *
 * WHAT THIS KEEPS FROM THE SCREEN. The one poll while a consent is out in another window, for the
 * reason `ConnectionsScreen` gives; and the invalidations once one lands, because the Bot is offered
 * a connection's tools from lists this browser caches.
 *
 * An id this deployment does not offer is left out, and with none left nothing is drawn: a card
 * promising a switch that is not there would be the boundary lying.
 */
export function ConnectionChoices({
  ids,
  limit,
}: {
  /** Catalogue keys and site ids, most wanted first. */
  ids: readonly string[];
  /** How many to show of those this deployment has. All of them when absent. */
  limit?: number;
}) {
  const queryClient = useQueryClient();
  const [waitingUntil, setWaitingUntil] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  const deadlines = Object.values(waitingUntil);
  const isWaiting = isStillWaiting(deadlines, now);
  const overview = useQuery(connectionsOverviewQueryOptions(isWaiting));

  useEffect(() => {
    if (!isWaiting) return;
    const soonest = Math.min(...deadlines.filter((deadline) => deadline > now));
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(soonest - Date.now(), 250),
    );
    return () => clearTimeout(timer);
  }, [deadlines, isWaiting, now]);

  const handleWaiting = useCallback(
    (accountId: string, until: number | null) =>
      setWaitingUntil((current) => withWaiting(current, accountId, until)),
    [],
  );

  const data = overview.data;
  const offered = ids.filter(
    (id) =>
      data?.accounts.some(
        (account) => account.kind === "oauth" && account.id === id,
      ) || data?.sites.some((site) => site.id === id),
  );
  const shown = limit === undefined ? offered : offered.slice(0, limit);
  const accounts = shown
    .map((id) =>
      data?.accounts.find(
        (account): account is OauthAccount =>
          account.kind === "oauth" && account.id === id,
      ),
    )
    .filter((account): account is OauthAccount => account !== undefined);
  const siteIds = shown.filter((id) =>
    data?.sites.some((site) => site.id === id),
  );

  /*
   * A switch that turned on while this was on screen: what the Bot is offered is read from caches
   * the vendor's answer did not touch. Remembered per account so it is done once per landing.
   */
  const connectedKey = accounts
    .filter((account) => account.status === "connected")
    .map((account) => account.id)
    .join(",");
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (seen.current !== null && seen.current !== connectedKey) {
      void queryClient.invalidateQueries({ queryKey: pluginKeys.all });
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
    }
    seen.current = connectedKey;
  }, [connectedKey, queryClient]);

  if (overview.isPending) {
    return (
      <div
        aria-hidden
        className="mt-2 rounded-lg border border-border bg-card"
        data-slot="connection-choices"
      >
        {[0, 1].map((row) => (
          <ConnectionRowSkeleton key={row} />
        ))}
      </div>
    );
  }
  if (overview.isError) {
    return (
      <p className="mt-2 text-muted-foreground text-xs">
        {t("The connections could not be loaded.")}{" "}
        <Link
          className={`underline underline-offset-2 ${focusRing}`}
          to="/settings/connected-accounts"
        >
          {t("Open Connections")}
        </Link>
      </p>
    );
  }
  if (shown.length === 0) return null;

  return (
    <div className="mt-2 flex w-full flex-col" data-slot="connection-choices">
      {accounts.length > 0 ? (
        <div className="rounded-lg border border-border bg-card text-foreground">
          {accounts.map((account) => (
            <OauthRow
              account={account}
              key={account.id}
              onWaiting={handleWaiting}
              returnTo="chat"
            />
          ))}
        </div>
      ) : null}
      {siteIds.length > 0 && data ? (
        <div className="text-foreground [&>div]:mt-2">
          <SiteRows bots={data.bots} only={siteIds} sites={data.sites} />
        </div>
      ) : null}
    </div>
  );
}
