import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { ConnectionRow } from "@/components/connections/connection-row";
import { Button } from "@/components/ui/button";
import {
  connectionKeys,
  forgetSite,
  type OverviewSite,
} from "@/lib/connections/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { activeLocale, t } from "@/lib/i18n";
import { josa } from "@/lib/josa";
import { addressesOf } from "@/lib/logins/addresses";
import { savedLoginsQueryOptions } from "@/lib/logins/queries";
import {
  EMPTY_SHOP,
  siteIsForThisShop,
  sitesInShopOrder,
} from "@/lib/shop/catalogue";
import { type BusinessSite, BUSINESS_SITES } from "@/lib/sites/catalogue";

/**
 * 사이트 연결 — signing a Bot's browser into the places a Korean shop actually works in.
 *
 * THE POINT OF THE WHOLE SECTION. Everything above it on this screen is an account at a vendor that
 * publishes an API and is willing to register this deployment. For 배민, 스마트스토어, 홈택스 and
 * the rest, that is either a fortnight of paperwork per shop or simply not on offer. What IS on
 * offer is the thing the person already knows how to do: log in. The session lives in the Bot's
 * browser profile from then on, and one login covers every Bot, since there is one profile on a
 * deployment (2026-09-16).
 *
 * A SITE IS SIGNED IN TO WHEN THE BOT GETS THERE, NOT FROM THIS SCREEN (2026-10-10,
 * docs/laf/redesign-2026-10.md §6, piece 2-6). A site used to be connected by putting the Bot's
 * browser in front of the person to log in on — taking the wheel — and nobody drives the Bot's
 * browser any more. What signs it in now is a login the person saved in 계정, put in by the server
 * the moment the Bot meets the site's sign-in — in a conversation or in a routine — or, with none
 * saved, the masked card in the conversation. So there is nothing for a switch here to do: a row
 * that is not connected draws none (one that could only fail would be a control that does
 * nothing, CLAUDE.md) and offers the one thing that can be done from here, which is saving the
 * login. It reads 연결됨 once the Bot has been seen signed in there, and can be turned off then.
 */

/** Where a site's row is, before anything the person just did. */
const stateOf = (site: OverviewSite | undefined) =>
  site?.status ?? "not_connected";

const asDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(activeLocale) : "";

