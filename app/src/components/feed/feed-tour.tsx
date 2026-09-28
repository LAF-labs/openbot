import { effectivePersona, type Persona } from "@shared/persona";
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
 * page shows a post-shaped card for each place beside the conversation, each a press away, at no
 * model cost. They are not stored and not counted as unseen: they are the page's own words, and they
 * go the moment there is something real to read.
 *
 * THE SAME FIVE FOR EVERYBODY; the persona only orders them (CLAUDE.md: a hint, never a gate).
 */
type Stop = {
  key: string;
  to:
    | "/ideas"
    | "/goals"
    | "/made"
    | "/routines"
    | "/settings/connected-accounts";
  topic: string;
  title: string;
  body: string;
};

const STOPS: readonly Stop[] = [
  {
    key: "connections",
    to: "/settings/connected-accounts",
    topic: "Connections",
    title: "Connect what you use, and I can handle it myself",
    body: "Calendar, mail, Notion, Canva, and the sites a shop runs on. What I may do with each is yours to set.",
  },
  {
    key: "ideas",
    to: "/ideas",
    topic: "Ideas",
    title: "Things worth handing me, one press each",
    body: "Pick one and it waits in the conversation for you to finish the sentence. Nothing starts until you send it.",
  },
  {
    key: "goals",
    to: "/goals",
    topic: "Goals",
    title: "Tell me a goal and I keep track of it with you",
    body: "An exam, a habit, this month's sales. I save it only when you say yes, and log each step on its timeline.",
  },
  {
    key: "routines",
    to: "/routines",
    topic: "Routines",
    title: "Checks I run at the times you set",
    body: "A morning briefing, a weekly summary, a watch on a price. Say it in the conversation and I set it up.",
  },
  {
    key: "made",
    to: "/made",
    topic: "Made",
    title: "Everything I make, kept in one place",
    body: "Tables, checklists and drafts from our conversation, to open again whenever you need them.",
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
      className="flex flex-col gap-3"
      data-feed-tour
    >
      {stops.map((stop) => (
        <Link
          className={`flex flex-col gap-2 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/40 ${focusRing}`}
          data-tour-stop={stop.key}
          key={stop.key}
          to={stop.to}
        >
          <span className="font-medium text-foreground/80 text-xs">
            {t(stop.topic)}
          </span>
          <span className="font-semibold text-base leading-6">
            {t(stop.title)}
          </span>
          <span className="text-muted-foreground text-sm leading-6">
            {t(stop.body)}
          </span>
        </Link>
      ))}
    </section>
  );
}
