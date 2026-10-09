import { IconThumbDown, IconThumbUp } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef, useState } from "react";
import { LiveRegion } from "@/components/layout/live-region";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/lib/i18n";
import { failureSentence } from "@/lib/press";
import {
  ANSWER_NOTE_MAX_LENGTH,
  ANSWER_RATING_REASONS,
  type AnswerRatingReason,
  type AnswerRatings,
  answerRatingKeys,
  answerRatingsQueryOptions,
  type RatingChoice,
  type RatingReceipt,
  rateAnswer,
} from "@/lib/support/answer-ratings";
import { own } from "@/lib/own";

/** How long the line saying a press arrived stays beside the answer's controls. */
const RECEIVED_MS = 3_500;

/** A reason in the popover's words. Literal `t()` calls, so the dictionary walk sees every one. */
function reasonLabel(reason: AnswerRatingReason): string {
  switch (reason) {
    case "not-as-asked":
      return t("Not what I asked for");
    case "wrong-facts":
      return t("Wrong facts");
    case "too-slow":
      return t("Too slow");
    case "other":
      return t("Something else");
  }
}

/** What to say once the server has a rating: that it arrived, and — for words — who has them now. */
function receivedLine(sent: RatingReceipt): string {
  if (sent.rating === "up") return t("Got it, thank you.");
  return sent.told.length > 0
    ? t("Sent. It reached the people who make the app.")
    : t("Sent. Thank you for telling us.");
}

/**
 * 좋아요 and 아쉬워요 for one of a Bot's answers: what the server holds, and what a press does.
 *
 * THEY ARE TWO ROWS OF THE ANSWER'S "MORE" MENU (`answer-more.tsx`), since 2026-10-04. They were
 * two thumbs in the row under every answer, beside 복사 and 인용 and the icon for what the Bot did:
 * five controls under a sentence, on a screen whose trouble — the owner's word — was how much it
 * shows. Nothing they do went with the thumbs. It is all here, as a hook, because the menu's rows
 * are gone the moment one is pressed and what follows a press outlives them: the question 아쉬워요
 * asks, and the line that says a rating arrived.
 *
 * CHOSEN IS WHAT THE SERVER KEPT. A row is drawn as chosen from the conversation's ratings as the
 * server answered them, and a press writes the server's answer into that cache — never the press
 * itself. 좋아요 is one press. 아쉬워요 opens a popover that asks why, offers four reasons and a
 * note, and sends when 보내기 is pressed; closing it sends nothing. Opened on an answer already
 * rated 아쉬워요, it holds what was sent, so pressing again edits rather than starts over. Either
 * can be pressed at any time to change one's mind; the server replaces the row.
 *
 * RECEIVED IS SAID IN ONE PLACE FOR BOTH. Once the server has it, a short line beside the answer's
 * controls says so — and for words, whether they reached the people who make the app. A sent
 * popover closes rather than turning into a receipt: measured, the smaller receipt no longer needed
 * the room below and jumped above the controls, over the answer it was about.
 *
 * NOTHING AT ALL WHEN THE SERVER CANNOT KEEP ONE. The conversation's ratings are read first; if
 * that read is refused — a deployment without the route, a conversation this person cannot rate
 * in — the rows are not offered (`isOffered`), rather than drawn and saving nowhere.
 */
