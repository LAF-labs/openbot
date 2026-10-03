import { IconDots, IconListDetails, IconQuote } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { offerDraft } from "@/components/channels/composer/prefill";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { quotedReply } from "@/lib/channels/quote";
import { t } from "@/lib/i18n";
import {
  AnswerRatingEntries,
  AnswerRatingQuestion,
  AnswerRatingSaid,
  type RatingOfAnswer,
  useAnswerRating,
} from "./answer-rating";
import type { AnswerSteps } from "./chat-messages";

/**
 * Open the record of what the Bot did for an answer, or put it away. What it has to know of the
 * runs is handed back to it by the answer that was pressed (`ChatTranscript`, `handleToggleSteps`).
 */
export type ToggleSteps = (
  runIds: readonly string[],
  rows: readonly string[],
  isOpen: boolean,
) => void;

/** A row of the menu: an icon and its words on one line, as the sidebar's menus draw theirs. */
const ENTRY = "gap-2 whitespace-nowrap px-2 py-1.5";
/** The same row where it can be the chosen one: the room on the right is the check's. */
const CHOICE_ENTRY = "gap-2 whitespace-nowrap py-1.5 pl-2";

/**
 * "MORE", THE SECOND OF THE TWO CONTROLS UNDER A BOT'S ANSWER.
 *
 * The row under an answer had grown to five: 복사, 인용해 답하기, 좋아요, 아쉬워요 and the icon that
 * opens what the Bot did. The owner, 2026-10-04, on the app as a whole: it shows far too many
 * words, and looks bad beside Grok Bot and Muse. Shown a mock-up of the conversation, the choice
 * was "proposal A": the answer is words on the page, and under it two controls — 복사, and this,
 * which holds the rest. Nothing was taken away. In this order:
 *
 *  - 인용해 답하기: the answer's first line, quoted, in this conversation's composer with the caret
 *    under it — "> 춘천은 오늘 구름많고…" and a new line to answer on. Through the composer's own
 *    offer (`prefill.ts`), so it never writes over something the person was already typing.
 *  - 좋아요 and 아쉬워요, and everything that follows a rating (`answer-rating.tsx`).
 *  - What the Bot did on the way to this answer, where it did anything that is not already in the
 *    conversation: 이 답을 위해 한 일 3개. Pressed, every step is drawn where it happened, above
 *    the answer, and the row reads 한 일 접기; pressed again, they go (`stepRunsOf` has the
 *    history, `stepsByAnswer` what an answer takes).
 *
 * A FAILED STEP IS BEHIND THIS BUTTON NOW, SO THE BUTTON SAYS SO. A step that did not work is put
 * away like any other (`staysInTheOpen`), and what kept that from hiding it was the icon that
 * opened the record: the warning colour, and "…· 1개는 안 됨" in its name. That icon is a row in
 * here. So this button takes the colour, and its name says a step did not work; the row keeps the
 * count.
 *
 * WHERE THE ANSWER CAN BE NEITHER QUOTED NOR RATED — one still being written, the half a failed
 * turn left, a screen with no conversation yet — the menu holds the record alone, and where there
 * is no record either there is no button: a menu with nothing in it is a control that does nothing.
 */
export function AnswerMore({
  channelId,
  isStepsOpen,
  messageId,
  onToggleSteps,
  steps,
  text,
}: {
  /** The conversation, where this answer can be quoted and rated in it. Absent offers neither. */
  channelId?: string | undefined;
  /** Every step this answer opens is drawn above it. */
  isStepsOpen: boolean;
  /** The message's own id: what a rating of it is keyed by. */
  messageId: string;
  onToggleSteps?: ToggleSteps | undefined;
  /** `AnswerSteps`, as JSON: the answer's row is memoised on primitives. Absent, nothing to open. */
  steps?: string | undefined;
  text: string;
}) {
  if (channelId) {
    return (
      <RateableAnswerMore
        channelId={channelId}
        isStepsOpen={isStepsOpen}
        messageId={messageId}
        onToggleSteps={onToggleSteps}
        steps={steps}
        text={text}
      />
    );
  }
  if (!steps || !onToggleSteps) return null;
  return (
    <AnswerMenu
      isStepsOpen={isStepsOpen}
      onToggleSteps={onToggleSteps}
      steps={steps}
    />
  );
}

/**
 * The menu of an answer that can be quoted and rated. Apart from `AnswerMenu` because the rating
 * is read from the server, and an answer that cannot be rated has nothing to read.
 */
