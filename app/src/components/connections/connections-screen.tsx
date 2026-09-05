import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConnectionRowSkeleton } from "@/components/connections/connection-row";
import { OauthRow } from "@/components/connections/oauth-row";
import { SiteRows } from "@/components/connections/site-rows";
import { PartnerRow } from "@/components/partners/partner-connections";
import { ConnectOutcome } from "@/components/plugins/connections";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { agentKeys } from "@/lib/agents/queries";
import {
  connectionKeys,
  connectionsOverviewQueryOptions,
  isStillWaiting,
  PENDING_WINDOW_MS,
  withWaiting,
} from "@/lib/connections/queries";
import type { AlimtalkStatus } from "@/lib/partners/queries";
import { t } from "@/lib/i18n";
import { pluginKeys } from "@/lib/plugins/queries";

/**
 * 연결 — one screen, one read, and one gesture on every row.
 *
 * WHAT THIS REPLACED. Three sections that shared nothing: seven OAuth cards with a 연결 button, two
 * hand-written partner cards six hundred lines long, and fifteen site cards with a Bot picker of
 * their own — twenty-four cards, four requests on mount, three ideas of what "connected" looks
 * like, and a section that stated "아직 연결 안 됨" fifteen times while its own answer was still in
 * flight. The person's question in front of every one of them is the same: is this on?
 *
 * So: rows with switches, and the machinery behind each switch is the row's business rather than
 * the screen's. What is left here is the three things only the screen can know — whether the facts
 * have arrived, whether anything is waiting on somebody else, and what to do when the read fails.
 *
 * A SECTION WITH NOTHING IN IT IS NOT DRAWN. A deployment with no browser sends no sites, and a
 * machine holding no partner key sends no partner rows. A heading over an empty list is a promise
 * about something that is not coming.
 */
