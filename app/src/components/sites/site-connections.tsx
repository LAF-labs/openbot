import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LiveScreen } from "@/components/computer/live-screen";
import { pokeControl } from "@/components/computer/control-poll";
import {
  releaseControl,
  takeControl,
} from "@/components/computer/take-the-wheel";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemTitle } from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { useStartChannel } from "@/lib/channels/start";
import { activeLocale, t } from "@/lib/i18n";
import { type BusinessSite, BUSINESS_SITES } from "@/lib/sites/catalogue";
import {
  checkSiteConnection,
  type OpenSiteOutcome,
  openSite,
  type SiteConnection,
  siteKeys,
  siteConnectionsQueryOptions,
} from "@/lib/sites/queries";

/**
 * 사이트 연결 — signing a Bot's browser into the places a Korean shop actually works in.
 *
 * THE POINT OF THE WHOLE SECTION. Everything above it on this screen is an OAuth connector, which
 * works when a vendor publishes an API and is willing to register this deployment. For 배민,
 * 스마트스토어, 홈택스 and the rest, that is either a fortnight of paperwork per shop or simply not
 * on offer. What IS on offer is the thing the person already knows how to do: open the site and log
 * in. So the Bot's own browser is put in front of them, they sign in, they hand it back, and the
 * session lives in the browser profile from then on.
 *
 * NOTHING HERE EVER SEES A PASSWORD. Everything typed during the handoff goes over the live-screen
 * socket straight to Chromium; this component never reads it, the connection row has no field it
 * could land in, and the audit trail records that somebody held the wheel, not what they pressed.
 * `server/tests/site-connections.test.ts` serialises the lot and proves it.
 */

/** The card's one-line state, so the three of them are decided in one place rather than in JSX. */
type CardState = "connected" | "needs-login" | "unconnected";

const stateOf = (connection: SiteConnection | undefined): CardState => {
  if (!connection) return "unconnected";
  return connection.needsLogin ? "needs-login" : "connected";
};

/** What went wrong opening the page, in this screen's own words rather than the server's. */
const refusalText = (outcome: OpenSiteOutcome): string | null => {
  if (outcome.ok) return null;
  if (outcome.kind === "refused") {
    return t(
      "The boundary would not open that address. Which sites a Bot may open is an administrator's decision.",
    );
  }
  if (outcome.kind === "awaiting") {
    return t("Somebody has to allow this before the page will open.");
  }
  return t("The Bot's browser could not be reached.");
};

/**
 * One site, and everything a person decides about it.
 *
 * The suggestions are on the card rather than behind it because "연결하면 뭐가 되는데?" is the
 * question this section has to answer before somebody will log into anything. A sentence answers it
 * abstractly; three things they can press answer it by happening.
 */
