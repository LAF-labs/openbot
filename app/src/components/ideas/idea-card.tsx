import { IconClock, IconDots, IconPlugConnected } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { CATEGORY_ICONS } from "@/components/goals/goal-parts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { focusRing } from "@/components/ui/focus";
import { t } from "@/lib/i18n";
import {
  categoryLabel,
  ideaDraft,
  ideaFor,
  ideaWaitsOn,
  type OfferedIdea,
} from "@/lib/ideas/queries";
import { cn } from "@/lib/utils";

/**
 * One 아이디어: what the Bot will do, in a line.
 *
 * THE WHOLE CARD IS THE PRESS, AND IT SENDS NOTHING. A card somebody can ask now opens the
 * conversation with its sentence in the composer (`?draft=`, `composer/prefill.ts`) for them to
 * finish and send; the model is not called until they do. With no conversation yet — a Bot nobody
 * has spoken to — the compose screen takes the sentence the same way. A card that waits on a
 * connection goes to 연결, and says so before it is pressed.
 *
 * 다음에 SITS BEHIND ⋯, OUTSIDE THE PRESS. A button inside a link is two presses in one place; the
 * menu is beside the card's content, not in it.
 *
 * ONE LINE (2026-10-04, the owner: too many characters, and words where an icon would do). A card
 * was up to five lines — its category, what the Bot will do, what comes out, why it is near the
 * top, and on a routine a sentence about the time — and the page of twenty-two was 1,042
 * characters at 1280, the most of any screen. What is left is the one a person chooses by:
 *  - the category is its ICON, the one 목표 draws for the same seven, named in its tooltip;
 *  - what comes out mostly said the title again ("세 가지로 써 드릴게요" / "골라 쓸 수 있는 세 가지")
 *    and is the card's tooltip and description now, there to be asked for;
 *  - a routine is marked by the clock this app draws for 루틴, and the sentence about its time is
 *    the clock's name — the time is in the title and in the composer before anything is sent;
 *  - why it is near the top is the order itself.
 * The one line that stays under a title is what a card waits on: it changes where the press goes.
 */
export function IdeaCard({
  agentId,
  card,
  channelId,
  onDismiss,
}: {
  agentId: string | undefined;
  card: OfferedIdea;
  channelId: string | undefined;
  onDismiss: () => void;
}) {
  const idea = ideaFor(card);
  // A key a newer server knows and this build does not: nothing to say about it, so nothing drawn.
  if (!idea) return null;
  const isConnect = card.state === "connect";
  const waitsOn = ideaWaitsOn(card);
  const title = t(idea.title);
  const makes = t(idea.makes);
  const Icon = CATEGORY_ICONS[idea.category];
  const repeats = t(
    "It repeats at the time in the sentence. Change the time before you send it.",
  );
  // A routine that cannot be asked yet is not marked as one: its line is what it waits on.
  const isMarkedRoutine = idea.kind === "routine" && !isConnect;
  const lastWordAt = title.lastIndexOf(" ") + 1;

  const body = (
    <>
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
        data-idea-category={idea.category}
        title={categoryLabel(idea.category)}
      >
        <Icon aria-hidden="true" className="size-4.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium text-sm leading-5">
          {isMarkedRoutine ? (
            <>
              {title.slice(0, lastWordAt)}
              {/*
               * The clock is kept with the title's last word: measured at 375, a title that filled
               * its line sent the clock to a line of its own under it — a margin does not hold it
               * there, and neither does a no-break space before an inline box.
               */}
              <span className="whitespace-nowrap">
                {title.slice(lastWordAt)}
                <span
                  aria-label={repeats}
                  className="ml-1.5 inline-flex align-[-0.125em] text-muted-foreground"
                  data-idea-repeats
                  role="img"
                  title={repeats}
                >
                  <IconClock aria-hidden="true" className="size-3.5" />
                </span>
              </span>
            </>
          ) : (
            title
          )}
        </span>
        {waitsOn ? (
          <span
            className="flex items-start gap-1 text-warning text-xs"
            data-idea-waits
          >
            {/* On the line's first row when the names wrap, not between its two. */}
            <IconPlugConnected
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0"
            />
            {waitsOn}
          </span>
        ) : null}
      </span>
    </>
  );

  const linkClass = cn(
    "flex min-w-0 flex-1 items-center gap-3 rounded-xl p-3 pr-11 text-left transition-colors hover:bg-accent",
    focusRing,
  );

  return (
    <div
      className="relative flex rounded-xl border border-border bg-card"
      data-idea={card.key}
      data-idea-state={card.state}
    >
      {isConnect ? (
        <Link
          className={linkClass}
          title={makes}
          to="/settings/connected-accounts"
        >
          {body}
        </Link>
      ) : channelId ? (
        <Link
          className={linkClass}
          params={{ channelId }}
          search={{ draft: ideaDraft(idea) }}
          title={makes}
          to="/channel/$channelId"
        >
          {body}
        </Link>
      ) : (
        <Link
          className={linkClass}
          search={{
            ...(agentId ? { agent: agentId } : {}),
            draft: ideaDraft(idea),
          }}
          title={makes}
          to="/channel/new"
        >
          {body}
        </Link>
      )}
      <div className="absolute top-1/2 right-2 -translate-y-1/2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={t("Options for “{title}”", { title })}
                size="icon-sm"
                variant="ghost"
              >
                <IconDots />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-auto">
            <DropdownMenuItem className="whitespace-nowrap" onClick={onDismiss}>
              {t("Not now")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
