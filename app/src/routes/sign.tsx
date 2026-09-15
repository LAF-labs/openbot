import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { LegalLinks } from "@/components/legal/legal-links";
import { Button } from "@/components/ui/button";
import {
  type SignInProvider,
  SignInRefusedError,
  signInWithProvider,
} from "@/lib/auth/client";
import {
  bakedProviders,
  signInProvidersQueryOptions,
} from "@/lib/auth/providers";
import {
  refusalForCode,
  refusalForStart,
  refusalOnArrival,
  refusalSentence,
  type SignInRefusal,
} from "@/lib/auth/sign-in-refusal";
import { appConfig } from "@/lib/generated/application-config";
import { t } from "@/lib/i18n";
import { loadCurrentUser } from "../lib/auth/load-current-user";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const ENTRANCE_SECONDS = 0.4;
const ENTRANCE_STAGGER_SECONDS = 0.08;
const ENTRANCE_OFFSET = "translateY(12px)";

/** The doors `?via=` may name: the three a person picks between, never the broker itself. */
const VIA_DOORS: readonly SignInProvider[] = ["kakao", "naver", "google"];

/** Where a tab remembers that `?via=` already started a sign-in in it. */
export const VIA_STARTED_KEY = "laf.sign.via-started";

/**
 * The door to start on arrival, or none — and the promise that it happens once per tab.
 *
 * `/sign?via=google` is the front door's hand-off to a new trial (self-serve contract §3-11, §4.6):
 * the person signed in there a moment ago, their broker session is alive, and pressing the same
 * button again here is the click the flow promises not to ask for. But a start that is refused comes
 * BACK to this screen, often with `?via=` still on it, and a screen that started on every arrival
 * would bounce between the broker and here with no way out. So:
 *
 *   - only a door this deployment offers, since starting one it does not is a refusal made on purpose;
 *   - never on an arrival carrying a refusal, and never again in that tab once one has been seen;
 *   - never twice in one tab, remembered in `sessionStorage` BEFORE the start leaves, because a start
 *     that navigates away cannot write anything afterwards;
 *   - and not at all where the tab cannot remember — a promise of "once" nothing can keep is a loop.
 *
 * `via` is taken as whatever the address said and checked here, not trusted from `validateSearch`.
 * MEASURED: the router merges the root route's search — which validates nothing — into this one, so
 * `/sign?via=github` reached the screen as `via: "github"` past a validator that had dropped it, and
 * a start went to the broker asking for a door that does not exist.
 */
export function viaToStart(input: {
  via: unknown;
  isOffered: boolean;
  isRefusedOnArrival: boolean;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
}): SignInProvider | null {
  const { storage } = input;
  const via = VIA_DOORS.find((door) => door === input.via);
  if (!via || !storage) return null;
  try {
    if (storage.getItem(VIA_STARTED_KEY) !== null) return null;
    if (input.isRefusedOnArrival) {
      storage.setItem(VIA_STARTED_KEY, via);
      return null;
    }
    if (!input.isOffered) return null;
    storage.setItem(VIA_STARTED_KEY, via);
    return via;
  } catch {
    return null;
  }
}

/** This tab's `sessionStorage`, or nothing where the browser refuses it (a private window may). */
function tabMemory(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/sign")({
  /**
   * `redirect` is where they were going; `error` is the code a refused sign-in came back with. Only
   * the code: better-auth's `error_description` beside it is a provider's prose and is never read.
   * The router's parser turns `error=123` into a number, so anything present is kept as text — an
   * unknown code draws the generic sentence, which is still a refusal said out loud.
   *
   * `via` is the door the front door asks this screen to open on arrival, and only one of the three
   * a person could have pressed; anything else is dropped rather than passed on. See `viaToStart`.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { redirect?: string; error?: string; via?: SignInProvider } => ({
    ...(typeof search.redirect === "string"
      ? { redirect: search.redirect }
      : {}),
    ...(search.error !== undefined && search.error !== null
      ? { error: String(search.error) }
      : {}),
    ...(VIA_DOORS.includes(search.via as SignInProvider)
      ? { via: search.via as SignInProvider }
      : {}),
  }),
  beforeLoad: async ({ context, search }) => {
    const user = await loadCurrentUser(context.queryClient);
    if (user) {
      throw redirect({
        to: safeRedirect(refusalOnArrival(search).redirect),
      });
    }
  },
  /*
   * The provider list is loaded before the screen draws, so the buttons never flicker from the
   * baked set to the server's. The query resolves on every failure (to the baked list), so this
   * loader cannot reject and blank the page the way a rejected `beforeLoad` does.
   */
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(signInProvidersQueryOptions()),
  component: SignScreen,
});

