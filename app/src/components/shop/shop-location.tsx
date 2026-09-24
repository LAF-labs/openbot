import { type Coordinates, NO_WHEREABOUTS } from "@shared/whereabouts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { LiveRegion } from "@/components/layout/live-region";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { ensure } from "@/lib/ensure";
import { t } from "@/lib/i18n";
import { isImeKey } from "@/lib/ime";
import { useSavedFlash } from "@/lib/saved-flash";
import {
  canAskDeviceLocation,
  clearPlace,
  readDeviceCoordinates,
  savePlace,
} from "@/lib/whereabouts/queries";

/**
 * 가게 위치 — where the shop is, as a city or district.
 *
 * WHY IT EXISTS. The Bot's browser runs on a cloud VM, and asked for today's weather a Bot reported
 * a site's guess of the VM's place (제주시) as its owner's. The place written here is what every run
 * is told instead (`shared/prompt/person.ko.ts`), and it is what the Bot saves when it asks and hears
 * the answer in a conversation — so this is the one place a person sees it and clears it.
 *
 * "가게 위치", NOT "내 위치": the place that decides the weather a shop owner asks about, and the
 * shops nearby, is the shop's — and "내 위치" reads as a device being followed around, which nothing
 * here does. It sits on 내 가게 beside what the shop does and where it works.
 *
 * THE DEVICE'S LOCATION ONLY WHERE IT CAN BE ASKED FOR (`canAskDeviceLocation`): a browser tab, on a
 * press, with the browser's own permission prompt, rounded to two decimals before anything keeps it.
 * The desktop shell's webview answers no such request, and a button that asks and then says nothing
 * is worse than no button — there, the words are the whole of it.
 */
export function ShopLocation() {
  const queryClient = useQueryClient();
  const placeId = useId();
  const { data: user } = useQuery(currentUserQueryOptions());
  const saved =
    user && typeof user === "object"
      ? (user.whereabouts ?? NO_WHEREABOUTS)
      : NO_WHEREABOUTS;
  const [place, setPlace] = useState(saved.place ?? "");
  const [coordinates, setCoordinates] = useState<Coordinates | null>(
    saved.coordinates,
  );
  const [busy, setBusy] = useState<"saving" | "locating" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [isSaved, flashSaved] = useSavedFlash();

  const isChanged =
    place.trim() !== (saved.place ?? "") ||
    coordinates?.latitude !== saved.coordinates?.latitude ||
    coordinates?.longitude !== saved.coordinates?.longitude;
  const hasAnything = place.trim() !== "" || coordinates !== null;
  const isKept = saved.place !== null || saved.coordinates !== null;

  const run = async (
    work: () => Promise<unknown>,
    kind: "saving" | "locating",
  ) => {
    setProblem(null);
    setBusy(kind);
    await ensure(
      () =>
        work().catch((caught: unknown) => {
          setProblem(
            caught instanceof Error
              ? caught.message
              : t("That was not saved. Try again."),
          );
        }),
      () => setBusy(null),
    );
  };

  const handleSave = () =>
    run(async () => {
      const held = await savePlace(
        { place: place.trim() || null, coordinates },
        queryClient,
      );
      setPlace(held.place ?? "");
      setCoordinates(held.coordinates);
      flashSaved();
    }, "saving");

  const handleClear = () =>
    run(async () => {
      await clearPlace(queryClient);
      setPlace("");
      setCoordinates(null);
      flashSaved();
    }, "saving");

  const handleUseDevice = () =>
    run(async () => {
      setCoordinates(await readDeviceCoordinates());
    }, "locating");

  return (
    <PageSection
      description={t(
        "Where the shop is, as a city and district. When your Bot looks up the weather or somewhere nearby, it goes by this place rather than where its server is. Left empty, the Bot asks you once when it needs one and saves your answer here.",
      )}
      title={t("Shop location")}
    >
      <div className="mt-4 flex max-w-md flex-col gap-2">
        <Label htmlFor={placeId}>{t("City and district")}</Label>
        <Input
          autoComplete="off"
          disabled={busy !== null}
          id={placeId}
          maxLength={40}
          onChange={(event) => setPlace(event.target.value)}
          onKeyDown={(event) => {
            // The Enter that accepts a Korean syllable is not the Enter that saves.
            if (event.key === "Enter" && isImeKey(event)) {
              event.preventDefault();
            }
          }}
          placeholder={t("e.g. Seoul Gangnam-gu")}
          value={place}
        />
        {coordinates ? (
          <p className="text-muted-foreground text-sm">
            {t("This device's location, around {latitude}, {longitude}", {
              latitude: coordinates.latitude.toFixed(2),
              longitude: coordinates.longitude.toFixed(2),
            })}
          </p>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          disabled={busy !== null || !isChanged || !hasAnything}
          onClick={() => void handleSave()}
          type="button"
        >
          {/* Its own name: the section above has a 저장 of its own, and two buttons called that
              on one screen is a guess about which one saves what. */}
          {busy === "saving" ? t("Saving…") : t("Save the location")}
        </Button>
        {canAskDeviceLocation() ? (
          <Button
            disabled={busy !== null}
            onClick={() => void handleUseDevice()}
            type="button"
            variant="outline"
          >
            {busy === "locating"
              ? t("Finding this device…")
              : t("Use this device's location")}
          </Button>
        ) : null}
        {isKept ? (
          <Button
            disabled={busy !== null}
            onClick={() => void handleClear()}
            type="button"
            variant="ghost"
          >
            {t("Clear the location")}
          </Button>
        ) : null}
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
