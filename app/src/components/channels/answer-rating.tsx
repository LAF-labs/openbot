import {
  IconThumbDown,
  IconThumbDownFilled,
  IconThumbUp,
  IconThumbUpFilled,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/lib/i18n";
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

/** How long the line saying a press arrived stays beside the thumbs. */
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
 * 좋아요 and 아쉬워요 under one of a Bot's answers.
 *
 * QUIET BY DESIGN. Two ghost icons in the gutter the copy button already lives in, revealed with it
 * on hover and on keyboard focus, in the muted colour — the answer is what a person came to read,
 * and a pair of buttons that competed with it under every reply would be the loudest thing in a
 * conversation. They stay up while their popover is open or the line saying a press arrived is
 * showing, the one time the person is looking at them rather than at the answer (`data-lingering`).
 *
 * CHOSEN IS WHAT THE SERVER KEPT. A thumb is drawn filled, and pressed, from the conversation's
 * ratings as the server answered them, and a press writes the server's answer into that cache —
 * never the press itself. 좋아요 is one press. 아쉬워요 opens a popover that asks why, offers four
 * reasons and a note, and sends when 보내기 is pressed; closing it sends nothing. Opened on an
 * answer already rated 아쉬워요, it holds what was sent, so pressing again edits rather than starts
 * over. Either thumb can be pressed at any time to change one's mind; the server replaces the row.
 *
 * RECEIVED IS SAID IN ONE PLACE FOR BOTH. Once the server has it, a short line beside the thumbs
 * says so — and for words, whether they reached the people who make the app. A sent popover closes
 * rather than turning into a receipt: measured, the smaller receipt no longer needed the room below
 * and jumped above the thumbs, over the answer it was about.
 *
 * NOTHING AT ALL WHEN THE SERVER CANNOT KEEP ONE. The conversation's ratings are read first; if that
 * read is refused — a deployment without the route, a conversation this person cannot rate in —
 * the controls are not drawn, rather than drawn and saving nowhere.
 */
export const AnswerRatingControls = ({
  channelId,
  messageId,
}: {
  channelId: string;
  messageId: string;
}) => {
  const queryClient = useQueryClient();
  const ratings = useQuery({
    ...answerRatingsQueryOptions(channelId),
    select: (all: AnswerRatings) => all[messageId] ?? null,
  });
  const rated = ratings.data ?? null;

  const [open, setOpen] = useState(false);
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
      setOpen(false);
    },
  });

  if (ratings.isPending || ratings.isError) return null;

  const isUp = rated?.rating === "up";
  const isDown = rated?.rating === "down";

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setReason(isDown ? (rated?.reason ?? null) : null);
      setNote(isDown ? (rated?.note ?? "") : "");
      setReceived(null);
      down.reset();
      up.reset();
    }
    setOpen(next);
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

  return (
    <div
      className="flex items-center gap-0.5"
      data-lingering={open || received || up.isError ? "true" : undefined}
      data-slot="answer-rating"
    >
      <Button
        aria-label={t("Good answer")}
        aria-pressed={isUp}
        className="text-muted-foreground"
        disabled={up.isPending}
        onClick={handleUp}
        size="icon-sm"
        title={t("Good answer")}
        type="button"
        variant="ghost"
      >
        {isUp ? (
          <IconThumbUpFilled className="size-3.5" />
        ) : (
          <IconThumbUp className="size-3.5" />
        )}
      </Button>
      <Popover onOpenChange={handleOpenChange} open={open}>
        <PopoverTrigger
          render={
            <Button
              aria-label={t("Could be better")}
              aria-pressed={isDown}
              className="text-muted-foreground"
              size="icon-sm"
              title={t("Could be better")}
              type="button"
              variant="ghost"
            >
              {isDown ? (
                <IconThumbDownFilled className="size-3.5" />
              ) : (
                <IconThumbDown className="size-3.5" />
              )}
            </Button>
          }
        />
        {/*
         * Wide enough for the four reasons on one line: a second row of chips is the height that
         * decides whether the question fits under the thumbs or has to open over the answer.
         */}
        <PopoverContent className="w-80">
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              handleSend();
            }}
          >
            <PopoverTitle>{t("What fell short?")}</PopoverTitle>
            {/*
             * A fieldset and `aria-pressed` on the buttons — the grammar the effort chooser and the
             * face picker already use for one choice out of a few, so a reader arriving on the second
             * reason hears which one is already chosen.
             */}
            <fieldset className="flex flex-wrap gap-1.5">
              <legend className="sr-only">{t("Reason")}</legend>
              {ANSWER_RATING_REASONS.map((key) => (
                <Button
                  aria-pressed={reason === key}
                  key={key}
                  // Pressing the chosen one again un-chooses it: a reason is optional.
                  onClick={() =>
                    setReason((current) => (current === key ? null : key))
                  }
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
                maxLength={ANSWER_NOTE_MAX_LENGTH}
                onChange={(event) => setNote(event.target.value)}
                placeholder={t(
                  "For example: I asked about today, not yesterday.",
                )}
                rows={3}
                value={note}
              />
              <div className="flex items-start justify-between gap-2">
                <PopoverDescription>
                  {t(
                    "Only what you write here reaches the people who make the app. The answer itself is not sent.",
                  )}
                </PopoverDescription>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {note.length}/{ANSWER_NOTE_MAX_LENGTH}
                </span>
              </div>
            </div>
            {down.error ? (
              <p className="text-destructive text-xs" role="alert">
                {down.error.message}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => handleOpenChange(false)}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("Cancel")}
              </Button>
              <Button disabled={down.isPending} size="sm" type="submit">
                {down.isPending ? t("Sending…") : t("Send")}
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
      {received ? (
        <span className="px-1 text-muted-foreground text-xs" role="status">
          {received}
        </span>
      ) : null}
      {up.error ? (
        <span className="px-1 text-destructive text-xs" role="alert">
          {up.error.message}
        </span>
      ) : null}
    </div>
  );
};
