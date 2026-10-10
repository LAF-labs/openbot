import { type SearchHit, markTerms, searchTerms } from "@shared/search";
import { IconMessage, IconSearch, IconUser } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { PageShell } from "@/components/layout/page-shell";
import { ReadNotice } from "@/components/layout/read-states";
import { Button } from "@/components/ui/button";
import { focusRing } from "@/components/ui/focus";
import { Input } from "@/components/ui/input";
import { useMyBots } from "@/lib/agents/my-bots";
import { requestJump } from "@/lib/channels/jump";
import { projectName } from "@/lib/channels/projects";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { activeLocale, t } from "@/lib/i18n";
import { readLineOf } from "@/lib/read-line";
import { settledOf, useReading } from "@/lib/reading";
import {
  searchQueryOptions,
  setSearchTyped,
  useSearchTyped,
} from "@/lib/search/queries";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

/**
 * 검색 — WHAT WAS SAID, IN THE MAIN CONVERSATION AND EVERY PROJECT (2026-10-10, record §1 and §3,
 * piece 4-3).
 *
 * A person remembers a word of what was said and not where: the main conversation is months long
 * and each project is another record beside it. One box reads them all, and a hit is the way to
 * the message itself — the conversation opens at that row, as 만든 것 and 홈's cards open theirs.
 *
 * A BOX AND WHAT IT FOUND. No filters, no tabs, no sentence explaining the page. A hit is where it
 * was said, when, and the words around the match with the match standing out; who said it is an
 * icon. Before anything is typed the page is the box.
 *
 * IT ASKS AS A PERSON TYPES, a moment after they stop — a search that waits for Enter looks broken
 * to somebody used to every other search box, and one that asks at every keystroke asks five
 * times for one Korean syllable. Enter asks at once.
 *
 * WHAT WAS TYPED OUTLIVES THE PAGE (`lib/search/queries.ts`), so the way back from a hit is to the
 * list it was pressed in — and it is never in the address.
 */
export const Route = createFileRoute("/_authed/_app/search")({
  component: SearchPage,
});

/** How long after the last keystroke the search is made. */
const SETTLE_MS = 250;

