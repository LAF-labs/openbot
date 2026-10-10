import {
  type Icon,
  IconLayoutGrid,
  IconLayoutList,
  IconTarget,
} from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  chatCard,
  chatCardMeta,
  chatCardTitle,
} from "@/components/ui/card-surface";
import { cardToDraw, GalleryCard } from "@/components/gallery/gallery-card";
import { focusRing } from "@/components/ui/focus";
import { requestJump } from "@/lib/channels/jump";
import { feedQueryOptions, feedUnseenQueryOptions } from "@/lib/feed/queries";
import { goalsQueryOptions } from "@/lib/goals/queries";
import {
  cardWhen,
  feedCard,
  goalsCard,
  type HomeCardView,
  madeCard,
} from "@/lib/home/cards";
import { t } from "@/lib/i18n";
import { madeQueryOptions } from "@/lib/made/queries";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

/**
 * 홈'S FIRST CARDS, UNDER 오늘: 소식 · 목표 · 만든 것 (2026-10-10, record §1 and §2, piece 3-4).
 *
 * Each is the one fact its page would have opened on: a name, one figure at the right, ONE line
 * (`lib/home/cards.ts` decides what, and that a card with nothing to say is not drawn). The name
 * is the way to the page. THE LINE IS THE WAY TO THE THING IT NAMES, where that has a place of its
 * own: a goal opens on 목표 as itself, and a made thing in the conversation, at the message that
 * handed it over — as their own pages open them. (From #151, the other pull request written for
 * this piece; a card that names one thing and opens a list of them makes a person find it twice.)
 * 소식's posts have no place of their own, so its card is one press, to 소식. They are drawn on the conversation's own card surface, so the cards a person will
 * ask for in a sentence (§2) stand beside them later without either changing.
 *
 * THE CARD OF THE PAGE THAT IS OPEN IS NOT DRAWN. On 소식 the page is the posts; a line beside it
 * naming the newest of them is that post twice, a hand's width apart — the same reason 소식 leaves
 * 오늘 to this panel (`routes/_authed/_app/feed.tsx`), the other way round.
 *
 * THEY READ WHAT THE PAGES READ, under the pages' own keys, so opening a page after seeing its
 * card asks for nothing twice. And they change nothing: 소식's posts are marked seen by 소식's page
 * and by nothing here, so the mark on the menu's button outlives a glance at this card.
 *
 * AN ANSWER THAT DID NOT COME IS A CARD THAT IS NOT DRAWN. These queries do not throw into the
 * panel's seam; 오늘, above, is what the panel is for.
 */

type Drawn = {
  is: "feed" | "goals" | "made";
  to: "/feed" | "/goals" | "/made";
  icon: Icon;
  name: string;
  view: HomeCardView | null;
};

