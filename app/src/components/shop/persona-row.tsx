import { type Persona, PERSONAS } from "@shared/persona";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { LiveRegion } from "@/components/layout/live-region";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { ensure } from "@/lib/ensure";
import { t } from "@/lib/i18n";
import { PERSONA_LABELS } from "@/lib/persona/labels";
import { savePersona } from "@/lib/persona/queries";
import { useSavedFlash } from "@/lib/saved-flash";

/**
 * 나는 — who the person said they are, where they can see it and change it.
 *
 * SAVED ON THE PRESS, apart from the shop's Save below it: this is one answer with four choices,
 * the same press the greeting took, and a Save for one tap is a Save somebody forgets. Pressing the
 * chosen one again takes it back to "not answered", as the business-kind grid does.
 *
 * THE DESCRIPTION SAYS WHAT IT DOES AND WHAT IT DOES NOT. It orders suggestions and sets how the
 * Bot addresses you; every menu and feature stays the same for everybody (`shared/persona.ts`) — a
 * 사장님 who wants a study plan gets one.
 */
export function PersonaRow() {
  const queryClient = useQueryClient();
  const headingId = useId();
  const { data: user } = useQuery(currentUserQueryOptions());
  const saved = user?.persona ?? null;
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [isSaved, flashSaved] = useSavedFlash();

  const handlePress = async (persona: Persona) => {
    if (saving) return;
    setProblem(null);
    setSaving(true);
    await ensure(
      () =>
        savePersona(persona === saved ? null : persona, queryClient)
          .then(() => flashSaved())
          .catch((caught: unknown) => {
            setProblem(
              caught instanceof Error
                ? caught.message
                : t("That was not saved. Try again."),
            );
          }),
      () => setSaving(false),
    );
  };

  return (
    <PageSection
      description={t(
        "Your Bot reads this to decide what to suggest first and how to address you. Every menu and feature stays the same for everyone.",
      )}
      title={t("I am")}
    >
      <span className="sr-only" id={headingId}>
        {t("I am")}
      </span>
      <fieldset
        aria-labelledby={headingId}
        className="mt-4 grid w-full min-w-0 grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {PERSONAS.map((persona) => (
          <Button
            aria-pressed={saved === persona}
            className="h-11 whitespace-normal rounded-xl px-3 text-sm"
            disabled={saving}
            key={persona}
            onClick={() => void handlePress(persona)}
            type="button"
            variant="outline"
          >
            {t(PERSONA_LABELS[persona])}
          </Button>
        ))}
      </fieldset>
      <div className="mt-2 flex items-center gap-3">
        <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
          {problem}
        </LiveRegion>
        <LiveRegion as="p" className="text-muted-foreground text-sm">
          {!problem && isSaved ? t("Saved") : null}
        </LiveRegion>
      </div>
    </PageSection>
  );
}
