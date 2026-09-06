import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ConsentLine } from "@/components/legal/consent-line";
import { Button } from "@/components/ui/button";
import { agreeToLegal } from "@/lib/auth/consent";
import { t } from "@/lib/i18n";

/**
 * The text changed since this person agreed to it, so they are asked again.
 *
 * `_authed` sends anybody whose recorded version is not the current one here — including somebody
 * who joined before there was a text to agree to — and nowhere else until they press the button.
 * The first run has its own copy of the sentence on its first screen (`welcome.tsx`); this screen
 * exists for everybody who is already through that door.
 *
 * It says what happened and offers the two documents before the button, and nothing else: no
 * summary of what changed, because a summary this app wrote would be a third legal text, and the
 * version on the page is the one being agreed to.
 */
export const Route = createFileRoute("/_authed/consent")({
  component: ConsentScreen,
});

function ConsentScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  // A ref, not state, for the same reason as the welcome screen: two presses in one frame both
  // read a stale flag, and the second would post a second time while the first is navigating.
  const submitting = useRef(false);

  const handleAgree = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setProblem(null);
    try {
      await agreeToLegal(queryClient);
      await navigate({ to: "/" });
    } catch {
      submitting.current = false;
      setProblem(t("Could not record your agreement. Try again."));
    }
  };

  return (
    <main className="flex h-svh w-full items-center justify-center overflow-y-auto bg-background p-8">
      <section className="my-auto flex w-full max-w-md flex-col items-center gap-6 text-center">
        <h1 className="font-semibold text-2xl">
          {t("The terms have changed")}
        </h1>
        <p className="text-muted-foreground">
          {t(
            "The terms of service and the privacy policy were updated since you last agreed to them. Read them, then continue.",
          )}
        </p>
        <ConsentLine className="text-pretty text-muted-foreground text-sm" />
        {problem ? (
          <p className="text-destructive text-sm" role="alert">
            {problem}
          </p>
        ) : null}
        <Button className="w-full" onClick={() => void handleAgree()}>
          {t("Agree and continue")}
        </Button>
      </section>
    </main>
  );
}
