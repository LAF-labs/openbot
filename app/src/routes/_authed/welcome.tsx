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
const WELCOME_FACES = [
  "s:pebble.blue",
  "s:cloud.green",
  "s:teardrop.orange",
] as const;

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
    /*
     * CENTRED, AND THE FACES CARRY THE SCREEN.
     *
     * Measured at 1280×860 and at 800×700: the block sat in the upper third with roughly 60% of the
     * window empty below it, and the three faces were 56px — a row of small icons above a wall of
     * text, on the one screen in the product whose whole job is to introduce the characters.
     *
     * `justify-center` on a `h-svh` main with `my-auto` on the column is the pair that actually
     * centres it: the column is the flex item, and it was being stretched by `items-center` on the
     * cross axis while the main axis had nothing to centre.
     */
    <main className="flex h-svh w-full items-center justify-center overflow-y-auto bg-background p-8">
      <div className="my-auto flex w-full max-w-md flex-col gap-8">
        {step === "hello" ? (
          <section className="flex flex-col items-center gap-6 text-center">
            {/*
             * A SOFT GROUND UNDER THEM. Three drawings floating on the page read as clip art; the
             * same three on a tinted disc read as a group photograph, which is what they are.
             */}
            <div className="flex items-center justify-center gap-1 rounded-full bg-muted/60 px-8 py-6">
              {WELCOME_FACES.map((seed) => (
                <BotAvatar
                  className="size-20 shrink-0"
                  key={seed}
                  seed={seed}
                  size={80}
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
             * THE PRIMARY VERB FIRST, AND THE TWO BUTTONS ARE THE SAME WIDTH.
             *
             * 다음 is what everybody presses; 연결하기 is the optional errand. They were stacked the
             * other way round and at two different widths — an outline pill of whatever width its
             * sentence happened to be, sitting ABOVE a full-width black button — so the screen read
             * as two unrelated controls and offered the side quest first.
             *
             * A LINK THAT GOES SOMEWHERE, still. The invitation to sign the Bot's browser into your
             * daily sites used to be a sentence with nothing to press: the one setup act that turns
             * an empty Bot into a useful one, described and then abandoned.
             */}
            <div className="flex w-full flex-col gap-2">
              <Button className="w-full" onClick={() => setStep("create")}>
                {t("Next")}
              </Button>
              <Button
                className="w-full"
                // It renders an <a>, and the primitive warns — on the console of the FIRST screen
                // anybody sees — that a non-button loses native button semantics. It is a link on
                // purpose, so it says so, the same way the export button does.
                nativeButton={false}
                render={(props) => (
                  <Link to="/settings/connected-accounts" {...props} />
                )}
                variant="outline"
              >
                {t("Connect the sites you use — you can do this later")}
              </Button>
            </div>
          </section>
        ) : (
          <section className="flex flex-col items-center gap-6 text-center">
            {/* The same disc as step one, holding one face: this is the Bot about to be made. */}
            <div className="rounded-full bg-muted/60 p-6">
              <BotAvatar
                className="size-28"
                seed="s:squircle.violet"
                size={112}
              />
            </div>
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

            {/* Primary first here too, and both full width, so the two steps agree with each other. */}
            <div className="flex w-full flex-col gap-2">
              <Button
                className="w-full"
                disabled={createAgent.isPending}
                onClick={() => void finish()}
                type="button"
              >
                {createAgent.isPending
                  ? t("Creating…")
                  : t("Make the first Bot")}
              </Button>
              <Button
                className="w-full"
                onClick={() => setStep("hello")}
                type="button"
                variant="outline"
              >
                {t("Back")}
              </Button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
