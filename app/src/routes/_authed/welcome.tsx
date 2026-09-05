import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { Button } from "@/components/ui/button";
import { createAgentMutationOptions } from "@/lib/agents/mutations";
import { createBotNow, useSeats } from "@/lib/agents/new-bot";
import { authKeys } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";

/**
 * The first run, and the only place the product asks anybody to set anything up.
 *
 * TWO SCREENS, AND THE SECOND ONE IS A BUTTON. It used to be three, the last of which was a form:
 * thirty-five faces to choose from, above a name field, above an optional description, in front of
 * somebody who had not yet seen a Bot say a single word — every question of which the Bot itself
 * asks better, in its own conversation, once it exists.
 *
 * It still ends with one Bot existing, because a roster of Bots you made is the whole product and
 * there is nothing to look at before the first one. And there is still no skip: it is one screen and
 * one press, and every path past it lands somewhere that only makes sense once a Bot exists.
 */
/** Three fixed faces for the first screen: distinct shapes and palettes, no accessories. */
const WELCOME_FACES = ["f:0.4.1.0", "f:1.7.0.0", "f:3.9.2.0"] as const;

export const Route = createFileRoute("/_authed/welcome")({
  component: Welcome,
});

function Welcome() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const createAgent = useMutation(createAgentMutationOptions(queryClient));
  const seats = useSeats();

  const [step, setStep] = useState<"hello" | "create">("hello");
  const [problem, setProblem] = useState<string | null>(null);
  /*
   * A REF, NOT `isPending`. The mutation's flag is a render-time value, so two clicks landing in the
   * same frame both read `false` and both submit — which in onboarding means two Bots, one of the
   * five seats gone, and a roster that already needs tidying before it has been used once.
   * Measured: a double click made exactly that.
   */
  const submitting = useRef(false);

  const finish = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setProblem(null);
    const outcome = await createBotNow({
      create: (input) => createAgent.mutateAsync(input),
      open: async (agentId) => {
        /*
         * Marked only once the Bot exists. The other order — stamp, then create — leaves somebody
         * who closed the laptop mid-request past the gate with no Bot and no way back here.
         */
        await fetch("/api/me/onboarded", {
          credentials: "include",
          method: "POST",
        });
        /*
         * REFETCH, NOT INVALIDATE, AND `type: "all"` IS THE WHOLE FIX.
         *
         * Measured: the first Bot was created, `onboarded_at` was stamped, and the screen stayed on
         * the welcome form with the person's own words still in it — and pressing 시작하기 again did
         * nothing at all, because the double-click guard had already latched. A dead button on the
         * first screen of the product.
         *
         * `invalidateQueries` only marks the entry stale; it refetches ACTIVE queries, and nothing
         * on this screen observes the current user. `ensureQueryData` in `_authed`'s guard then
         * answered from the cache — still `onboarded: false` — and redirected the navigation
         * straight back here. The two halves each behaved correctly and the person was in a loop.
         */
        await queryClient.refetchQueries({
          queryKey: authKeys.currentUser(),
          type: "all",
        });
        // Into the Bot's own conversation, where the profile card is waiting with its name and face.
        await navigate({ search: { agent: agentId }, to: "/channel/new" });
      },
      seats,
      taken: [],
    });
    // Released only on failure: on success this screen is going away, and re-arming the button
    // during that teardown is another way to make a second Bot.
    if (!outcome.ok) {
      submitting.current = false;
      setProblem(outcome.problem);
    }
  };

  return (
    <main className="flex h-svh w-full items-center justify-center bg-background p-8">
      <div className="flex w-full max-w-md flex-col gap-8">
        {step === "hello" ? (
          <section className="flex flex-col items-center gap-6 text-center">
            <div className="flex -space-x-3">
              {WELCOME_FACES.map((seed) => (
                <BotAvatar
                  className="size-14"
                  key={seed}
                  seed={seed}
                  size={56}
                />
              ))}
            </div>
            <h1 className="font-semibold text-2xl">
              {t("Your team of always-on Bots")}
            </h1>
            {/*
             * IT USED TO SAY THEY KEEP WORKING WHEN THIS WINDOW IS CLOSED, AND THAT IS HALF TRUE.
             *
             * A routine and a room run on the server and do carry on. A one-to-one turn does not:
             * the browser is what drives it, so closing the window ends it (docs/laf/user-guide.md
             * §7 says exactly this, in a table). Promising it on the first screen somebody ever
             * sees is a promise the product breaks the first time they close a laptop mid-answer.
             */}
            <p className="text-muted-foreground">
              {t(
                "Each one is a colleague you can hand real work to. Routines and rooms keep running with this window closed; a conversation like this one runs while it is open.",
              )}
            </p>
            {/*
             * Said plainly, here, once. The Bots share a desk: a site one of them signed into is
             * signed in for all of them. That is what makes the desk useful and it is also the
             * thing a person would be upset to discover later.
             */}
            <p className="rounded-lg bg-muted/50 px-4 py-3 text-muted-foreground text-sm">
              {t(
                "They work on one real browser between them, so a site one Bot signs into is signed in for the others too. Give a Bot only the access you would give the whole team.",
              )}
            </p>
            {/*
             * A LINK THAT GOES SOMEWHERE. The invitation to sign the Bot's browser into your daily
             * sites was here as a sentence with nothing to press — the one setup act that turns an
             * empty Bot into a useful one, described and then abandoned. It goes to 연결 now, and
             * it says out loud that it can wait, because on the first minute it can.
             */}
            <Button
              // It renders an <a>, and the primitive warns — on the console of the FIRST screen
              // anybody sees — that a non-button loses native button semantics. It is a link on
              // purpose, so it says so, the same way the export button does.
              nativeButton={false}
              render={(props) => (
                <Link to="/settings/connected-accounts" {...props} />
              )}
              size="sm"
              variant="outline"
            >
              {t("Connect the sites you use — you can do this later")}
            </Button>
            <Button className="w-full" onClick={() => setStep("create")}>
              {t("Next")}
            </Button>
          </section>
        ) : (
          <section className="flex flex-col items-center gap-6 text-center">
            <BotAvatar className="size-20" seed="f:2.5.0.0" size={80} />
            <h1 className="font-semibold text-2xl">
              {t("Make your first Bot")}
            </h1>
            {/*
             * NOTHING TO FILL IN. The name and the face are given, and both are changed in one tap
             * on the card that opens with the conversation — which is also the moment a person has
             * any idea what they want to call it.
             */}
            <p className="text-muted-foreground text-sm">
              {t(
                "It arrives with a name and a face and nothing else. You say what it is for by talking to it — and you can make up to five.",
              )}
            </p>
            {/* The other teaching door, named once at the start: not every job survives being
                written down, and showing is allowed. */}
            <p className="text-muted-foreground text-sm">
              {t(
                "Anything hard to explain in words, you can teach by doing it once in front of the Bot.",
              )}
            </p>

            {problem ? (
              <p className="text-destructive text-sm" role="alert">
                {problem}
              </p>
            ) : null}

            <div className="flex w-full gap-2">
              <Button
                className="flex-1"
                onClick={() => setStep("hello")}
                type="button"
                variant="outline"
              >
                {t("Back")}
              </Button>
              <Button
                className="flex-1"
                disabled={createAgent.isPending}
                onClick={() => void finish()}
                type="button"
              >
                {createAgent.isPending
                  ? t("Creating…")
                  : t("Make the first Bot")}
              </Button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
