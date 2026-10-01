import { isMadeShelf, type MadeShelf } from "@shared/made";
import {
  IconChecklist,
  IconFileDownload,
  IconFileText,
  IconPlus,
  IconTable,
} from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { PageShell } from "@/components/layout/page-shell";
import { ReadNotice } from "@/components/layout/read-states";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { focusRing } from "@/components/ui/focus";
import { Skeleton } from "@/components/ui/skeleton";
import { conversationOf, primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { requestJump } from "@/lib/channels/jump";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { activeLocale, t } from "@/lib/i18n";
import {
  kindLabel,
  MADE_STARTERS,
  type MadeItem,
  madeQueryOptions,
  SHELF_LABELS,
  shelvesDrawn,
} from "@/lib/made/queries";
import { readLineOf } from "@/lib/read-line";
import { settledOf, useReading } from "@/lib/reading";
import { cn } from "@/lib/utils";

/**
 * 만든 것 — EVERYTHING THE BOT MADE (muse-shape plan §3.5, phase 6 = v1, 2026-09-27).
 *
 * The cards the Bot put on screen and the tables it wrote, read out of the conversation
 * (`server/src/agents/made.ts`), newest first. Pressing one goes back to where it is in the
 * conversation — the card itself, not a copy of it: the conversation is where it can be asked
 * about and changed ("그 안내문 날짜 바꿔 줘" makes a new one, which lands here too).
 *
 * + STARTS ONE IN THE CONVERSATION and sends nothing: a sentence stem in the box, for the person to
 * say what the table is of.
 *
 * FILES ARE HERE SINCE PHASE 8 (2026-10-02): a file the Bot handed over with a file card is listed
 * by its name, and pressing it goes to the card — which is where its 내려받기 is. No 파일 filter is
 * drawn before there is a file to show under it, so the page asks for that shelf's first page
 * beside whatever it is showing; when 파일 is then pressed, that answer is already here.
 *
 * A GRID WHERE THERE IS ROOM, one column on a phone.
 */
const madeSearchSchema = z
  .object({ shelf: z.string().optional().catch(undefined) })
  .catch({});

export const Route = createFileRoute("/_authed/_app/made")({
  validateSearch: madeSearchSchema,
  component: MadePage,
});

const SHELF_ICONS: Record<MadeShelf, typeof IconTable> = {
  table: IconTable,
  checklist: IconChecklist,
  text: IconFileText,
  file: IconFileDownload,
};

function MadePage() {
  const search = Route.useSearch();
  const shelf: MadeShelf | null = isMadeShelf(search.shelf)
    ? search.shelf
    : null;
  const mine = useMyBots();
  const channels = useQuery(channelListQueryOptions());
  const bot = mine.bots ? primaryBot(mine.bots, channels.data) : undefined;
  const conversation = bot ? conversationOf(bot.id, channels.data) : undefined;
  const made = useInfiniteQuery({
    ...madeQueryOptions(bot?.id ?? "", shelf),
    enabled: Boolean(bot),
  });
  const reading = useReading(made, {
    isEmpty: (data) => data.pages.every((page) => page.items.length === 0),
  });
  // Whether the Bot has handed over a file at all. The same query the 파일 filter itself reads.
  const files = useInfiniteQuery({
    ...madeQueryOptions(bot?.id ?? "", "file"),
    enabled: Boolean(bot),
  });
  const hasFile =
    shelf === "file" ||
    (files.data?.pages.some((page) => page.items.length > 0) ?? false);
  const settled = settledOf(reading);
  const items = settled ? settled.data.pages.flatMap((page) => page.items) : [];

  return (
    <PageShell
      action={
        bot ? <StartMenu agentId={bot.id} channelId={conversation?.id} /> : null
      }
      description={t(
        "The tables, checklists, notices and files your Bot made for you. Press one to see it in the conversation.",
      )}
      title={t("Made")}
      width="wide"
    >
      <nav
        aria-label={t("Show")}
        className="-mx-1 mb-4 flex flex-wrap gap-1.5 px-1"
      >
        {shelvesDrawn(hasFile).map((key) => {
          const isActive = (shelf ?? "all") === key;
          return (
            <Link
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm transition-colors",
                isActive
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card hover:bg-muted/60",
                focusRing,
              )}
              key={key}
              search={key === "all" ? {} : { shelf: key }}
              to="/made"
            >
              {t(SHELF_LABELS[key])}
            </Link>
          );
        })}
      </nav>
      <ReadNotice
        className="mb-3"
        line={readLineOf(reading, {
          failed: t("What your Bot made could not be read."),
          notHere: t("This deployment does not keep what the Bot made."),
        })}
        onRetry={() => void made.refetch()}
      />
      {reading.state === "loading" ||
      (mine.bots === undefined && !mine.isError) ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : null}
      {reading.state === "empty" ? (
        <p className="text-muted-foreground text-sm" data-made-empty>
          {shelf
            ? t("Nothing here yet.")
            : t(
                "Nothing made yet. Ask for a table or a notice in the conversation.",
              )}
        </p>
      ) : null}
      {items.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-made>
          {items.map((item) => (
            <li className="contents" key={`${item.messageId}:${item.title}`}>
              <MadeCard item={item} />
            </li>
          ))}
        </ul>
      ) : null}
      {made.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <Button
            disabled={made.isFetchingNextPage}
            onClick={() => void made.fetchNextPage()}
            variant="outline"
          >
            {made.isFetchingNextPage ? t("Loading…") : t("Show older")}
          </Button>
        </div>
      ) : null}
    </PageShell>
  );
}

/** When it was made, in the person's language: the date and the minute. */
function madeWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(activeLocale, {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** One thing the Bot made: its kind, the title it gave it, when — and a press back to it. */
function MadeCard({ item }: { item: MadeItem }) {
  const navigate = useNavigate();
  const Icon = SHELF_ICONS[item.shelf];
  const kind = kindLabel(item.tool);

  const handleOpen = () => {
    requestJump({ channelId: item.channelId, messageId: item.messageId });
    void navigate({
      params: { channelId: item.channelId },
      to: "/channel/$channelId",
    });
  };

  return (
    <button
      className={cn(
        "flex min-w-0 items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-accent",
        focusRing,
      )}
      data-made-item={item.tool}
      onClick={handleOpen}
      type="button"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon aria-hidden="true" className="size-4.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 font-medium text-sm leading-5">
          {item.title ?? kind}
        </span>
        <span className="text-muted-foreground text-xs">
          {kind} · {madeWhen(item.at)}
        </span>
      </span>
    </button>
  );
}

/**
 * + : a stem in the conversation's box, sent by nobody. Into the Bot's conversation when there is
 * one, else the compose screen, which takes a draft the same way (phase 5).
 */
function StartMenu({
  agentId,
  channelId,
}: {
  agentId: string;
  channelId: string | undefined;
}) {
  const navigate = useNavigate();
  const handleStart = (draft: string) => {
    if (channelId) {
      void navigate({
        params: { channelId },
        search: { draft },
        to: "/channel/$channelId",
      });
      return;
    }
    void navigate({ search: { agent: agentId, draft }, to: "/channel/new" });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button aria-label={t("Make something")} data-made-start size="sm" />
        }
      >
        <IconPlus aria-hidden="true" />
        {t("Make")}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto p-1.5">
        {MADE_STARTERS.map((starter) => (
          <DropdownMenuItem
            className="whitespace-nowrap px-2 py-1.5"
            key={starter.label}
            onClick={() => handleStart(t(starter.draft))}
          >
            {t(starter.label)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