export function useAnswerRating(channelId: string, messageId: string) {
  const queryClient = useQueryClient();
  const ratings = useQuery({
    ...answerRatingsQueryOptions(channelId),
    select: (all: AnswerRatings) => own(all, messageId) ?? null,
  });
  const rated = ratings.data ?? null;

  const [isAsking, setAsking] = useState(false);
  const [reason, setReason] = useState<AnswerRatingReason | null>(null);
  const [note, setNote] = useState("");
  const [received, setReceived] = useState<string | null>(null);
  const receivedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (receivedTimer.current) clearTimeout(receivedTimer.current);
    },
    [],
  );

  /** The server's answer, into the one cache every answer in this conversation reads from. */
  const keep = (sent: RatingReceipt) => {
    queryClient.setQueryData<AnswerRatings>(
      answerRatingKeys.channel(channelId),
      (all) => ({
        ...all,
        [messageId]: {
          rating: sent.rating,
          reason: sent.reason,
          note: sent.note,
          updatedAt: sent.updatedAt,
        },
      }),
    );
    setReceived(receivedLine(sent));
    if (receivedTimer.current) clearTimeout(receivedTimer.current);
    receivedTimer.current = setTimeout(() => setReceived(null), RECEIVED_MS);
  };

  const up = useMutation({
    mutationFn: () =>
      rateAnswer(channelId, messageId, {
        rating: "up",
        reason: null,
        note: "",
      }),
    onSuccess: keep,
  });
  const down = useMutation({
    mutationFn: (choice: RatingChoice) =>
      rateAnswer(channelId, messageId, choice),
    onSuccess: (sent) => {
      keep(sent);
      setAsking(false);
    },
  });

  const isDown = rated?.rating === "down";

  /** 아쉬워요's question, opening or closing. Opening it starts from what the server holds. */
  const handleAskingChange = (next: boolean) => {
    if (next) {
      setReason(isDown ? (rated?.reason ?? null) : null);
      setNote(isDown ? (rated?.note ?? "") : "");
      setReceived(null);
      down.reset();
      up.reset();
    }
    setAsking(next);
  };

  const handleUp = () => {
    if (up.isPending) return;
    setReceived(null);
    up.mutate();
  };

  const handleSend = () => {
    if (down.isPending) return;
    down.mutate({ rating: "down", reason, note });
  };

  return {
    /** The server can keep a rating here: the read of this conversation's ratings came back. */
    isOffered: !ratings.isPending && !ratings.isError,
    /** What the server holds for this answer. */
    chosen: rated?.rating ?? null,
    handleUp,
    isSendingUp: up.isPending,
    upError: up.error,
    isAsking,
    handleAskingChange,
    reason,
    /** Pressing the chosen one again un-chooses it: a reason is optional. */
    handleReason: (key: AnswerRatingReason) =>
      setReason((current) => (current === key ? null : key)),
    note,
    handleNote: setNote,
    handleSend,
    isSendingDown: down.isPending,
    downError: down.error,
    received,
    /**
     * The one time the person is looking at the controls rather than at the answer: the question
     * is open, or a line is saying what a press came to. The row of reply actions stays up for it
     * (`data-lingering`, `ReplyActions`).
     */
    isLingering: isAsking || received !== null || up.isError,
  };
}

export type RatingOfAnswer = ReturnType<typeof useAnswerRating>;

/**
 * The two rows in the answer's menu.
 *
 * A RADIO GROUP, because that is what they are — one of two, or neither — and it is what tells a
 * screen reader which one the server holds (`aria-checked`); the thumbs said it with
 * `aria-pressed`, which a menu's row does not have. The value is the server's and a press does not
 * move it: 좋아요 is drawn as chosen once the server has it, and 아쉬워요 only once its question
 * was sent.
 *
 * `closeOnClick`, which a radio row does not do by default: a row that stayed open after 좋아요
 * would be a menu sitting over the line that says the rating arrived.
 */
export function AnswerRatingEntries({
  className,
  onAsk,
  rating,
}: {
  className: string;
  /** 아쉬워요 was pressed. The menu opens the question once it has closed (`AnswerMenu`). */
  onAsk: () => void;
  rating: RatingOfAnswer;
}) {
  return (
    <DropdownMenuRadioGroup value={rating.chosen}>
      <DropdownMenuRadioItem
        className={className}
        closeOnClick
        disabled={rating.isSendingUp}
        onClick={rating.handleUp}
        value="up"
      >
        <IconThumbUp />
        {t("Good answer")}
      </DropdownMenuRadioItem>
      <DropdownMenuRadioItem
        className={className}
        closeOnClick
        onClick={onAsk}
        value="down"
      >
        <IconThumbDown />
        {t("Could be better")}
      </DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  );
}

/**
 * 아쉬워요's question: what fell short, and anything the person wants to add.
 *
 * ANCHORED TO THE "MORE" BUTTON, NOT TO THE ROW THAT OPENED IT. The row is in a menu that is gone
 * by the time this is drawn; the button stays, under the answer the question is about. It has no
 * trigger of its own. It is opened once the menu has handed the keyboard back to that button
 * (`AnswerMenu`), so that is where closing it returns the keyboard: sent or cancelled, the next
 * Tab goes on from the answer it was about. Rendered under happy-dom, naming the button as where
 * focus must return changed nothing — not after 보내기, not after a press in the composer, which
 * keeps the caret either way — so it is not named.
 */
