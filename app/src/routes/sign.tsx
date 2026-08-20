import { createFileRoute, redirect } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { Mascot } from "@/components/agents/mascot";
import { Button } from "@/components/ui/button";
import { signInWithGoogle } from "@/lib/auth/client";
import { appConfig } from "@/lib/generated/application-config";
import { t } from "@/lib/i18n";
import { currentUserQueryOptions } from "../lib/auth/queries";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const ENTRANCE_SECONDS = 0.4;
const ENTRANCE_STAGGER_SECONDS = 0.08;
const ENTRANCE_OFFSET = "translateY(12px)";

export const Route = createFileRoute("/sign")({
  /** `.catch({})` so a malformed `?redirect=` is ignored rather than destroying the route. */
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  beforeLoad: async ({ context, search }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
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

function SignScreen() {
  const { redirect: wanted } = Route.useSearch();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGoogleSignIn() {
    setError(null);
    setIsPending(true);

    try {
      await signInWithGoogle(safeRedirect(wanted));
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : t("Could not start Google sign-in."),
      );
      setIsPending(false);
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
         * impression, in a product whose whole identity is a roster of drawn characters. These are
         * the three Bots a new account is given, at the size they appear on Home, which is the next
         * thing the person sees once they are through this screen.
         */}
        <motion.div
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
          className="-space-x-3 flex items-center justify-center"
        >
          {["r0c4", "r0c1", "r4c2"].map((seed) => (
            <span
              className="inline-flex size-12 overflow-hidden rounded-full ring-2 ring-background"
              key={seed}
            >
              <Mascot
                className="size-full object-cover"
                seed={seed}
                size={48}
              />
            </span>
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
          {appConfig.auth.providers.includes("google") ? (
            <Button
              className="h-10 w-full tracking-tight"
              disabled={isPending}
              onClick={handleGoogleSignIn}
              size="lg"
            >
              {isPending ? t("Opening Google…") : t("Continue with Google")}
            </Button>
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
