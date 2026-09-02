import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Mascot, MASCOT_TILES } from "@/components/agents/mascot";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createAgentMutationOptions } from "@/lib/agents/mutations";
import { agentInputFrom, emptyAgentForm } from "@/lib/agents/form";
import {
  type AgentPreset,
  pickSuggestions,
  workPattern,
} from "@/lib/agents/presets";
import { authKeys } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";

/**
 * The first run, and the only place the product asks anybody to set anything up.
 *
 * It ends with one Bot existing, because a roster of Bots you made is the whole product and there
 * is nothing to look at before the first one. The deployment no longer ships Bots of its own, so
 * without this a new person met an empty screen and a button.
 *
 * THERE IS NO SKIP. Not to trap anybody — it is two screens and a name — but because every path
 * past it lands somewhere that only makes sense once a Bot exists.
 */
export const Route = createFileRoute("/_authed/welcome")({
  component: Welcome,
});

const STEPS = ["hello", "computer", "create"] as const;
type Step = (typeof STEPS)[number];

function Welcome() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const createAgent = useMutation(createAgentMutationOptions(queryClient));

  const [step, setStep] = useState<Step>("hello");
  const [avatarSeed, setAvatarSeed] = useState(MASCOT_TILES[0]?.id ?? "r0c1");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  /*
   * Three, not six, and not a wall: this screen is somebody's first minute and the point of the
   * cards is to answer "what would I even use this for", not to be chosen from. Dealt once, in an
   * initialiser, so they hold still while they are being read.
   */
  const [suggestions, setSuggestions] = useState(() => pickSuggestions(3));

  const applyPreset = (preset: AgentPreset) => {
    // The translated text, not the key: these become the Bot's own words, shown and given to the
    // model for as long as it exists.
    setAvatarSeed(preset.avatarSeed);
    setName(t(preset.name));
    setTitle(t(preset.title));
    setRole(t(preset.roleDescription));
  };

  /*
   * A REF, NOT `isPending`. The mutation's flag is a render-time value, so two clicks landing in the
   * same frame both read `false` and both submit — which in onboarding means two Bots, one of the
   * five seats gone, and a roster that already needs tidying before it has been used once.
   * Measured: a double click made exactly that.
   */
  const submitting = useRef(false);

  const finish = async () => {
    if (!name.trim() || submitting.current) return;
    submitting.current = true;
    setProblem(null);
    try {
      const agent = await createAgent.mutateAsync({
        ...agentInputFrom({
          ...emptyAgentForm,
          name: name.trim(),
          title: title.trim(),
          roleDescription: role.trim(),
        }),
        avatarSeed,
      });
      /*
       * Marked only once the Bot exists. The other order — stamp, then create — leaves somebody who
       * closed the laptop mid-request past the gate with no Bot and no way back to this screen.
       */
      await fetch("/api/me/onboarded", {
        method: "POST",
        credentials: "include",
      });
      await queryClient.invalidateQueries({ queryKey: authKeys.currentUser() });
      await navigate({ to: "/agents", search: { agent: agent.id } });
    } catch {
      // Released only on failure: on success this screen is going away, and re-arming the button
      // during that teardown is another way to make a second Bot.
      submitting.current = false;
      setProblem(t("That Bot could not be created. Try again."));
    }
  };

  return (
    <main className="flex h-svh w-full items-center justify-center bg-background p-8">
      <div className="flex w-full max-w-md flex-col gap-8">
        {step === "hello" ? (
          <section className="flex flex-col items-center gap-6 text-center">
            <div className="flex -space-x-3">
              {MASCOT_TILES.slice(0, 3).map((tile) => (
                <Mascot
                  className="size-14 rounded-full ring-2 ring-background"
                  key={tile.id}
                  seed={tile.id}
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
            <Button className="w-full" onClick={() => setStep("computer")}>
              {t("Next")}
            </Button>
          </section>
        ) : null}

        {step === "computer" ? (
          <section className="flex flex-col items-center gap-6 text-center">
            <h1 className="font-semibold text-2xl">
              {t("They share one computer")}
            </h1>
            <p className="text-muted-foreground">
              {t(
                "Your Bots work on a real browser of their own — they open pages, read them, and fill things in.",
              )}
            </p>
            {/*
             * The invitation before the caution: xAI's guides all open with
             * "connect your daily tools first", and it is the one setup act
             * that turns an empty Bot into a useful one. Ours is a sign-in,
             * not an integration — said as a first move, not a chore.
             */}
            <p className="text-muted-foreground text-sm">
              {t(
                "A good first move: sign the Bot's browser into the sites you check every day. From then on, that screen's work is work you can hand over.",
              )}
            </p>
            {/*
             * Said plainly, here, once. The Bots share a desk: a site one of them signed into is
             * signed in for all of them. That is what makes the desk useful and it is also the
             * thing a person would be upset to discover later.
             */}
            <p className="rounded-lg bg-muted/50 px-4 py-3 text-muted-foreground text-sm">
              {t(
                "It is one computer for all of them, so a site one Bot signs into is signed in for the others too. Give a Bot only the access you would give the whole team.",
              )}
            </p>
            <div className="flex w-full gap-2">
              <Button
                className="flex-1"
                onClick={() => setStep("hello")}
                variant="outline"
              >
                {t("Back")}
              </Button>
              <Button className="flex-1" onClick={() => setStep("create")}>
                {t("Next")}
              </Button>
            </div>
          </section>
        ) : null}

        {step === "create" ? (
          <form
            className="flex flex-col gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              void finish();
            }}
          >
            <div className="flex flex-col items-center gap-3 text-center">
              <Mascot className="size-20" seed={avatarSeed} size={80} />
              <h1 className="font-semibold text-2xl">
                {t("Make your first Bot")}
              </h1>
              <p className="text-muted-foreground text-sm">
                {t(
                  "It starts with nothing set and can become anything. You can make up to five.",
                )}
              </p>
              {/* The other teaching door, named once at the start: not every
                  job survives being written down, and showing is allowed. */}
              <p className="text-muted-foreground text-sm">
                {t(
                  "Anything hard to explain in words, you can teach by doing it once in front of the Bot.",
                )}
              </p>
            </div>

            {/*
             * BEFORE THE FORM, DELIBERATELY. A person who has never seen the product read "it can
             * become anything" one line ago; three real jobs are what makes that sentence mean
             * something. Tapping one fills every field below, including the face.
             */}
            <section className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="font-medium text-muted-foreground text-xs">
                  {t("Or start from one of these")}
                </h2>
                <button
                  className="text-muted-foreground text-xs underline-offset-4 transition-colors hover:text-foreground hover:underline"
                  onClick={() => setSuggestions(pickSuggestions(3))}
                  type="button"
                >
                  {t("Show me others")}
                </button>
              </div>
              {suggestions.map((preset) => {
                const pattern = workPattern(preset.pattern);
                return (
                  <button
                    className="flex items-center gap-3 rounded-xl border border-border bg-card p-2.5 text-left transition-colors hover:border-ring/40"
                    key={preset.id}
                    onClick={() => applyPreset(preset)}
                    type="button"
                  >
                    <Mascot
                      className="size-8 shrink-0 rounded-lg"
                      seed={preset.avatarSeed}
                      size={32}
                    />
                    <span className="flex min-w-0 flex-col">
                      {/* The kind of work first: on somebody's first minute, "당직·감시" says more
                          about what a Bot is for than any name it could be given. */}
                      <span className="truncate text-[11px] text-muted-foreground">
                        {t(pattern.name)} · {t(pattern.connection)}
                      </span>
                      <span className="truncate font-medium text-[13px]">
                        {t(preset.name)}
                      </span>
                      <span className="truncate text-[12px] text-muted-foreground">
                        {t(preset.roleDescription)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </section>

            <fieldset className="flex flex-wrap justify-center gap-2">
              <legend className="sr-only">{t("Pick a face")}</legend>
              {MASCOT_TILES.map((tile) => (
                <button
                  className={
                    "size-8 overflow-hidden rounded-lg transition hover:scale-110" +
                    (tile.id === avatarSeed
                      ? " ring-2 ring-primary"
                      : " ring-1 ring-border")
                  }
                  key={tile.id}
                  onClick={() => setAvatarSeed(tile.id)}
                  style={{ background: tile.background }}
                  type="button"
                >
                  <Mascot className="size-full" seed={tile.id} size={32} />
                </button>
              ))}
            </fieldset>

            <Field>
              <FieldLabel htmlFor="welcome-name">{t("Name")}</FieldLabel>
              <Input
                autoFocus
                id="welcome-name"
                onChange={(event) => setName(event.target.value)}
                placeholder={t("Name your Bot")}
                value={name}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="welcome-role">
                {t("What should this Bot help with?")}{" "}
                <span className="font-normal text-muted-foreground">
                  {t("(Optional)")}
                </span>
              </FieldLabel>
              <Textarea
                id="welcome-role"
                onChange={(event) => setRole(event.target.value)}
                rows={3}
                value={role}
              />
              <p className="text-muted-foreground text-sm">
                {t(
                  "Leave it blank and the Bot will ask you itself when you first talk to it.",
                )}
              </p>
            </Field>

            {problem ? (
              <p className="text-destructive text-sm" role="alert">
                {problem}
              </p>
            ) : null}

            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={() => setStep("computer")}
                type="button"
                variant="outline"
              >
                {t("Back")}
              </Button>
              <Button
                className="flex-1"
                disabled={!name.trim() || createAgent.isPending}
                type="submit"
              >
                {createAgent.isPending ? t("Creating…") : t("Get started")}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </main>
  );
}
