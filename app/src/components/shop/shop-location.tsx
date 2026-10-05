import { NO_WHEREABOUTS } from "@shared/whereabouts";
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
  chooseThisDevice,
  clearPlaceOnThisDevice,
  useCanUseDeviceLocation,
} from "@/lib/whereabouts/device-place";
import { savePlace } from "@/lib/whereabouts/queries";

/**
 * 위치 — where the person is, as their Bot goes by it.
 *
 * WHY IT EXISTS. The Bot's browser runs on a cloud VM, and asked for today's weather a Bot reported
 * a site's guess of the VM's place (제주시) as its owner's. The place kept here is what every run is
 * told instead (`shared/prompt/person.ko.ts`), and it is what the Bot saves when the person says in
 * a conversation where they are — so this is the one place a person sees it and clears it.
 *
 * ONE SOURCE AT A TIME, SO THE FORM CANNOT CONTRADICT ITSELF. A place is the words in the box, or
 * this device's location, or neither (Seoul) — in that order everywhere a run reads it. The form
 * used to draw both: a box holding the place typed before and, under it, where the device had just
 * said it was. The owner pressed 이 기기 위치 쓰기, allowed it, saw the box unchanged, and asked
 * whether the place in the box was the server's location (2026-10-06). So saving typed words takes
 * the device's coordinates away in the same request, as the Bot's own `remember` always has;
 * choosing the device takes the words away; the device's line is drawn only while the device is
 * the source; and the one sentence under the title says which of the three is in use.
 *
 * THE DEVICE'S PLACE BY ITS NAME, NEVER BY ITS NUMBERS. A person reads a place, not a latitude and
 * a longitude. The server names the cell the coordinates fall in from 기상청's table — the name
 * the prompt's place line uses — and sends it as a fact (`Whereabouts.near`). Where the table has
 * no name, abroad, nothing is drawn: the sentence under the title still says the device is used.
 * THE NAME IS THE FORECAST CELL'S, five kilometres across: its two commonest districts and "등"
 * where it holds more, so somebody near a border reads their neighbours' 구 first. That is why the
 * line says 부근 after it, as the prompt's place line does — and says it once: a cell with no row
 * of its own is already named "서귀포시 부근", by its neighbour (`nameOf`, server).
 *
 * THE DEVICE'S BUTTON ONLY WHERE A PRESS REACHES THE DEVICE (`useCanUseDeviceLocation`): a browser
 * tab, and the installed app once its shell has said it can read the device — on macOS, and not in
 * a shell from before it could. Anywhere else a button that asks and then says nothing is worse
 * than no button, and the words are the whole of it.
 *
 * ONE PRESS USES THE DEVICE (`chooseThisDevice`): it reads, with the system's own question if it
 * has to ask, and saves at once. A press that is refused, goes unanswered, or cannot be saved says
 * why in a sentence and leaves the form as it was.
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
  const [busy, setBusy] = useState<"saving" | "locating" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [isSaved, flashSaved] = useSavedFlash();
  const canUseDevice = useCanUseDeviceLocation();

  // What a run goes by, read off the account and never off this form: said, else device, else Seoul.
  const source = saved.place ? "words" : saved.coordinates ? "device" : "none";
  const words = place.trim();
  const isChanged = words !== (saved.place ?? "");

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
      // The words are the place now. The device's coordinates go in the same request.
      const held = await savePlace(
        { place: words, coordinates: null },
        queryClient,
      );
      setPlace(held.place ?? "");
      flashSaved();
    }, "saving");

  const handleClear = () =>
    run(async () => {
      // Cleared for good on this device: its coordinates are not read back by themselves.
      await clearPlaceOnThisDevice(queryClient);
      setPlace("");
      flashSaved();
    }, "saving");

  const handleUseDevice = () =>
    run(async () => {
      // Read and saved in one press, and the words with it: the box is the account's again.
      const held = await chooseThisDevice(queryClient);
      setPlace(held.place ?? "");
      flashSaved();
    }, "locating");

  return (
    <PageSection
      className="scroll-mt-4"
      description={
        source === "words"
          ? t(
              "When your Bot looks up the weather or somewhere nearby, it goes by the place written here.",
            )
          : source === "device"
            ? t(
                "When your Bot looks up the weather or somewhere nearby, it goes by this device's location.",
              )
            : t(
                "When your Bot looks up the weather or somewhere nearby, it goes by Seoul for now.",
              )
      }
      // The weather card's "위치를 아직 몰라요" links here (`weather-card.tsx`).
      id="location"
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
        {source === "device" && saved.near ? (
          <p className="text-muted-foreground text-sm" data-device-place>
            {saved.near.endsWith("부근")
              ? t("This device's location: {name}", { name: saved.near })
              : t("This device's location: around {name}", {
                  name: saved.near,
                })}
          </p>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          disabled={busy !== null || !isChanged || words === ""}
          onClick={() => void handleSave()}
          type="button"
        >
          {/* Its own name: the section above has a 저장 of its own, and two buttons called that
              on one screen is a guess about which one saves what. */}
          {busy === "saving" ? t("Saving…") : t("Save the location")}
        </Button>
        {canUseDevice ? (
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
        {source === "none" ? null : (
          <Button
            disabled={busy !== null}
            onClick={() => void handleClear()}
            type="button"
            variant="ghost"
          >
            {t("Clear the location")}
          </Button>
        )}
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
