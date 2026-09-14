/**
 * Opening a page: the one acting call that is a loop rather than a single decision.
 *
 * Every host a navigation reaches is judged on its own — the address the Bot named, each redirect
 * hop the computer holds back before contacting it, and the page it finally landed on — and a
 * landing on a catalogue site is reported so its connection card stays true. Audit A3's S2 was a
 * public redirector taking a judged navigation somewhere nobody judged (2026-09-10); what closed it
 * (W1-d) is a sequence of `govern` calls with state carried between them, and it reads as one here.
 */
import { siteForUrl } from "../../../../shared/sites/catalogue";
import { type ComputerClient, NavigationRefusedError } from "../client";
import type { NavigateResult } from "../schema";
import { hostOf } from "./addresses";
import type { ActionActor } from "./caller";
import type { Govern } from "./govern";

/** What a landing on a catalogue site reports. See `siteSeen` on the gateway's options. */
export type SiteSeen = (seen: {
  userId: string;
  siteId: string;
  botId: string;
  signedIn: boolean;
}) => void;

/**
 * How many hosts one navigation may be judged on before it is refused as a loop.
 *
 * A sign-in that goes shop → portal → identity provider → shop is four; ten is room for the longest
 * real chain and short of the browser's own twenty, which exists for the same reason.
 */
const MAX_JUDGED_HOSTS = 10;

/** A redirect chain that returned to itself or would not end. A fact code; the words are the prompt's. */
const REDIRECT_LOOP = "laf:redirect_loop";

export function createNavigation(deps: {
  /** The computer, addressed as the Bot that is asking. See `createComputerGateway`. */
  as: (botId: string) => ComputerClient;
  govern: Govern;
  siteSeen?: SiteSeen | undefined;
}) {
  const { as, govern } = deps;

  /**
   * Report a landing on a catalogue site, if it is one and if a real person is behind the call.
   *
   * `actor.userId` is omitted for the local development actor, and that omission is about
   * ATTRIBUTION — a fixture is not a person, so it does not become the actor of an audit row. It is
   * not about existence: `initializeDevActorUser` writes that fixture into `users` on boot, so it
   * owns rows like anybody else and the id is what a connection belongs to. Hence the fallback,
   * without which the whole feature is invisible in local development for a reason that only
   * applies to the trail.
   */
  function noteSiteVisit(
    botId: string,
    actor: ActionActor,
    url: string,
    text: string | undefined,
  ): void {
    const userId = actor.userId ?? actor.id;
    if (!userId || !deps.siteSeen) return;
    const site = siteForUrl(url);
    if (!site) return;
    deps.siteSeen({
      userId,
      siteId: site.id,
      botId,
      signedIn: site.signedIn(url, text ?? ""),
    });
  }

  /**
   * A navigation that arrived on a host nobody judged, without being stopped on the way.
   *
   * Two ways that happens: a page's own POST took it there while it loaded — a POST is not stopped,
   * because asking for it again would send its body twice — or the computer is an older image that
   * follows every redirect. The page is already open, so this cannot keep the host from being
   * contacted; it keeps a refused or questioned page from being read, and closes the browser on it.
   */
  async function judgeLanding(
    computerId: string,
    botId: string,
    actor: ActionActor,
    judged: string,
    result: NavigateResult,
    presented: { signal?: AbortSignal; approvalId?: string },
  ): Promise<void> {
    if (!/^https?:/i.test(result.url)) return;
    const landedOn = hostOf(result.url);
    if (!landedOn || landedOn === hostOf(judged)) return;
    try {
      await govern(
        computerId,
        "computer_navigate",
        botId,
        actor,
        { targetUrl: result.url, ...presented },
        async () => result,
      );
    } catch (error) {
      await as(botId)
        .stopComputer()
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * Opening a page, through the gateway so it lands in the audit trail.
   *
   * The client still applies its target guard, which is the floor that holds under every policy,
   * including one that permits everything. This adds the record and the per-Bot decision on top: a
   * refusal by either produces a row, so navigation denials are visible in the audit trail.
   *
   * THE POLICY JUDGES EVERY HOST THE NAVIGATION REACHES, NOT ONLY THE ONE IT STARTS AT. It used to
   * judge the address the Bot named and follow wherever that went: a rule keeping a Bot off
   * facebook.com was one link shortener away from facebook.com, and the Boundaries page had to say
   * so beside the rule ("A link that redirects there from somewhere else is allowed"). Now the
   * computer stops the first hop to a host this call has not judged — before that host is
   * contacted — and hands it back; it is judged here like the address that started it, with its
   * own row, and asked for only if the policy allows it. A question about the hop is asked about
   * the hop, and a person's answer is spent on the hop it was given for when the same call is sent
   * again. Same-host redirects are followed without a second look: every shipped rule about where
   * a Bot may go is a rule about hosts.
   */
  async function navigate(
    computerId: string,
    botId: string,
    actor: ActionActor,
    url: string,
    /**
     * An answer a person gave to this exact call, if one has been given.
     *
     * Last and optional on every acting method, so a caller that knows nothing about approvals
     * behaves exactly as it did and a route that forgets to pass it fails by asking again rather
     * than by acting unasked.
     */
    approvalId?: string,
    /**
     * A person's Stop, or a routine's deadline, on its way to the computer. After `approvalId`
     * rather than before it, as the other acting methods have it, so the callers that already
     * pass an approval id are untouched; nothing passed the signal here before.
     */
    signal?: AbortSignal,
  ) {
    // The person's Stop travels with every hop, like the answer they gave.
    const presented = {
      ...(signal ? { signal } : {}),
      ...(approvalId ? { approvalId } : {}),
    };
    const asked = new Set<string>();
    let destination = url;
    let referer: string | undefined;
    for (;;) {
      const target = destination;
      const sentReferer = referer;
      const result = await govern(
        computerId,
        "computer_navigate",
        botId,
        actor,
        { targetUrl: target, ...presented },
        () =>
          as(botId).navigate(target, signal, {
            holdAtNewHost: true,
            ...(sentReferer ? { referer: sentReferer } : {}),
          }),
      );
      const onward = result.redirect;
      if (!onward) {
        await judgeLanding(computerId, botId, actor, target, result, presented);
        /*
         * The page that actually loaded, not the one that was asked for. A login wall redirects, and
         * the redirect is precisely the information worth having: `nid.naver.com` is not one of
         * 스마트스토어's hosts, so it reads as "not signed in" without any special case.
         */
        noteSiteVisit(botId, actor, result.url, result.text);
        return result;
      }
      asked.add(target);
      // A chain that comes back to an address it already asked for, or will not end, is refused
      // rather than followed round: the browser's own limit is twenty, and every hop here is a row.
      if (asked.has(onward.to) || asked.size >= MAX_JUDGED_HOSTS) {
        throw new NavigationRefusedError(REDIRECT_LOOP);
      }
      destination = onward.to;
      referer = onward.referer;
    }
  }

  return { navigate };
}
