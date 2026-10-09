import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  COMPOSE_SCREEN_KEY,
  DraftScope,
  offerDraft,
} from "@/components/channels/composer/prefill";
import { ConnectionRowSkeleton } from "@/components/connections/connection-row";
import { OauthRow } from "@/components/connections/oauth-row";
import { SiteRows } from "@/components/connections/site-rows";
import { focusRing } from "@/components/ui/focus";
import { ACCOUNT_FIRST_TASKS } from "@/lib/agents/first-tasks";
import { agentKeys } from "@/lib/agents/queries";
import {
  connectionsOverviewQueryOptions,
  isStillWaiting,
  type OauthAccount,
  withWaiting,
} from "@/lib/connections/queries";
import { t } from "@/lib/i18n";
import { pluginKeys } from "@/lib/plugins/queries";
import { own } from "@/lib/own";

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
 * promising a switch that is not there would be the boundary lying. A site that is not on is left
 * out for the same reason: nothing here can sign one in until the password card, and the turn
 * waiting on it would wait for nothing (`readConnectionSwitches`, which the server reads).
 */
/** What the switches on screen are, said to whoever put them there. */
export type SwitchesState = {
  /** The ids actually drawn: what this deployment has of what was asked for. */
  offered: string[];
  /** Of those, the ones that are on. */
  connected: string[];
};

export function ConnectionChoices({
  ids,
  limit,
  isWatched = false,
  onSwitches,
}: {
  /** Catalogue keys and site ids, most wanted first. */
  ids: readonly string[];
  /** How many to show of those this deployment has. All of them when absent. */
  limit?: number;
  /**
   * Something is waiting on these switches — a Bot's turn, held on its connect card
   * (`components/gallery/connect.tsx`). The overview is re-asked for as long as that is true, since
   * the switch may be turned on from another window, and "what you can ask now" is not offered:
   * the Bot is about to go on with what was asked.
   */
  isWatched?: boolean;
  /** Told once the overview has been read, and again whenever what is on changes. */
  onSwitches?: (state: SwitchesState) => void;
}) {
  const queryClient = useQueryClient();
  const [waitingUntil, setWaitingUntil] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  const deadlines = Object.values(waitingUntil);
  const isWaiting = isStillWaiting(deadlines, now);
  const overview = useQuery(
    connectionsOverviewQueryOptions(isWaiting || isWatched),
  );

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
      ) ||
      data?.sites.some((site) => site.id === id && site.status === "connected"),
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
   * the vendor's answer did not touch. Remembered per account so it is done once per landing. A
   * site signed into counts too — it puts no tools anywhere, but a turn waiting on it goes on.
   */
  const connectedKey = shown
    .filter(
      (id) =>
        accounts.some(
          (account) => account.id === id && account.status === "connected",
        ) ||
        data?.sites.some(
          (site) => site.id === id && site.status === "connected",
        ),
    )
    .join(",");
  const seen = useRef<string | null>(null);
  /*
   * WHAT IT CAN DO NOW, SAID THE MOMENT IT CAN (Muse walkthrough 2026-09-28, item 4). An account
   * that turned on while this was on screen gets its first thing to ask, as a sentence to press —
   * put in the composer, not sent, so nothing is spent until the person means it. Only accounts
   * that turned on HERE: one that was already on when the card was drawn is not news.
   */
  const [landed, setLanded] = useState<readonly string[]>([]);
  useEffect(() => {
    if (seen.current !== null && seen.current !== connectedKey) {
      void queryClient.invalidateQueries({ queryKey: pluginKeys.all });
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
      const before = new Set(seen.current.split(",").filter(Boolean));
      const fresh = connectedKey
        .split(",")
        .filter((id) => id && !before.has(id));
      if (fresh.length > 0) {
        setLanded((current) => [
          ...current,
          ...fresh.filter((id) => !current.includes(id)),
        ]);
      }
    }
    seen.current = connectedKey;
  }, [connectedKey, queryClient]);
  const draftScope = useContext(DraftScope) ?? COMPOSE_SCREEN_KEY;
  const nowCan = isWatched
    ? []
    : landed
        .map((id) => own(ACCOUNT_FIRST_TASKS, id)?.sentence)
        .filter((sentence): sentence is string => Boolean(sentence));

  // Null until the overview has been read: "nothing is offered" is a fact only after that.
  const shownKey = data ? shown.join(",") : null;
  useEffect(() => {
    if (shownKey === null || !onSwitches) return;
    const split = (key: string) => key.split(",").filter(Boolean);
    onSwitches({ offered: split(shownKey), connected: split(connectedKey) });
  }, [shownKey, connectedKey, onSwitches]);

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
      {nowCan.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1.5" data-slot="now-can">
          <p className="text-sm">{t("Connected. You can ask me this now:")}</p>
          {nowCan.map((sentence) => (
            <button
              className={`flex min-h-11 w-full items-center rounded-xl border border-foreground/25 px-3 py-2 text-left text-sm transition-colors hover:border-foreground/50 hover:bg-background/60 ${focusRing}`}
              key={sentence}
              onClick={() => offerDraft(draftScope, t(sentence))}
              type="button"
            >
              {t(sentence)}
            </button>
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