export const ConnectionsScreen = ({
  connected,
  onClearConnected,
}: {
  /** `failed`, or the id of the account a vendor just sent this person back from. */
  connected: string | undefined;
  onClearConnected: () => void;
}) => {
  const queryClient = useQueryClient();
  /**
   * When each consent that went to another window stops being worth re-asking about.
   *
   * Deadlines rather than a boolean, because the polling has to STOP: a consent nobody finished is
   * a tab somebody closed, and a screen left open on it would ask an endpoint every three seconds
   * for the rest of the day.
   */
  const [waitingUntil, setWaitingUntil] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());

  const overview = useQuery(
    connectionsOverviewQueryOptions(
      isStillWaiting(Object.values(waitingUntil), now),
    ),
  );
  const data = overview.data;

  /*
   * A channel connected minutes ago whose message forms 카카오 is still inspecting.
   *
   * The inspection itself takes days, so this is not a wait the screen sits through; it is the
   * first few minutes, where a person who has just finished the form is still looking at the row.
   * After that the 다시 확인 button on the row is the way to ask.
   *
   * THE HANDOFF IS DELIBERATELY NOT ONE OF THESE. It covers the whole window while it is open, so
   * nothing polled behind it could be seen, and the overview is invalidated the moment it closes.
   */
  const reviewDeadlines = useMemo(() => {
    const deadlines: number[] = [];
    for (const account of data?.accounts ?? []) {
      if (account.kind !== "partner" || account.id !== "kakao-alimtalk")
        continue;
      const status = account.partner.status as AlimtalkStatus;
      const since = status.connectedAt ? Date.parse(status.connectedAt) : NaN;
      const waiting = status.templates.some(
        (template) =>
          template.audience === "customer" && template.status === "pending",
      );
      if (waiting && !Number.isNaN(since))
        deadlines.push(since + PENDING_WINDOW_MS);
    }
    return deadlines;
  }, [data]);

  const deadlines = useMemo(
    () => [...Object.values(waitingUntil), ...reviewDeadlines],
    [waitingUntil, reviewDeadlines],
  );
  const isWaiting = isStillWaiting(deadlines, now);

  /*
   * One timer, and only while something is actually waiting: it exists to make the screen notice
   * that a deadline has passed, because nothing else would — the query's own refetch is what this
   * decides, so leaving it to a re-render would be circular.
   */
  useEffect(() => {
    if (!isWaiting) return;
    const soonest = Math.min(...deadlines.filter((deadline) => deadline > now));
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(soonest - Date.now(), 250),
    );
    return () => clearTimeout(timer);
  }, [deadlines, isWaiting, now]);

  /** One row saying it has started, or stopped, waiting on another window. */
  const handleWaiting = useCallback(
    (accountId: string, until: number | null) =>
      setWaitingUntil((current) => withWaiting(current, accountId, until)),
    [],
  );

  const handleChanged = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: connectionKeys.all });
  }, [queryClient]);

  /**
   * What a consent that just worked has to reach beyond this screen.
   *
   * The grant is not the whole of it: a Bot is offered the tools of the servers it holds grants on,
   * and both of those lists are cached in this browser. Without invalidating them the person lands
   * back on a row reading 연결됨 above a Bot that has not heard of the vendor until something else
   * happens to refetch.
   */
  const handleConnected = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: connectionKeys.all });
    void queryClient.invalidateQueries({ queryKey: pluginKeys.all });
    void queryClient.invalidateQueries({ queryKey: agentKeys.all });
  }, [queryClient]);

  const accounts = data?.accounts ?? [];
  const sites = data?.sites ?? [];

  return (
    <PageShell
      description={t(
        "Everything your Bot works with, in one place. Turn one on and it walks you through the rest — there is no key to obtain and no developer account anywhere on this screen.",
      )}
      title={t("Connections")}
    >
      {/*
       * ONLY WHEN THERE IS SOMETHING TO SAY. `ConnectOutcome` draws nothing unless a vendor has just
       * sent somebody back here, but the section around it drew its own top margin regardless — so
       * every ordinary visit opened on a hundred pixels of nothing between the description and 계정,
       * twice the gap every other screen in the app has. Measured: 100px here against 52px on
       * `/settings` and `/admin`.
       */}
      {connected ? (
        <PageSection>
          <ConnectOutcome
            connected={connected}
            onClear={onClearConnected}
            onConnected={handleConnected}
            titleFor={(serverId) => {
              // The vendor's own title, so the notice names what was connected rather than its slug.
              const found = accounts.find((account) => account.id === serverId);
              return t(found?.kind === "oauth" ? found.title : serverId);
            }}
          />
        </PageSection>
      ) : null}

      {/*
       * `!data` as well as the error: a refetch that fails while the screen already has an answer
       * must not replace twenty-four rows with a red line. In TanStack Query v5 a failed background
       * refetch turns `status` to error with the data still in hand, so reading the flag alone
       * would blank a working screen every time a laptop's wifi dropped for a second.
       */}
      {overview.isError && !data ? (
        <PageSection title={t("Connections")}>
          <p className="mt-4 text-destructive text-sm" role="alert">
            {t("The connections could not be loaded.")}
          </p>
          <Button
            className="mt-3"
            onClick={() => void overview.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("Try again")}
          </Button>
        </PageSection>
      ) : overview.isPending ? (
        <>
          <PageSection
            description={t(
              "Sign in once at the service and your Bot works with your own account.",
            )}
            title={t("Accounts")}
          >
            <div className="mt-4 rounded-lg border border-border bg-card">
              {[0, 1, 2, 3].map((row) => (
                <ConnectionRowSkeleton key={row} />
              ))}
            </div>
          </PageSection>
          <PageSection
            description={t(
              "You sign in once on a Bot's own browser, hand it back, and it stays signed in.",
            )}
            title={t("Sites")}
          >
            <div className="mt-4 rounded-lg border border-border bg-card">
              {[0, 1, 2].map((row) => (
                <ConnectionRowSkeleton key={row} />
              ))}
            </div>
          </PageSection>
        </>
      ) : (
        <>
          {accounts.length > 0 ? (
            <PageSection
              description={t(
                "Sign in once at the service and your Bot works with your own account.",
              )}
              title={t("Accounts")}
            >
              <div className="mt-4 rounded-lg border border-border bg-card">
                {accounts.map((account) =>
                  account.kind === "oauth" ? (
                    <OauthRow
                      account={account}
                      key={account.id}
                      onWaiting={handleWaiting}
                    />
                  ) : (
                    <PartnerRow
                      account={account}
                      key={account.id}
                      onChanged={handleChanged}
                    />
                  ),
                )}
              </div>
            </PageSection>
          ) : null}

          {sites.length > 0 ? (
            <PageSection
              description={t(
                "You sign in once on a Bot's own browser, hand it back, and it stays signed in.",
              )}
              title={t("Sites")}
            >
              <SiteRows bots={data?.bots ?? []} sites={sites} />
            </PageSection>
          ) : null}
        </>
      )}
    </PageShell>
  );
};
