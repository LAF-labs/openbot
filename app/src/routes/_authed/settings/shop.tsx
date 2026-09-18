import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { LiveRegion } from "@/components/layout/live-region";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { BusinessKindPicker } from "@/components/shop/business-kind-picker";
import {
  DailyPlacePicker,
  DailyPlacePickerSkeleton,
} from "@/components/shop/daily-place-picker";
import { Button } from "@/components/ui/button";
import { focusRing } from "@/components/ui/focus";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { connectionsOverviewQueryOptions } from "@/lib/connections/queries";
import { ensure } from "@/lib/ensure";
import { t } from "@/lib/i18n";
import { useSavedFlash } from "@/lib/saved-flash";
import {
  type BusinessKindId,
  EMPTY_SHOP,
  placesToOffer,
  sameShop,
} from "@/lib/shop/catalogue";
import { saveShop } from "@/lib/shop/queries";

/**
 * 내 가게 — the first run's two answers, where a person can see them and change them.
 *
 * WHAT IS PRESSED HERE IS WHAT EVERY BOT IS TOLD. The answers ride in front of every run of every
 * Bot (`shared/prompt/shop.ko.ts`), so this screen is the one place somebody can check what their
 * Bots believe about the business, and the only place besides the first run that can change it — no
 * Bot can (`server/tests/shop-boundary.test.ts`).
 *
 * ONE SAVE FOR BOTH, AND ONLY WHEN SOMETHING MOVED. The answer is replaced whole, like the first run
 * saves it, so a press here and a press there cannot interleave into an answer nobody left on the
 * screen. The button stays grey until the screen differs from what is saved, and says 저장됨 for a
 * moment after — a Save that changes nothing visible is a Save somebody presses twice.
 */
const ShopSettings = () => {
  const queryClient = useQueryClient();
  const { data: user } = useQuery(currentUserQueryOptions());
  const saved = user?.shop ?? EMPTY_SHOP;
  const [kind, setKind] = useState<BusinessKindId | null>(saved.kind);
  const [places, setPlaces] = useState<string[]>([...saved.places]);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [isSaved, flashSaved] = useSavedFlash();

  const overview = useQuery(connectionsOverviewQueryOptions());
  /*
   * ORDERED BY THE SAVED KIND, NOT THE PRESSED ONE. Following the pressed kind re-sorted every chip
   * under the pointer the moment a kind was pressed — measured on this screen, where both questions
   * sit together; on the first run they are two screens and the order is settled before the chips
   * are drawn. The list re-sorts once, after a save, which is a moment the person caused.
   */
  const offered = overview.data
    ? placesToOffer(overview.data, saved.kind, places)
    : null;
  const answer = { kind, places };
  const isChanged = !sameShop(answer, saved);

  const handleSave = async () => {
    if (saving || !isChanged) return;
    setProblem(null);
    setSaving(true);
    // `try`…`catch`…`finally`: the `catch` as the promise's own and the `finally` through `ensure` —
    // the React Compiler cannot compile the statement in a component.
    await ensure(
      () =>
        saveShop(answer, queryClient)
          .then((held) => {
            // What the server holds now, which is what the screen should show from here on.
            setKind(held.kind);
            setPlaces([...held.places]);
            flashSaved();
          })
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
    <PageShell
      description={t(
        "What kind of business this is and where you work every day. Every Bot reads it before it starts, and no Bot can change it.",
      )}
      title={t("My shop")}
    >
      <PageSection title={t("What you do")}>
        <div className="mt-4">
          <BusinessKindPicker
            disabled={saving}
            label={{ name: t("What you do") }}
            onChange={setKind}
            value={kind}
          />
        </div>
      </PageSection>

      <PageSection
        description={t(
          "Your Bots look there first, and ask you to connect any that are not connected yet.",
        )}
        title={t("Places you use every day")}
      >
        <div className="mt-4">
          {offered && offered.length > 0 ? (
            <DailyPlacePicker
              align="start"
              disabled={saving}
              label={{ name: t("Places you use every day") }}
              onChange={setPlaces}
              places={offered}
              value={places}
            />
          ) : offered ? (
            <p className="text-muted-foreground text-sm">
              {t("There is nothing this deployment can connect yet.")}
            </p>
          ) : overview.isError ? (
            <p className="text-muted-foreground text-sm" role="status">
              {t("The places could not be loaded. Refresh to try again.")}
            </p>
          ) : (
            <DailyPlacePickerSkeleton />
          )}
        </div>
        {/*
         * Picking a place here does not connect it: that is a sign-in or a consent, and it happens
         * on 연결. Said beside the chips, with the way there, so nobody leaves this screen believing
         * their Bots can now open 배민.
         */}
        <p className="mt-4 text-muted-foreground text-sm">
          {t("Picking a place does not connect it.")}{" "}
          <Link
            className={`underline underline-offset-2 hover:text-foreground ${focusRing}`}
            to="/settings/connected-accounts"
          >
            {t("Connect it on Connections")}
          </Link>
        </p>
      </PageSection>

      <div className="mt-10 flex items-center gap-3">
        <Button
          disabled={saving || !isChanged}
          onClick={() => void handleSave()}
          type="button"
        >
          {saving ? t("Saving…") : t("Save")}
        </Button>
        {/* Both mounted with the page, so what the press came to is heard when it is said. */}
        <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
          {problem}
        </LiveRegion>
        <LiveRegion as="p" className="text-muted-foreground text-sm">
          {!problem && isSaved ? t("Saved") : null}
        </LiveRegion>
      </div>
    </PageShell>
  );
};

// Below the component it names: a `const` arrow is not hoisted, and naming it above is a TDZ error.
export const Route = createFileRoute("/_authed/settings/shop")({
  component: ShopSettings,
});
