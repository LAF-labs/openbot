import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/lib/i18n";
import { type DailyPlace, PLACES_SHOWN_FIRST } from "@/lib/shop/catalogue";

/**
 * 매일 쓰는 곳 — as many as apply, each a press.
 *
 * A SHORT LIST FIRST. Twenty-two chips is a catalogue to read, and the first run is supposed to be
 * a couple of presses. So the likeliest eight for the chosen kind of business are drawn and the
 * rest wait behind 더 보기 — but a place already picked is never behind it, or somebody coming back
 * would find their own answer hidden and think it lost. Every place stays reachable; this orders,
 * it does not filter.
 *
 * `places` arrives already ordered and already narrowed to what this deployment can touch
 * (`placesToOffer`); the picker owns only the fold and the presses. A press appends, so the answer
 * keeps the order things were pressed in — the first place pressed is the one the first-task row
 * offers to connect.
 */
export const DailyPlacePicker = ({
  align = "center",
  disabled,
  label,
  onChange,
  places,
  value,
}: {
  /** Centred under a heading on the first run; along the left edge of a Settings section. */
  align?: "center" | "start";
  disabled?: boolean;
  /** What the group is called: the id of the heading asking the question, or the words. */
  label: { labelledBy: string } | { name: string };
  onChange: (places: string[]) => void;
  places: readonly DailyPlace[];
  value: readonly string[];
}) => {
  const hiddenPick = places
    .slice(PLACES_SHOWN_FIRST)
    .some((place) => value.includes(place.id));
  // Held open once opened, and open from the start when an answer would otherwise be hidden.
  const [isOpen, setIsOpen] = useState(hiddenPick);
  const shown =
    isOpen || hiddenPick ? places : places.slice(0, PLACES_SHOWN_FIRST);
  const hasMore = places.length > PLACES_SHOWN_FIRST;

  const handleToggle = (id: string) =>
    onChange(
      value.includes(id)
        ? value.filter((picked) => picked !== id)
        : [...value, id],
    );

  return (
    <div
      className={`flex w-full flex-col gap-3 ${align === "center" ? "items-center" : "items-start"}`}
    >
      <fieldset
        {...("labelledBy" in label
          ? { "aria-labelledby": label.labelledBy }
          : { "aria-label": label.name })}
        className={`flex min-w-0 flex-wrap gap-2 ${align === "center" ? "justify-center" : "justify-start"}`}
        data-slot="daily-places"
      >
        {shown.map((place) => (
          <Button
            aria-pressed={value.includes(place.id)}
            className="rounded-full px-3"
            disabled={disabled}
            key={place.id}
            onClick={() => handleToggle(place.id)}
            type="button"
            variant="outline"
          >
            {t(place.name)}
          </Button>
        ))}
      </fieldset>
      {hasMore && !hiddenPick ? (
        <Button
          onClick={() => setIsOpen((open) => !open)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {isOpen ? t("Show fewer") : t("Show more")}
        </Button>
      ) : null}
    </div>
  );
};

/**
 * Widths vary so the placeholder reads as chips of words rather than as a bar. Written out whole:
 * Tailwind only emits a class it can see spelled in the source.
 */
const SKELETON_WIDTHS = [
  "w-20",
  "w-16",
  "w-24",
  "w-14",
  "w-20",
  "w-18",
  "w-22",
  "w-16",
] as const;

/** The same block at the same height while the places are still being asked for. */
export const DailyPlacePickerSkeleton = () => (
  <div className="flex w-full flex-wrap justify-center gap-2">
    {SKELETON_WIDTHS.map((width, index) => (
      <Skeleton
        className={`h-8 rounded-full ${width}`}
        key={`${width}-${index.toString()}`}
      />
    ))}
  </div>
);