function SearchPage() {
  const typed = useSearchTyped();
  /** What is being searched for: what was typed, once it has stood still a moment. */
  const [asked, setAsked] = useState(typed);
  useEffect(() => {
    if (typed === asked) return;
    const timer = setTimeout(() => setAsked(typed), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [typed, asked]);

  const terms = searchTerms(asked);
  const found = useInfiniteQuery(searchQueryOptions(asked));
  const reading = useReading(found, {
    isEmpty: (data) => data.pages.every((page) => hitsOf(page).length === 0),
  });
  const settled = terms ? settledOf(reading) : null;
  const hits = settled ? settled.data.pages.flatMap(hitsOf) : [];

  const mine = useMyBots();
  const channels = useQuery(channelListQueryOptions());
  const now = useNow();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAsked(typed);
  };

  return (
    <PageShell title={t("Search")}>
      {/* biome-ignore lint/a11y/useSemanticElements: `search` as an element is newer than the shell's oldest webview. */}
      <form className="relative mt-6" onSubmit={handleSubmit} role="search">
        <IconSearch
          aria-hidden="true"
          className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-muted-foreground"
        />
        <Input
          aria-label={t("Search every conversation")}
          autoComplete="off"
          // The page is the box: there is nothing else on it to be on.
          autoFocus
          className="h-11 ps-9"
          data-search-box
          enterKeyHint="search"
          onChange={(event) => setSearchTyped(event.target.value)}
          placeholder={t("Search every conversation")}
          type="search"
          value={typed}
        />
      </form>
      <ReadNotice
        className="mt-3"
        line={
          terms
            ? readLineOf(reading, {
                failed: t("The conversations could not be searched."),
                notHere: t("This deployment cannot search conversations."),
              })
            : null
        }
        onRetry={() => void found.refetch()}
      />
      {terms && reading.state === "empty" ? (
        <p className="mt-6 text-muted-foreground text-sm" data-search-none>
          {t("No message has those words.")}
        </p>
      ) : null}
      {hits.length > 0 ? (
        <ul
          className={cn(
            "mt-4 flex flex-col",
            // The list of the search before, while this one's answer is on its way.
            found.isPlaceholderData && "opacity-60",
          )}
          data-search-hits
        >
          {hits.map((hit) => (
            <li key={`${hit.channelId}:${hit.messageId}`}>
              <Hit
                hit={hit}
                now={now}
                terms={terms ?? []}
                where={whereOf(hit, channels.data, mine.bots)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {terms && found.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <Button
            disabled={found.isFetchingNextPage}
            onClick={() => void found.fetchNextPage()}
            variant="outline"
          >
            {found.isFetchingNextPage ? t("Loading…") : t("Show older")}
          </Button>
        </div>
      ) : null}
    </PageShell>
  );
}

/** A page's hits, of whatever arrived: an answer that is no page has none. */
function hitsOf(page: unknown): SearchHit[] {
  const hits = (page as { hits?: unknown } | null)?.hits;
  return Array.isArray(hits)
    ? hits.filter(
        (hit): hit is SearchHit =>
          hit !== null &&
          typeof hit === "object" &&
          typeof hit.channelId === "string" &&
          typeof hit.messageId === "string" &&
          typeof hit.snippet === "string",
      )
    : [];
}

/**
 * Which conversation, as the rest of the app calls it: a project by its name, the main one 채팅 —
 * the word on the switch that opens it. An account from before the cap has several Bots, and there
 * the main conversation is called by its Bot.
 */
function whereOf(
  hit: SearchHit,
  channels: readonly ChannelSummary[] | undefined,
  bots: readonly { id: string; name: string }[] | undefined,
): string {
  const channel = Array.isArray(channels)
    ? channels.find((one) => one?.id === hit.channelId)
    : undefined;
  if ((channel?.kind ?? hit.kind) === "project") {
    return projectName(channel ?? { name: hit.channelName });
  }
  if ((bots?.length ?? 0) <= 1) return t("Chat");
  const botId = channel?.agentIds?.[0];
  return (
    bots?.find((bot) => bot.id === botId)?.name ?? hit.channelName ?? t("Chat")
  );
}

/** When, as short as it can be said: the minute today, the day this year, and the year before that. */
function hitWhen(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  if (at.toDateString() === now.toDateString()) {
    return at.toLocaleTimeString(activeLocale, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return at.toLocaleDateString(activeLocale, {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

function Hit({
  hit,
  now,
  terms,
  where,
}: {
  hit: SearchHit;
  now: Date;
  terms: readonly string[];
  where: string;
}) {
  const isMine = hit.role === "user";
  const Who = isMine ? IconUser : IconMessage;
  const runs = markTerms(hit.snippet, terms);
  return (
    <Link
      className={cn(
        "flex flex-col gap-1 rounded-lg px-2 py-2.5 transition-colors hover:bg-accent",
        focusRing,
      )}
      data-search-hit={hit.messageId}
      // Left for the conversation to take when it is drawn: which row to show.
      onClick={() =>
        requestJump({ channelId: hit.channelId, messageId: hit.messageId })
      }
      params={{ channelId: hit.channelId }}
      to="/channel/$channelId"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
        <Who aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="sr-only">
          {isMine ? t("You said") : t("Your Bot said")}
        </span>
        <span className="min-w-0 truncate" data-search-where>
          {where}
        </span>
        <span className="shrink-0 tabular-nums">{hitWhen(hit.at, now)}</span>
      </span>
      <span className="line-clamp-2 text-pretty text-muted-foreground text-sm">
        {runs.map((run) =>
          run.isMatch ? (
            <mark
              className="bg-transparent font-semibold text-foreground"
              key={run.at}
            >
              {run.text}
            </mark>
          ) : (
            <span key={run.at}>{run.text}</span>
          ),
        )}
      </span>
    </Link>
  );
}
