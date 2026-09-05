import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { ConnectionRow } from "@/components/connections/connection-row";
import { pokeControl } from "@/components/computer/control-poll";
import { takeControl } from "@/components/computer/take-the-wheel";
import { Handoff } from "@/components/sites/handoff";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  connectionKeys,
  forgetSite,
  type OverviewSite,
} from "@/lib/connections/queries";
import { activeLocale, t } from "@/lib/i18n";
import { type BusinessSite, BUSINESS_SITES } from "@/lib/sites/catalogue";
import {
  checkSiteConnection,
  type OpenSiteOutcome,
  openSite,
} from "@/lib/sites/queries";

/**
 * 사이트 연결 — signing a Bot's browser into the places a Korean shop actually works in.
 *
 * THE POINT OF THE WHOLE SECTION. Everything above it on this screen is an account at a vendor that
 * publishes an API and is willing to register this deployment. For 배민, 스마트스토어, 홈택스 and
 * the rest, that is either a fortnight of paperwork per shop or simply not on offer. What IS on
 * offer is the thing the person already knows how to do: open the site and log in. So the Bot's own
 * browser is put in front of them, they sign in, they hand it back, and the session lives in the
 * browser profile from then on.
 *
 * WHICH BOT IS ASKED ONCE, AT THE TOP. A browser profile is per Bot, so every row in this section
 * is about one of them; asking on each row would be fifteen copies of one decision. The choice is
 * remembered, because a person who keeps their logins on one Bot should not re-pick it every time
 * they open this screen.
 */

/** Where a site's row is, before anything the person just did. */
const stateOf = (site: OverviewSite | undefined) =>
  site?.status ?? "not_connected";

/** What went wrong opening the page, in this screen's own words rather than the server's. */
const refusalText = (outcome: OpenSiteOutcome): string => {
  if (outcome.ok) return "";
  if (outcome.kind === "refused") {
    return t("This Bot is not allowed to open that address.");
  }
  if (outcome.kind === "awaiting") {
    return t("Somebody has to allow this before the page will open.");
  }
  return t("The Bot's browser could not be reached.");
};

/** Which Bot's browser this person last used here. */
const REMEMBERED_BOT = "laf.connections.bot";

const rememberedBot = (): string | null => {
  try {
    return window.localStorage.getItem(REMEMBERED_BOT);
  } catch {
    // A browser with storage switched off is not a broken screen; it is one that forgets.
    return null;
  }
};

const rememberBot = (botId: string): void => {
  try {
    window.localStorage.setItem(REMEMBERED_BOT, botId);
  } catch {
    // Nothing to do and nothing worth saying: the picker still works for this visit.
  }
};

const asDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(activeLocale) : "";