export function HomeCards({
  botId,
}: {
  /** Whose 만든 것: the one Bot's — on an account with several, the one last spoken to. */
  botId: string | undefined;
}) {
  const now = useNow();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const feed = useInfiniteQuery(feedQueryOptions());
  const unseen = useQuery(feedUnseenQueryOptions());
  const goals = useQuery(goalsQueryOptions());
  const made = useInfiniteQuery({
    ...madeQueryOptions(botId ?? "", null),
    enabled: botId !== undefined,
  });

  const all: Drawn[] = [
    {
      icon: IconLayoutList,
      is: "feed",
      name: t("Updates"),
      to: "/feed",
      view: feedCard(feed.data?.pages?.[0], unseen.data),
    },
    {
      icon: IconTarget,
      is: "goals",
      name: t("Goals"),
      to: "/goals",
      view: goalsCard(goals.data),
    },
    {
      icon: IconLayoutGrid,
      is: "made",
      name: t("Made"),
      to: "/made",
      view: madeCard(made.data?.pages?.[0]),
    },
  ];
  const cards = all.filter(
    (card) =>
      card.view !== null &&
      pathname !== card.to &&
      !pathname.startsWith(`${card.to}/`),
  );
  if (cards.length === 0) return null;

  return (
    <ul className="flex flex-col gap-2 px-3" data-home-cards>
      {cards.map(({ icon: CardIcon, is, name, to, view }) => {
        if (!view) return null;
        const head = (
          <span className={cn(chatCardMeta, "flex items-center gap-1.5")}>
            <CardIcon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <CardFigure is={is} now={now} view={view} />
          </span>
        );
        const body = (
          <>
            <span
              className={cn(chatCardTitle, "line-clamp-2 text-pretty")}
              data-home-card-line
            >
              {view.line}
            </span>
            {view.note ? (
              <span className={cn(chatCardMeta, "truncate")}>{view.note}</span>
            ) : null}
          </>
        );
        const { thing } = view;
        const made = view.card
          ? cardToDraw(view.card.name, view.card.args)
          : null;
        if (made) {
          /*
           * THE THING ITSELF, NOT ITS NAME (piece 7-1). The last thing the Bot made is a card, and
           * a card is drawn here as it was drawn in the conversation — its own frame, so no box
           * around it. Held to a height: a long notice is read where it was written, which is
           * where a press on it goes.
           */
          const drawn = (
            <span
              className="block max-h-72 overflow-hidden rounded-xl"
              data-home-card-drawn={view.card?.name}
            >
              <GalleryCard card={made} />
            </span>
          );
          return (
            <li key={is}>
              <div className="flex flex-col gap-1" data-home-card={is}>
                <Link
                  className={cn(PART, focusRing)}
                  data-home-card-page
                  to={to}
                >
                  {head}
                </Link>
                {thing?.kind === "made" ? (
                  <Link
                    aria-label={view.line}
                    className={cn("block rounded-xl", focusRing)}
                    data-home-card-thing
                    onClick={() =>
                      requestJump({
                        channelId: thing.channelId,
                        messageId: thing.messageId,
                      })
                    }
                    params={{ channelId: thing.channelId }}
                    to="/channel/$channelId"
                  >
                    {drawn}
                  </Link>
                ) : (
                  drawn
                )}
              </div>
            </li>
          );
        }
        return (
          <li key={is}>
            {thing ? (
              /*
               * TWO PRESSES IN ONE CARD: the name, to the page; the line, to the thing it names.
               * Two links side by side and not one inside the other, which is not a thing a
               * document can say — so the card is a box here, and each half is its own row to
               * press.
               */
              <div
                className={cn(chatCard, "flex flex-col p-1")}
                data-home-card={is}
              >
                <Link
                  className={cn(PART, focusRing)}
                  data-home-card-page
                  to={to}
                >
                  {head}
                </Link>
                {thing.kind === "goal" ? (
                  <Link
                    className={cn(PART, "flex flex-col gap-0.5", focusRing)}
                    data-home-card-thing
                    search={{ goal: thing.id }}
                    to="/goals"
                  >
                    {body}
                  </Link>
                ) : (
                  <Link
                    className={cn(PART, "flex flex-col gap-0.5", focusRing)}
                    data-home-card-thing
                    // Left for the conversation to take when it is drawn: which row to show.
                    onClick={() =>
                      requestJump({
                        channelId: thing.channelId,
                        messageId: thing.messageId,
                      })
                    }
                    params={{ channelId: thing.channelId }}
                    to="/channel/$channelId"
                  >
                    {body}
                  </Link>
                )}
              </div>
            ) : (
              <Link
                className={cn(
                  chatCard,
                  "flex flex-col gap-1 px-3 py-2.5 transition-colors hover:bg-accent",
                  focusRing,
                )}
                data-home-card={is}
                data-home-card-page
                to={to}
              >
                {head}
                {body}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One half of a card that has two presses: laid out as the whole card's padding was. */
const PART = "rounded-xl px-2 py-1.5 transition-colors hover:bg-accent";

/**
 * The one figure at a card's right end: how many are new (the mark the menu's 소식 wears), how many
 * are in progress (quiet — nothing about it is new), or when the thing was made.
 */
function CardFigure({
  is,
  now,
  view,
}: {
  is: Drawn["is"];
  now: Date;
  view: HomeCardView;
}) {
  if (view.count !== null && is === "feed") {
    return (
      <span
        className="shrink-0 rounded-full bg-mark px-1.5 font-medium text-white leading-5"
        data-home-card-figure="new"
      >
        <span aria-hidden="true">{view.count}</span>
        <span className="sr-only">
          {t("{count} new", { count: view.count })}
        </span>
      </span>
    );
  }
  if (view.count !== null) {
    return (
      <span className="shrink-0 tabular-nums" data-home-card-figure="count">
        <span aria-hidden="true">{view.count}</span>
        <span className="sr-only">
          {t("{count} in progress", { count: view.count })}
        </span>
      </span>
    );
  }
  const when = cardWhen(view.at, now);
  return when ? (
    <span className="shrink-0 tabular-nums" data-home-card-figure="when">
      {when}
    </span>
  ) : null;
}