function RateableAnswerMore({
  channelId,
  isStepsOpen,
  messageId,
  onToggleSteps,
  steps,
  text,
}: {
  channelId: string;
  isStepsOpen: boolean;
  messageId: string;
  onToggleSteps: ToggleSteps | undefined;
  steps: string | undefined;
  text: string;
}) {
  const rating = useAnswerRating(channelId, messageId);
  const handleQuote = () => {
    const quoted = quotedReply(text);
    if (quoted) offerDraft(channelId, quoted);
  };
  return (
    <AnswerMenu
      isStepsOpen={isStepsOpen}
      onQuote={handleQuote}
      onToggleSteps={onToggleSteps}
      rating={rating}
      steps={steps}
    />
  );
}

/** What the row that opens the record is called: how many steps it stands for, or that it closes. */
function recordName(record: AnswerSteps, isOpen: boolean): string {
  if (isOpen) return t("Hide what it did");
  const count = record.rows.length;
  return record.failed > 0
    ? t("What it did for this answer: {count} steps, {failed} did not work", {
        count,
        failed: record.failed,
      })
    : t("What it did for this answer: {count} steps", { count });
}

function AnswerMenu({
  isStepsOpen,
  onQuote,
  onToggleSteps,
  rating,
  steps,
}: {
  isStepsOpen: boolean;
  /** Absent, and `rating` with it, on an answer that can be neither quoted nor rated. */
  onQuote?: () => void;
  onToggleSteps: ToggleSteps | undefined;
  rating?: RatingOfAnswer;
  steps: string | undefined;
}) {
  const [isOpen, setOpen] = useState(false);
  /** 아쉬워요 was pressed: its question is opened once this menu has closed. See `handleSettled`. */
  const [asksNext, setAsksNext] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const record =
    steps && onToggleSteps ? (JSON.parse(steps) as AnswerSteps) : null;
  const failed = record?.failed ?? 0;
  const name = failed > 0 ? t("More. A step did not work") : t("More");

  /*
   * THE QUESTION OPENS AFTER THE MENU HAS CLOSED, NOT WITH THE PRESS. A precaution, from reading
   * Base UI and not from seeing it go wrong: a menu that closes hands the keyboard back to the
   * button that opened it, and a panel that is not modal closes when the keyboard leaves it for
   * anything but the place it came from. Opened in the press, which of the two moves the focus
   * last is theirs to decide — under happy-dom it works either way — and a question that flashed
   * and went would read as 아쉬워요 having been sent. Opened once the menu is done, there is no
   * order to depend on: the button has the keyboard, the panel takes it from there, and closing
   * the panel gives it back (held in `answer-rating-render.test.ts`).
   */
  const handleSettled = (open: boolean) => {
    if (open || !asksNext) return;
    setAsksNext(false);
    rating?.handleAskingChange(true);
  };

  return (
    <div
      className="flex items-center gap-0.5"
      /*
       * HELD UP WHILE THE MENU IS OPEN. The row of reply actions is drawn while the pointer is over
       * the answer, and the menu is drawn somewhere else in the document: the pointer goes to it,
       * and the button it hangs from would fade out from under it. And between the menu closing and
       * the question opening, so the button the question hangs from does not blink.
       */
      data-lingering={
        isOpen || asksNext || rating?.isLingering ? "true" : undefined
      }
      data-slot="answer-more"
    >
      <DropdownMenu
        onOpenChange={setOpen}
        onOpenChangeComplete={handleSettled}
        open={isOpen}
      >
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={name}
              className={failed > 0 ? "text-warning" : "text-muted-foreground"}
              ref={more}
              size="icon-sm"
              title={name}
              type="button"
              variant="ghost"
            />
          }
        >
          <IconDots className="size-3.5" />
        </DropdownMenuTrigger>
        {/* As wide as its words: by default a menu is as wide as its button, and this one is 28px. */}
        <DropdownMenuContent align="start" className="w-auto p-1.5">
          {onQuote ? (
            <DropdownMenuItem className={ENTRY} onClick={onQuote}>
              <IconQuote />
              {t("Quote in a reply")}
            </DropdownMenuItem>
          ) : null}
          {rating?.isOffered ? (
            <AnswerRatingEntries
              className={CHOICE_ENTRY}
              onAsk={() => setAsksNext(true)}
              rating={rating}
            />
          ) : null}
          {record && onToggleSteps ? (
            <DropdownMenuItem
              className={ENTRY}
              onClick={() =>
                onToggleSteps(record.runIds, record.rows, isStepsOpen)
              }
            >
              <IconListDetails
                className={failed > 0 ? "text-warning" : undefined}
              />
              {recordName(record, isStepsOpen)}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {rating ? (
        <>
          <AnswerRatingQuestion anchor={more} rating={rating} />
          <AnswerRatingSaid rating={rating} />
        </>
      ) : null}
    </div>
  );
}