export const SiteRows = ({
  sites,
  bots,
}: {
  sites: OverviewSite[];
  bots: { id: string; name: string }[];
}) => {
  const queryClient = useQueryClient();
  const [chosenBotId, setChosenBotId] = useState<string | null>(rememberedBot);
  /** The site whose login page is being opened. One at a time; a browser has one page. */
  const [opening, setOpening] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<BusinessSite | null>(null);
  const [notes, setNotes] = useState<Record<string, string | null>>({});
  /** The site whose check could not be read, so the retry knows what to ask about again. */
  const [unread, setUnread] = useState<string | null>(null);

  const bot = bots.find((one) => one.id === chosenBotId) ?? bots[0];
  const byId = new Map(sites.map((site) => [site.id, site]));

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: connectionKeys.all });
  }, [queryClient]);

  const say = useCallback((siteId: string, note: string | null) => {
    setNotes((current) => ({ ...current, [siteId]: note }));
  }, []);

  const handleChoose = useCallback((botId: string | null) => {
    if (!botId) return;
    setChosenBotId(botId);
    rememberBot(botId);
  }, []);

  const handleOpen = useCallback(
    async (site: BusinessSite) => {
      if (!bot) return;
      say(site.id, null);
      setUnread(null);
      setOpening(site.id);
      const opened = await openSite(bot.id, site.loginUrl);
      if (!opened.ok) {
        say(site.id, refusalText(opened));
        setOpening(null);
        return;
      }
      /*
       * THE WHEEL IS VERIFIED, NOT ASSUMED. This used to ignore what `takeControl` answered and open
       * the overlay regardless, under a banner reading "조종권은 당신에게 있습니다" — so a takeover
       * the server refused put somebody in front of a live screen typing a password at a browser
       * that was not listening to them.
       */
      const held = await takeControl(bot.id);
      if (held?.holder !== "human") {
        say(
          site.id,
          t("The browser could not be handed over. Please try again."),
        );
        setOpening(null);
        return;
      }
      pokeControl(bot.id);
      setOpening(null);
      setHandoff(site);
    },
    [bot, say],
  );

  const handleDone = useCallback(
    (site: BusinessSite, signedIn: boolean | null) => {
      setHandoff(null);
      refresh();
      if (signedIn === null) {
        /*
         * The check itself did not answer — a 503 from a restarting browser, or a deployment with
         * no such surface. It used to be a silent no-op: the overlay closed, nothing was said, and
         * a row that had just been logged into kept reading 연결 안 됨 with no way to find out why.
         */
        setUnread(site.id);
        say(site.id, t("The browser's state could not be read."));
        return;
      }
      setUnread(null);
      say(
        site.id,
        signedIn
          ? null
          : t(
              "That page still looks like a login screen, so nothing was recorded. Try again when you are through.",
            ),
      );
    },
    [refresh, say],
  );

  const handleRetryCheck = useCallback(
    async (site: BusinessSite) => {
      if (!bot) return;
      const checked = await checkSiteConnection(site.id, bot.id);
      if (!checked) {
        say(site.id, t("The browser's state could not be read."));
        return;
      }
      setUnread(null);
      refresh();
      say(
        site.id,
        checked.signedIn
          ? null
          : t(
              "That page still looks like a login screen, so nothing was recorded. Try again when you are through.",
            ),
      );
    },
    [bot, refresh, say],
  );

  const handleToggle = useCallback(
    (site: BusinessSite, next: boolean) => {
      if (next) {
        void handleOpen(site);
        return;
      }
      forgetSite(site.id)
        .then(() => {
          say(site.id, null);
          refresh();
        })
        .catch(() =>
          say(site.id, t("That could not be turned off. Please try again.")),
        );
    },
    [handleOpen, refresh, say],
  );

  if (bots.length === 0) {
    /* A site is connected on a Bot's browser, so with no Bots there is nothing to connect it on.
       Said as a fact, with the thing to do next, rather than as an error. */
    return (
      <p className="mt-4 text-muted-foreground text-sm">
        {t("Make a Bot first — a site is connected on a Bot's own browser.")}
      </p>
    );
  }

  const nameOf = (id: string | null): string =>
    bots.find((one) => one.id === id)?.name ?? id ?? "";

  const said = (
    site: BusinessSite,
    row: OverviewSite | undefined,
  ): { text: string; tone: "muted" | "good" | "warn" } => {
    if (opening === site.id) return { text: t("Opening…"), tone: "muted" };
    const state = stateOf(row);
    if (state === "needs_login") {
      return { text: t("Needs signing in again"), tone: "warn" };
    }
    if (state === "connected") {
      return {
        text: t("Connected · on {name}'s browser · last seen {date}", {
          name: nameOf(row?.botId ?? null),
          date: asDate(row?.lastSeenAt ?? null),
        }),
        tone: "good",
      };
    }
    /*
     * 홈택스, AND ANYTHING ELSE BEHIND A CERTIFICATE. There is no "connect once" to offer here: the
     * certificate is on the person's own device and is signed by a program the container does not
     * have (docs/laf/browser-limits.md §1). A row that promised a connection it cannot keep would
     * be the screen lying, so it says what it actually is — a handoff, every time.
     */
    if (site.handoff === "certificate") {
      return {
        text: t("You authenticate each time — the Bot cannot keep this one."),
        tone: "muted",
      };
    }
    return { text: t("Not connected"), tone: "muted" };
  };

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span className="text-muted-foreground text-sm">
          {t("Which Bot's browser?")}
        </span>
        <Select onValueChange={handleChoose} value={bot?.id ?? ""}>
          <SelectTrigger
            aria-label={t("Which Bot's browser?")}
            className="w-56"
          >
            <SelectValue>{bot?.name ?? ""}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {bots.map((one) => (
              <SelectItem key={one.id} value={one.id}>
                {one.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-4 rounded-lg border border-border bg-card">
        {BUSINESS_SITES.map((site) => {
          const row = byId.get(site.id);
          const state = stateOf(row);
          const tone = said(site, row);
          return (
            <ConnectionRow
              can={t(site.what)}
              isBusy={opening === site.id}
              isOn={state !== "not_connected"}
              key={site.id}
              name={t(site.name)}
              note={notes[site.id] ?? null}
              onToggle={(next) => handleToggle(site, next)}
              status={tone.text}
              tone={tone.tone}
              {...(state !== "not_connected"
                ? {
                    confirmText: t(
                      "Turn this site off? The Bot will stop using it. It stays signed in on the Bot's browser until you log out on the site itself.",
                    ),
                  }
                : {})}
            >
              {unread === site.id ? (
                <Button
                  className="mt-2"
                  onClick={() => void handleRetryCheck(site)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {t("Check again")}
                </Button>
              ) : null}
            </ConnectionRow>
          );
        })}
      </div>

      {handoff && bot ? (
        <Handoff
          botId={bot.id}
          onDone={(signedIn) => handleDone(handoff, signedIn)}
          site={handoff}
        />
      ) : null}
    </>
  );
};