export const SiteRows = ({
  sites,
  bots,
  only,
}: {
  sites: OverviewSite[];
  bots: { id: string; name: string }[];
  /**
   * These sites alone, in this order, with nothing folded behind 더 보기 — the few a conversation
   * offers (`ConnectionChoices`). Absent is the 연결 screen: every site, this shop's first.
   */
  only?: readonly string[];
}) => {
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState<Record<string, string | null>>({});
  const byId = new Map(sites.map((site) => [site.id, site]));
  const { data: me } = useQuery(currentUserQueryOptions());
  const shop = me?.shop ?? EMPTY_SHOP;
  /*
   * Which sites already have a login saved. A list that has not loaded, or could not be, is read
   * as none saved: the row then offers to save one, and the 계정 screen it leads to shows what is
   * really there.
   */
  const { data: saved } = useQuery(savedLoginsQueryOptions());
  /*
   * BY WHERE THE SITE'S SIGN-IN IS, NOT ONLY BY WHICH SITE A LOGIN WAS SAVED UNDER. A login is put
   * into a document of an origin it was saved for and nothing else is asked of it
   * (`shared/login-origin.ts`) — so one saved for `nid.naver.com` signs the Bot in to every 네이버
   * service, whichever of them it was saved from, and one saved from another site's form with that
   * address does too. A row that offered to save a second copy would be asking for a login the
   * Bot already has.
   */
  const savedSites = new Set(
    (saved?.logins ?? []).flatMap((login) => (login.site ? [login.site] : [])),
  );
  const savedOrigins = new Set(
    (saved?.logins ?? []).flatMap((login) => login.origins),
  );
  const savedFor = {
    has: (siteId: string): boolean => {
      const [signIn] = addressesOf(siteId);
      return (
        savedSites.has(siteId) ||
        (signIn !== undefined && savedOrigins.has(`https://${signIn}`))
      );
    },
  };
  const [isShowingAll, setIsShowingAll] = useState(false);
  /*
   * THIS SHOP'S SITES FIRST, THE REST BEHIND 더 보기 (ux-review-0.5.4, item 20). Fifteen switches in
   * catalogue order put 홈택스 above the delivery app a restaurant lives in. A site already
   * connected is never folded away, whatever the shop said: a login the Bot is using is not a thing
   * to hide. With nothing answered on 내 가게 there is no "this shop's" to lead with, and all are
   * drawn as before.
   */
  const ordered = sitesInShopOrder(BUSINESS_SITES, shop);
  const hasShop = ordered.some((site) => siteIsForThisShop(site.id, shop));
  const shown = only
    ? only
        .map((id) => BUSINESS_SITES.find((site) => site.id === id))
        .filter((site): site is BusinessSite => site !== undefined)
    : isShowingAll || !hasShop
      ? ordered
      : ordered.filter(
          (site) =>
            siteIsForThisShop(site.id, shop) ||
            stateOf(byId.get(site.id)) !== "not_connected",
        );
  const folded = only ? 0 : ordered.length - shown.length;

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: connectionKeys.all });
  }, [queryClient]);

  const say = useCallback((siteId: string, note: string | null) => {
    setNotes((current) => ({ ...current, [siteId]: note }));
  }, []);

  /** Off is the one way a row's switch goes now: a site already connected, let go of. */
  const handleTurnOff = useCallback(
    (site: BusinessSite) => {
      forgetSite(site.id)
        .then(() => {
          say(site.id, null);
          refresh();
        })
        .catch(() =>
          say(site.id, t("That could not be turned off. Please try again.")),
        );
    },
    [refresh, say],
  );

  const nameOf = (id: string | null): string =>
    bots.find((one) => one.id === id)?.name ?? id ?? "";

  const said = (
    site: BusinessSite,
    row: OverviewSite | undefined,
  ): { text: string; tone: "muted" | "good" | "warn" } => {
    const state = stateOf(row);
    if (state === "needs_login") {
      return { text: t("Needs signing in again"), tone: "warn" };
    }
    if (state === "connected") {
      return {
        /*
         * NOT "on {name}'s browser" ANY MORE. There is one browser on this account and every Bot
         * signs in through it (2026-09-16), so naming the Bot on the row said the login was that
         * Bot's. Nor "every Bot shares it" since 2026-09-24, when a person came to have one. The Bot
         * that last looked is still in the row, as who looked and when.
         */
        text: t("Connected · {name} last looked {date}", {
          name: nameOf(row?.botId ?? null),
          josa: josa(nameOf(row?.botId ?? null), "이/가"),
          date: asDate(row?.lastSeenAt ?? null),
        }),
        tone: "good",
      };
    }
    /*
     * 홈택스, AND ANYTHING ELSE BEHIND A CERTIFICATE. The certificate is on the person's own device
     * and is signed by a program the container does not have (docs/laf/browser-limits.md §1), and
     * a person could only lend it by taking the wheel, which nobody does now. So the Bot cannot sign
     * in here at all, and the row says so rather than promise the password card will do it.
     */
    if (site.handoff === "certificate") {
      return {
        text: t(
          "The Bot cannot sign in here: it needs a certificate on your device.",
        ),
        tone: "muted",
      };
    }
    if (savedFor.has(site.id)) {
      return {
        text: t("Login saved · your Bot signs in when it gets there"),
        tone: "muted",
      };
    }
    /*
     * NOTHING, WHERE THE BUTTON SAYS IT. The first version put "로그인을 저장해 두면 봇이 들어갈 때
     * 로그인해요" under every site with no login saved: fourteen copies of a sentence the section's
     * own description has just said, each beside a button reading 로그인 저장 (seen on the running
     * screen, 2026-10-10). A row says what its control cannot (`connection-row.tsx`, `status`).
     */
    return { text: "", tone: "muted" };
  };

  /** What a row that is not connected offers in place of a switch: saving the site's login. */
  const offered = (site: BusinessSite, row: OverviewSite | undefined) =>
    stateOf(row) === "not_connected" &&
    site.handoff === "login" &&
    !savedFor.has(site.id) ? (
      <Button
        nativeButton={false}
        render={(props) => (
          <Link {...props} search={{ site: site.id }} to="/settings/logins" />
        )}
        size="sm"
        variant="outline"
      >
        {t("Save login")}
      </Button>
    ) : undefined;

  return (
    <>
      <div className="mt-4 rounded-lg border border-border bg-card">
        {shown.map((site) => {
          const row = byId.get(site.id);
          const isOn = stateOf(row) !== "not_connected";
          const tone = said(site, row);
          return (
            <ConnectionRow
              can={t(site.what)}
              isOn={isOn}
              key={site.id}
              mark={site.mark}
              name={t(site.name)}
              note={notes[site.id] ?? null}
              status={tone.text}
              tone={tone.tone}
              {...(offered(site, row) ? { action: offered(site, row) } : {})}
              {...(isOn
                ? {
                    onToggle: (next: boolean) => {
                      if (!next) handleTurnOff(site);
                    },
                    confirmText: t(
                      "Turn this site off? The Bot will stop using it. Its browser stays signed in until you log out on the site itself.",
                    ),
                  }
                : {})}
            />
          );
        })}
      </div>
      {folded > 0 ? (
        <Button
          className="mt-2"
          onClick={() => setIsShowingAll(true)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("Show {count} more", { count: folded })}
        </Button>
      ) : null}
    </>
  );
};
