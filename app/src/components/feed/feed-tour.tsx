import { effectivePersona, type Persona } from "@shared/persona";
import {
  IconBulb,
  IconClock,
  IconLayoutGrid,
  IconPlugConnected,
  IconTarget,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { focusRing } from "@/components/ui/focus";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";

/**
 * 소식 ON THE FIRST DAY: A TOUR, DRAWN BY THE APP, BEFORE THE FIRST REAL POST.
 *
 * Muse's first edition is nine posts written by the product rather than the model — one per place,
 * plus how to change the feed (`~/laf/docs/muse-web-walkthrough-2026-09-28.md`) — and its generated
 * posts then took a day to arrive. Ours opened on one grey line. So until the first post lands, the
 * page shows a row for each place beside the conversation, each a press away, at no model cost.
 * They are not stored and not counted as unseen: they are the page's own words, and they go the
 * moment there is something real to read.
 *
 * THE SAME FIVE FOR EVERYBODY; the persona only orders them (CLAUDE.md: a hint, never a gate).
 *
 * ONE LINE EACH, BESIDE THE PLACE'S OWN ICON (2026-10-04). Each stop was a card of three lines —
 * the place, what it does, and two sentences more — 269 characters in Korean for five links, on a
 * page whose job that day is to offer one button. A stop is what the place does for the person, in
 * a line, with the place's name under it and the icon the sidebar and the menu already draw for it.
 */
type Stop = {
  key: string;
  to:
    | "/ideas"
    | "/goals"
    | "/made"
    | "/routines"
    | "/settings/connected-accounts";
  /** The place's icon, as `app-sidebar/places.ts` and the sidebar draw it. */
  icon: typeof IconBulb;
  topic: string;
  title: string;
};

const STOPS: readonly Stop[] = [
  {
    key: "connections",
    to: "/settings/connected-accounts",
    icon: IconPlugConnected,
    topic: "Connections",
    title: "Connect what you use, and I can handle it myself",
  },
  {
    key: "ideas",
    to: "/ideas",
    icon: IconBulb,
    topic: "Ideas",
    title: "Things worth handing me, one press each",
  },
  {
    key: "goals",
    to: "/goals",
    icon: IconTarget,
    topic: "Goals",
    title: "Tell me a goal and I keep track of it with you",
  },
  {
    key: "routines",
    to: "/routines",
    icon: IconClock,
    topic: "Routines",
    title: "Checks I run at the times you set",
  },
  {
    key: "made",
    to: "/made",
    icon: IconLayoutGrid,
    topic: "Made",
    title: "Everything I make, kept in one place",
  },
];

const ORDER: Readonly<Record<Persona, readonly string[]>> = {
  student: ["ideas", "goals", "connections", "made", "routines"],
  worker: ["connections", "routines", "ideas", "made", "goals"],
  owner: ["connections", "routines", "ideas", "goals", "made"],
  other: ["ideas", "goals", "connections", "routines", "made"],
};

/** The stops in the order this person would want them. Unknown persona: the catalogue's order. */
export function tourStops(persona: Persona | null): readonly Stop[] {
  if (!persona) return STOPS;
  return ORDER[persona]
    .map((key) => STOPS.find((stop) => stop.key === key))
    .filter((stop): stop is Stop => stop !== undefined);
}

export function FeedTour() {
  const { data: user } = useQuery(currentUserQueryOptions());
  const stops = tourStops(effectivePersona(user?.persona, user?.shop));
  return (
    <section
      aria-label={t("Getting started")}
      className="flex flex-col gap-2"
      data-feed-tour
    >
      {stops.map((stop) => (
        <Link
          className={`flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-accent ${focusRing}`}
          data-tour-stop={stop.key}
          key={stop.key}
          to={stop.to}
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <stop.icon aria-hidden="true" className="size-4.5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-medium text-sm leading-5">
              {t(stop.title)}
            </span>
            <span className="text-muted-foreground text-xs">
              {t(stop.topic)}
            </span>
          </span>
        </Link>
      ))}
    </section>
  );
}
