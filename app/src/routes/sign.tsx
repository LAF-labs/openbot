import { createFileRoute, redirect } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { Button } from "@/components/ui/button";
import { type SignInProvider, signInWithProvider } from "@/lib/auth/client";
import { appConfig } from "@/lib/generated/application-config";
import { t } from "@/lib/i18n";
import { loadCurrentUser } from "../lib/auth/load-current-user";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const ENTRANCE_SECONDS = 0.4;
const ENTRANCE_STAGGER_SECONDS = 0.08;
const ENTRANCE_OFFSET = "translateY(12px)";

export const Route = createFileRoute("/sign")({
  /** `.catch({})` so a malformed `?redirect=` is ignored rather than destroying the route. */
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  beforeLoad: async ({ context, search }) => {
    const user = await loadCurrentUser(context.queryClient);
    if (user) {
      throw redirect({ to: safeRedirect(search.redirect) });
    }
  },
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
  const { redirect: wanted } = Route.useSearch();
  const [pendingProvider, setPendingProvider] = useState<SignInProvider | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  /**
   * With the broker declared, every branded button is on offer and every
   * press routes through it — the button's provider becomes the hint that
   * skips the broker's own picker. Direct declarations keep the old path.
   */
  const viaBroker = appConfig.auth.providers.includes("laf");
  const offered = (provider: SignInProvider) =>
    viaBroker || appConfig.auth.providers.includes(provider);

  async function handleSignIn(provider: SignInProvider) {
    setError(null);
    setPendingProvider(provider);

    try {
      await signInWithProvider(provider, safeRedirect(wanted), viaBroker);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : t("Could not start sign-in."),
      );
      setPendingProvider(null);
    }
  }

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
          {["f:0.4.0.0", "f:3.1.1.0", "f:2.6.3.0"].map((seed) => (
            <BotAvatar key={seed} seed={seed} size={48} />
          ))}
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
          {error ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </motion.div>
      </motion.div>
    </div>
  );
}