export function AnswerRatingQuestion({
  anchor,
  rating,
}: {
  anchor: RefObject<HTMLElement | null>;
  rating: RatingOfAnswer;
}) {
  return (
    <Popover
      onOpenChange={(next, details) => {
        /*
         * Non-modal, and still not closed by a press elsewhere while 보내기 is out: the refusal is
         * said inside the panel, and a panel closed under it would take the answer with it.
         */
        if (!next && rating.isSendingDown) {
          details.cancel();
          return;
        }
        rating.handleAskingChange(next);
      }}
      open={rating.isAsking}
    >
      {/*
       * Wide enough for the four reasons on one line: a second row of chips is the height that
       * decides whether the question fits under the answer or has to open over it.
       */}
      <PopoverContent anchor={anchor} className="w-80">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            rating.handleSend();
          }}
        >
          <PopoverTitle>{t("What fell short?")}</PopoverTitle>
          {/*
           * A fieldset and `aria-pressed` on the buttons — the grammar for one choice out of a few,
           * so a reader arriving on the second reason hears which one is already chosen.
           */}
          <fieldset
            className="flex flex-wrap gap-1.5"
            // Locked while it sends, like the note below: what is on screen is what went.
            disabled={rating.isSendingDown}
          >
            <legend className="sr-only">{t("Reason")}</legend>
            {ANSWER_RATING_REASONS.map((key) => (
              <Button
                aria-pressed={rating.reason === key}
                key={key}
                onClick={() => rating.handleReason(key)}
                size="xs"
                type="button"
                variant="outline"
              >
                {reasonLabel(key)}
              </Button>
            ))}
          </fieldset>
          <div className="flex flex-col gap-1">
            <Textarea
              aria-label={t("Tell us more (optional)")}
              disabled={rating.isSendingDown}
              maxLength={ANSWER_NOTE_MAX_LENGTH}
              onChange={(event) => rating.handleNote(event.target.value)}
              placeholder={t(
                "For example: I asked about today, not yesterday.",
              )}
              rows={3}
              value={rating.note}
            />
            <div className="flex items-start justify-between gap-2">
              <PopoverDescription>
                {t(
                  "Only what you write here reaches the people who make the app. The answer itself is not sent.",
                )}
              </PopoverDescription>
              <span className="shrink-0 text-muted-foreground text-xs">
                {rating.note.length}/{ANSWER_NOTE_MAX_LENGTH}
              </span>
            </div>
          </div>
          <LiveRegion as="p" className="text-destructive text-xs" tone="alert">
            {/* Never `.message`: a request with no answer is the browser's "Failed to fetch". */}
            {rating.downError ? failureSentence(rating.downError) : null}
          </LiveRegion>
          <div className="flex justify-end gap-2">
            <Button
              disabled={rating.isSendingDown}
              onClick={() => rating.handleAskingChange(false)}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={rating.isSendingDown}
              // Keeps the focus it was pressed with while the rating is on its way.
              focusableWhenDisabled={rating.isSendingDown}
              size="sm"
              type="submit"
            >
              {rating.isSendingDown ? t("Sending…") : t("Send")}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/**
 * What a rating came to, said beside the answer's controls: that it arrived, or that it did not.
 *
 * OUTSIDE THE MENU, which closes on the press: a line inside it would be gone before it was read,
 * and a 좋아요 that never reached the server would have failed without a word. Mounted for as long
 * as the answer is, so what it says is heard when it is said.
 */
export function AnswerRatingSaid({ rating }: { rating: RatingOfAnswer }) {
  return (
    <>
      <LiveRegion as="span" className="px-1 text-muted-foreground text-xs">
        {rating.received}
      </LiveRegion>
      <LiveRegion
        as="span"
        className="px-1 text-destructive text-xs"
        tone="alert"
      >
        {rating.upError ? failureSentence(rating.upError) : null}
      </LiveRegion>
    </>
  );
}