/**
 * A path inside this app, or Home.
 *
 * Resolved against our own origin and read back as pathname + search, so an absolute URL somebody
 * appended to the link cannot turn the sign-in screen into an open redirect.
 */
function safeRedirect(target: string | undefined): string {
  if (!target) return "/";
  try {
    const url = new URL(target, window.location.origin);
    if (url.origin !== window.location.origin) return "/";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}

/*
 * One literal t() call per provider, never t(variable): the i18n coverage test only sees literal
 * strings, and a table it cannot see is a table that ships English to a Korean screen.
 */
const PROVIDER_BUTTONS: Array<{
  provider: SignInProvider;
  idle: () => string;
  opening: () => string;
  /**
   * Each platform's own button rules, as Tailwind classes.
   *
   * Kakao and Naver publish exact colors (#FEE500 with near-black text; #03C75A with white) and
   * both review the button when the app is submitted, so these are their values, not our palette.
   * Google is our default button — its guidelines allow a neutral form.
   */
  className: string;
}> = [
  {
    provider: "kakao",
    idle: () => t("Continue with Kakao"),
    opening: () => t("Opening Kakao…"),
    className:
      "bg-[#FEE500] text-[#191919] hover:bg-[#FEE500]/90 focus-visible:ring-[#FEE500]/40",
  },
  {
    provider: "naver",
    idle: () => t("Continue with Naver"),
    opening: () => t("Opening Naver…"),
    className:
      "bg-[#03C75A] text-white hover:bg-[#03C75A]/90 focus-visible:ring-[#03C75A]/40",
  },
  {
    provider: "google",
    idle: () => t("Continue with Google"),
    opening: () => t("Opening Google…"),
    className: "",
  },
];

function SignScreen() {
  const search = Route.useSearch();
  const arrival = refusalOnArrival(search);
  const wanted = arrival.redirect;
  const [pendingProvider, setPendingProvider] = useState<SignInProvider | null>(
    null,
  );
  /*
   * Two refusals, and the newer one is the one on screen: the code this screen was opened with, until
   * a button is pressed, and then whatever that press came back with.
   */
  const [isArrivalDismissed, setIsArrivalDismissed] = useState(false);
  const [startRefusal, setStartRefusal] = useState<SignInRefusal | null>(null);
  const refusal =
    startRefusal ??
    (!isArrivalDismissed && arrival.code !== null
      ? refusalForCode(arrival.code)
      : null);

  /*
   * The deployment's own answer, not the build's: which sign-ins exist is read from
   * `/api/auth/providers` (loaded by the route), and the list compiled into this image is only
   * where the surface lands when the server cannot say — see lib/auth/providers.ts for what the
   * fleet measured when it was the other way round.
   */
  const { data: providers = bakedProviders } = useQuery(
    signInProvidersQueryOptions(),
  );

  /**
   * With the broker declared, every branded button is on offer and every
   * press routes through it — the button's provider becomes the hint that
   * skips the broker's own picker. Direct declarations keep the old path.
   */
  const viaBroker = providers.includes("laf");
  const offered = (provider: SignInProvider) =>
    viaBroker || providers.includes(provider);

  async function handleSignIn(provider: SignInProvider) {
    setIsArrivalDismissed(true);
    setStartRefusal(null);
    setPendingProvider(provider);

    try {
      await signInWithProvider(provider, safeRedirect(wanted), viaBroker);
    } catch (caughtError) {
      // A refusal carries its status and code; anything else thrown is a request with no answer.
      setStartRefusal(
        caughtError instanceof SignInRefusedError
          ? refusalForStart(caughtError)
          : "unreachable",
      );
      setPendingProvider(null);
    }
  }

  /*
   * THE FRONT DOOR'S HAND-OFF, PRESSED ONCE FOR THE PERSON. On mount only: the provider list is
   * already loaded by the route, the arrival is what it is, and the decision — including remembering
   * it in the tab — is `viaToStart`'s, so a second mount (a refused start coming back, or React's
   * development double-mount) finds the tab already remembers and starts nothing.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: decided once per arrival, by design.
  useEffect(() => {
    const door = viaToStart({
      via: search.via,
      isOffered: VIA_DOORS.some(
        (named) => named === search.via && offered(named),
      ),
      isRefusedOnArrival: arrival.code !== null,
      storage: tabMemory(),
    });
    if (door) void handleSignIn(door);
  }, []);

  const prefersReducedMotion = useReducedMotion();
  const hidden = {
    opacity: 0,
    ...(prefersReducedMotion ? {} : { transform: ENTRANCE_OFFSET }),
  };
  const shown = {
    opacity: 1,
    ...(prefersReducedMotion ? {} : { transform: "translateY(0px)" }),
  };

  return (
    <div className="flex flex-col h-dvh w-full items-center justify-center -mt-12">
      <motion.div
        animate="shown"
        className="flex-1 flex w-full max-w-82 flex-col items-center justify-center p-4"
        initial="hidden"
        variants={{
          hidden: {},
          shown: { transition: { staggerChildren: ENTRANCE_STAGGER_SECONDS } },
        }}
      >
        {/*
         * THE FACES, NOT AN ORB.
         *
         * The only brand mark on the way into this product was a generic pink-violet-magenta mesh
         * gradient — four hues from no palette this app has, on the one screen that sets a first
         * impression, in a product whose whole identity is a roster of faces. Three of them, at the
         * size they appear on Home, which is the next thing the person sees once they are through
         * this screen.
         *
         * Fixed seeds, and no accessories on any of the three: a brand mark that shuffled itself on
         * every load is not a mark, and a hat on the sign-in screen is a joke told to somebody who
         * has not been introduced yet. The colours are three from opposite ends of the palette so
         * the mark carries at favicon size.
         */}
        <motion.div
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
          className="-space-x-2 flex items-center justify-center"
        >
          {["s:pebble.blue", "s:cloud.green", "s:teardrop.orange"].map(
            (seed) => (
              <BotAvatar key={seed} seed={seed} size={48} />
            ),
          )}
        </motion.div>
        <motion.h1
          className="text-2xl font-medium tracking-tight text-center mt-8"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          {t("Sign in to {product}", { product: appConfig.brand.productName })}
        </motion.h1>
        <motion.div
          className="mt-8 w-full"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          {PROVIDER_BUTTONS.some(({ provider }) => offered(provider)) ? (
            <div className="flex flex-col gap-2">
              {PROVIDER_BUTTONS.filter(({ provider }) => offered(provider)).map(
                ({ provider, idle, opening, className }) => (
                  <Button
                    className={`h-10 w-full tracking-tight ${className}`}
                    disabled={pendingProvider !== null}
                    key={provider}
                    onClick={() => void handleSignIn(provider)}
                    size="lg"
                  >
                    {pendingProvider === provider ? opening() : idle()}
                  </Button>
                ),
              )}
            </div>
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              {t("No auth providers are configured.")}
            </p>
          )}
          {refusal ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {refusalSentence(refusal)}
            </p>
          ) : null}
        </motion.div>
        {/*
         * THE TWO DOCUMENTS, READABLE BEFORE THERE IS AN ACCOUNT.
         *
         * Two links and no sentence: nobody has agreed to anything on this screen. The agreement
         * is the first screen after sign-in, which says so in words (`welcome.tsx`) — this is only
         * where somebody can read what they would be agreeing to first.
         */}
        <motion.div
          className="mt-8"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          <LegalLinks className="text-muted-foreground text-xs" />
        </motion.div>
      </motion.div>
    </div>
  );
}