const SiteCard = ({
  site,
  bot,
  connection,
  connectedBotName,
  busy,
  note,
  onConnect,
  onAsk,
}: {
  site: BusinessSite;
  bot: AgentProfile | undefined;
  connection: SiteConnection | undefined;
  /** The NAME of the Bot whose browser holds this session. A profile is per Bot; say which. */
  connectedBotName: string;
  busy: boolean;
  /** What just happened with this card, if anything. Cleared by the next attempt. */
  note: string | null;
  onConnect: (site: BusinessSite) => void;
  onAsk: (prompt: string) => void;
}) => {
  const state = stateOf(connection);
  return (
    <Item size="sm">
      <ItemContent>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ItemTitle>{t(site.name)}</ItemTitle>
          {state === "connected" ? (
            <span className="font-medium text-primary text-xs">
              {t("Connected · {name}", { name: t(site.name) })}
            </span>
          ) : state === "needs-login" ? (
            <span className="font-medium text-destructive text-xs">
              {t("Needs signing in again")}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">
              {t("Not connected yet")}
            </span>
          )}
        </div>

        <p className="mt-1 max-w-prose text-muted-foreground text-sm leading-relaxed">
          {t(site.what)}
        </p>

        {/*
         * 홈택스, AND ANYTHING ELSE BEHIND A CERTIFICATE. There is no "connect once" to offer here:
         * the certificate is on the person's own device and is signed by a program the container
         * does not have (docs/laf/browser-limits.md §1). A card that offered 연결 anyway would be
         * promising a connection it cannot keep, so it says what it actually is — a handoff, every
         * time — and the button says the same.
         */}
        {site.handoff === "certificate" ? (
          <p className="mt-1 max-w-prose text-muted-foreground text-xs leading-relaxed">
            {t(
              "A joint certificate or simple authentication is yours to do, and the Bot cannot keep it: you authenticate each time and hand the browser back.",
            )}
          </p>
        ) : null}

        {connection ? (
          <p className="mt-1 text-muted-foreground text-xs">
            {t("Last seen {date}", {
              date: new Date(connection.lastSeenAt).toLocaleDateString(
                activeLocale,
              ),
            })}
            {" · "}
            {t("on {name}'s browser", { name: connectedBotName })}
          </p>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            disabled={busy || !bot}
            onClick={() => onConnect(site)}
            size="sm"
            type="button"
            variant="outline"
          >
            {busy
              ? t("Opening…")
              : site.handoff === "certificate"
                ? t("Authenticate now and hand back")
                : state === "unconnected"
                  ? t("Connect")
                  : t("Sign in again")}
          </Button>
          {site.prompts.map((prompt) => (
            <button
              className="rounded-full border border-border px-3 py-1 text-left text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
              disabled={!bot}
              key={prompt}
              onClick={() => onAsk(t(prompt))}
              type="button"
            >
              {t(prompt)}
            </button>
          ))}
        </div>

        {note ? (
          <p className="mt-2 text-destructive text-xs" role="alert">
            {note}
          </p>
        ) : null}
      </ItemContent>
    </Item>
  );
};

/**
 * The wheel, while somebody logs in.
 *
 * Reuses the takeover the product already has — `takeControl`/`releaseControl` and the same
 * `LiveScreen` socket the Bot's screen uses when a person drives it — rather than building a second
 * one. The only thing this adds is knowing WHY the wheel was taken, which is what lets it ask the
 * server, on the way back, whether the login actually worked.
 */
const Handoff = ({
  site,
  botId,
  onDone,
}: {
  site: BusinessSite;
  botId: string;
  /** Called after the wheel is handed back, with what the page turned out to say. */
  onDone: (signedIn: boolean | null) => void;
}) => {
  const [problem, setProblem] = useState<string | null>(null);
  const [handingBack, setHandingBack] = useState(false);

  const handBack = useCallback(async () => {
    setHandingBack(true);
    await releaseControl(botId);
    // Every other card watching this computer shares one control loop, and it may have settled.
    pokeControl(botId);
    const checked = await checkSiteConnection(site.id, botId);
    onDone(checked ? checked.signedIn : null);
  }, [botId, site.id, onDone]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Hands back BEFORE it closes, the same contract the Bot's screen makes: an overlay that
      // vanishes while somebody still holds the wheel leaves the Bot blocked on a takeover nobody
      // can see they have.
      void handBack();
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handBack]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      aria-label={t("The Bot's screen")}
      aria-modal="true"
      className="fixed inset-0 z-50 flex flex-col p-4 sm:p-8"
      role="dialog"
    >
      <div className="absolute inset-0 bg-black/80" />
      <div className="relative mb-3 flex items-center justify-between gap-4 text-sm text-white">
        <span className="pointer-events-none">
          <strong className="font-medium">{t("You have control.")}</strong>{" "}
          {t("Log in on {name}, then hand it back.", { name: t(site.name) })}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <Button
            disabled={handingBack}
            onClick={() => void handBack()}
            size="sm"
            type="button"
            variant="secondary"
          >
            {handingBack ? t("Checking the page…") : t("Hand back to the Bot")}
          </Button>
          <span className="pointer-events-none text-white/70">
            {t("Press Escape to hand back and close")}
          </span>
        </span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto rounded-lg bg-black">
        <LiveScreen computerId={botId} driving onProblem={setProblem} />
      </div>
      {problem ? (
        <p className="relative mt-2 text-sm text-white" role="alert">
          {problem}
        </p>
      ) : null}
    </div>,
    document.body,
  );
};

export const SiteConnections = () => {
  const queryClient = useQueryClient();
  const { data: agents } = useQuery(agentListQueryOptions());
  const { data: connections } = useQuery(siteConnectionsQueryOptions());
  const { start } = useStartChannel();
  const [chosenBotId, setChosenBotId] = useState<string | null>(null);
  /** The site whose login page is being opened. One at a time; a browser has one page. */
  const [opening, setOpening] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<BusinessSite | null>(null);
  const [notes, setNotes] = useState<Record<string, string | null>>({});

  const roster = agents ?? [];
  const bot = roster.find((agent) => agent.id === chosenBotId) ?? roster[0];

  const handleConnect = useCallback(
    async (site: BusinessSite) => {
      if (!bot) return;
      setNotes((current) => ({ ...current, [site.id]: null }));
      setOpening(site.id);
      const opened = await openSite(bot.id, site.loginUrl);
      if (!opened.ok) {
        setNotes((current) => ({
          ...current,
          [site.id]: refusalText(opened),
        }));
        setOpening(null);
        return;
      }
      // The wheel is taken only once the page is actually open, so a refusal never leaves somebody
      // holding a browser that went nowhere.
      await takeControl(bot.id);
      pokeControl(bot.id);
      setOpening(null);
      setHandoff(site);
    },
    [bot],
  );

  const handleDone = useCallback(
    (site: BusinessSite, signedIn: boolean | null) => {
      setHandoff(null);
      void queryClient.invalidateQueries({ queryKey: siteKeys.connections() });
      setNotes((current) => ({
        ...current,
        [site.id]:
          signedIn === false
            ? t(
                "That page still looks like a login screen, so nothing was recorded. Try again when you are through.",
              )
            : null,
      }));
    },
    [queryClient],
  );

  const handleAsk = useCallback(
    (prompt: string) => {
      if (!bot) return;
      void start([bot.id], prompt);
    },
    [bot, start],
  );

  const byId = new Map(
    (connections ?? []).map((connection) => [connection.siteId, connection]),
  );
  /*
   * A Bot's NAME, from its id. The row carries the id because that is what the header the computer
   * reads carries, and an id on a card is a thing a person cannot recognise as their own Bot. A Bot
   * deleted since the login falls back to the id, which is at least true.
   */
  const nameOf = (id: string | undefined): string =>
    roster.find((agent) => agent.id === id)?.name ?? id ?? "";

  return (
    <PageSection
      description={t(
        "The sites you work in every day. No keys and no developer registration: you sign in once on a Bot's own browser, hand it back, and it stays signed in.",
      )}
      title={t("Site connections")}
    >
      {roster.length === 0 ? (
        /* A site is connected on a Bot's browser, so with no Bots there is nothing to connect it
           on. Said as a fact, with the thing to do next, rather than as an error. */
        <PageEmpty>
          {t("Make a Bot first — a site is connected on a Bot's own browser.")}
        </PageEmpty>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="text-muted-foreground text-sm">
              {t("Which Bot's browser?")}
            </span>
            <Select onValueChange={setChosenBotId} value={bot?.id ?? ""}>
              <SelectTrigger
                aria-label={t("Which Bot's browser?")}
                className="w-56"
              >
                <SelectValue>{bot?.name ?? ""}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {roster.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <PageRows>
            {BUSINESS_SITES.map((site) => (
              <SiteCard
                bot={bot}
                busy={opening === site.id}
                connectedBotName={nameOf(byId.get(site.id)?.botId)}
                connection={byId.get(site.id)}
                key={site.id}
                note={notes[site.id] ?? null}
                onAsk={handleAsk}
                onConnect={(chosen) => void handleConnect(chosen)}
                site={site}
              />
            ))}
          </PageRows>
        </>
      )}

      {handoff && bot ? (
        <Handoff
          botId={bot.id}
          onDone={(signedIn) => handleDone(handoff, signedIn)}
          site={handoff}
        />
      ) : null}
    </PageSection>
  );
};
