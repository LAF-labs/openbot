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
  const [role, setRole] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

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
            <p className="text-muted-foreground">
              {t(
                "Each one is a colleague you can hand real work to. They keep working when this window is closed.",
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
            </div>

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
