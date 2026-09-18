import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { ConsentLine } from "@/components/legal/consent-line";
import { BusinessKindPicker } from "@/components/shop/business-kind-picker";
import {
  DailyPlacePicker,
  DailyPlacePickerSkeleton,
} from "@/components/shop/daily-place-picker";
import { Button } from "@/components/ui/button";
import { createAgentMutationOptions } from "@/lib/agents/mutations";
import { createBotNow, useSeats } from "@/lib/agents/new-bot";
import { agreeToLegal } from "@/lib/auth/consent";
import { authKeys, currentUserQueryOptions } from "@/lib/auth/queries";
import { connectionsOverviewQueryOptions } from "@/lib/connections/queries";
import { t } from "@/lib/i18n";
import {
  type BusinessKindId,
  EMPTY_SHOP,
  placesToOffer,
  sameShop,
} from "@/lib/shop/catalogue";
import { saveShop } from "@/lib/shop/queries";

/**
 * The first run, and the only place the product asks anybody to set anything up.
 *
 * FOUR SCREENS, AND THE MIDDLE TWO ARE A PRESS EACH. The agreement, then what kind of business
 * this is, then the places the owner uses every day, then the first Bot. It used to be three, the
 * last of which was a form: thirty-five faces to choose from, above a name field, above an optional
 * description, in front of somebody who had not yet seen a Bot say a single word — every question
 * of which the Bot itself asks better, in its own conversation, once it exists.
 *
 * THE TWO QUESTIONS ARE NOT THAT FORM COME BACK. Nothing is typed and both are skippable; they are
 * the two things a Bot cannot find out for itself before it has been of any use — which trade this
 * is, and which of the sites it could sign into are the ones this owner lives in — and they are what
 * turn the first Bot's suggestions from generic into this shop's (`presets.ts`, `first-tasks.ts`)
 * and what every Bot is told on every run (`shared/prompt/shop.ko.ts`).
 *
 * It still ends with one Bot existing, because a roster of Bots you made is the whole product and
 * there is nothing to look at before the first one. And there is still no skip past THAT: it is one
 * screen and one press, and every path past it lands somewhere that only makes sense once a Bot
 * exists.
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

  const [step, setStep] = useState<"hello" | "kind" | "places" | "create">(
    "hello",
  );
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * THE ANSWERS START FROM WHAT IS SAVED. Somebody who closed the laptop between the questions and
   * the first Bot comes back to this screen, and their earlier presses should still be pressed.
   * `_authed` has already loaded the current user, so this is in hand on the first render.
   */
  const { data: user } = useQuery(currentUserQueryOptions());
  const saved = user?.shop ?? EMPTY_SHOP;
  const [kind, setKind] = useState<BusinessKindId | null>(saved.kind);
  const [places, setPlaces] = useState<string[]>([...saved.places]);
  const [saving, setSaving] = useState(false);
  const kindHeadingId = useId();
  const placesHeadingId = useId();

  /*
   * What this deployment can touch, asked from the first question on so the second has it ready.
   * The 연결 screen's own read: a place is offered only when one of its doors is in it.
   */
  const overview = useQuery({
    ...connectionsOverviewQueryOptions(),
    enabled: step !== "hello",
  });
  const offered = overview.data
    ? placesToOffer(overview.data, kind, places)
    : null;
  /** A deployment that can touch none of the places has no second question to ask. */
  const hasNoPlaces = offered !== null && offered.length === 0;

  /*
   * EACH QUESTION SAVES WHEN IT IS LEFT, AND ONLY WHAT CHANGED. What is on the screen is what is
   * kept — a press taken back and then skipped clears the answer — and an answer that did not move
   * is not sent again. A failed save keeps the screen with the answer still pressed, so the next
   * press of the same button is the retry.
   */
  const handleAnswered = async (next: "places" | "create") => {
    if (saving) return;
    setProblem(null);
    const answer = { kind, places };
    if (!sameShop(answer, saved)) {
      setSaving(true);
      // React Compiler 1.0 cannot compile `try`…`finally` yet, so Welcome is left as written: the
      // code is right, and the compiler cannot follow it. Counted in
      // app/tests/react-compiler.test.ts.
      try {
        await saveShop(answer, queryClient);
      } catch (caught) {
        setProblem(
          caught instanceof Error
            ? caught.message
            : t("That was not saved. Try again."),
        );
        return;
      } finally {
        setSaving(false);
      }
    }
    setStep(next);
  };
  /*
   * A REF, NOT `isPending`. The mutation's flag is a render-time value, so two clicks landing in the
   * same frame both read `false` and both submit — which in onboarding means two Bots, one of the
   * five seats gone, and a roster that already needs tidying before it has been used once.
   * Measured: a double click made exactly that.
   */
  const submitting = useRef(false);

  /*
   * 다음 IS THE AGREEMENT. The sentence under the buttons says that continuing means agreeing to
   * the terms and the privacy policy, and this is the continuing: the stamp is written here, before
   * the second screen is shown, and the screen does not move until the server has it. A person who
   * closes the laptop between the two screens comes back to this one, and pressing again records
   * nothing new — the server keeps the first moment for the same version.
   */
  const [agreeing, setAgreeing] = useState(false);
  const proceed = async () => {
    if (agreeing) return;
    setAgreeing(true);
    setProblem(null);
    try {
      await agreeToLegal(queryClient);
      setStep("kind");
    } catch {
      setProblem(t("Could not record your agreement. Try again."));
    } finally {
      setAgreeing(false);
    }
  };

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
            {problem ? (
              <p className="text-destructive text-sm" role="alert">
                {problem}
              </p>
            ) : null}
            <div className="flex w-full flex-col gap-2">
              <Button
                className="w-full"
                disabled={agreeing}
                onClick={() => void proceed()}
              >
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
            {/*
             * THE AGREEMENT, IN WORDS, ON THE SCREEN IT HAPPENS ON.
             *
             * Pressing 다음 is what `POST /api/me/consent` records (`users.consented_at`, with the
             * version of the text) — see `proceed` above. A stamp with no sentence in front of it
             * would be a consent nobody gave, so the sentence is on the FIRST screen, beside the
             * button that records it, and the two documents are one press away, readable without
             * an account.
             */}
            <ConsentLine className="text-pretty text-muted-foreground text-xs" />
          </section>
        ) : step === "kind" ? (
          <section className="flex flex-col items-center gap-6 text-center">
            <h1 className="font-semibold text-2xl" id={kindHeadingId}>
              {t("What kind of work do you do?")}
            </h1>
            <p className="text-muted-foreground text-sm">
              {t(
                "Pick the one closest to yours. Your Bots start from it, and you can change it in Settings whenever you like.",
              )}
            </p>
            <BusinessKindPicker
              disabled={saving}
              label={{ labelledBy: kindHeadingId }}
              onChange={setKind}
              value={kind}
            />
            {problem ? (
              <p className="text-destructive text-sm" role="alert">
                {problem}
              </p>
            ) : null}
            {/*
             * ONE BUTTON THAT SAYS WHICH IT IS. With nothing pressed it reads 건너뛰기 and moves on
             * without sending anything; with an answer pressed it reads 다음 and saves it. A skip
             * that looked like 다음 would leave somebody unsure whether pressing it had agreed to
             * something, and a third button would make a two-button screen a form.
             */}
            <div className="flex w-full flex-col gap-2">
              <Button
                className="w-full"
                disabled={saving}
                onClick={() =>
                  void handleAnswered(hasNoPlaces ? "create" : "places")
                }
                type="button"
              >
                {kind ? t("Next") : t("Skip")}
              </Button>
              <Button
                className="w-full"
                disabled={saving}
                onClick={() => setStep("hello")}
                type="button"
                variant="outline"
              >
                {t("Back")}
              </Button>
            </div>
          </section>
        ) : step === "places" ? (
          <section className="flex flex-col items-center gap-6 text-center">
            <h1 className="font-semibold text-2xl" id={placesHeadingId}>
              {t("Pick the places you use every day")}
            </h1>
            <p className="text-muted-foreground text-sm">
              {t(
                "As many as you like. Your Bots look there first, and ask you to connect any that are not connected yet.",
              )}
            </p>
            {/*
             * Only what this deployment can touch, the likeliest for the kind just answered first.
             * A read that failed is said, and the way on still works: the places can be picked in
             * Settings later, and the first Bot does not depend on them.
             */}
            {hasNoPlaces ? (
              // Reached only when the read landed after the first question was answered.
              <p className="text-muted-foreground text-sm" role="status">
                {t(
                  "There is nothing to pick here yet. You can come back to it in Settings.",
                )}
              </p>
            ) : offered ? (
              <DailyPlacePicker
                disabled={saving}
                label={{ labelledBy: placesHeadingId }}
                onChange={setPlaces}
                places={offered}
                value={places}
              />
            ) : overview.isError ? (
              <p className="text-muted-foreground text-sm" role="status">
                {t(
                  "The places could not be loaded. You can pick them later in Settings.",
                )}
              </p>
            ) : (
              <DailyPlacePickerSkeleton />
            )}
            {problem ? (
              <p className="text-destructive text-sm" role="alert">
                {problem}
              </p>
            ) : null}
            <div className="flex w-full flex-col gap-2">
              <Button
                className="w-full"
                disabled={saving}
                onClick={() => void handleAnswered("create")}
                type="button"
              >
                {places.length > 0 ? t("Next") : t("Skip")}
              </Button>
              <Button
                className="w-full"
                disabled={saving}
                onClick={() => {
                  setProblem(null);
                  setStep("kind");
                }}
                type="button"
                variant="outline"
              >
                {t("Back")}
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
                onClick={() => {
                  setProblem(null);
                  // Back to the question before this one: the places, unless there were none.
                  setStep(hasNoPlaces ? "kind" : "places");
                }}
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
