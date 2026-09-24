import type { Message } from "@ag-ui/core";
import { useRenderToolCall } from "@copilotkit/react-core/v2";
import { useQueryClient } from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconBox,
  IconCheck,
  IconCopy,
} from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Streamdown } from "streamdown";
import { LiveRegion } from "@/components/layout/live-region";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  MessageContent,
  MessageFooter,
  Message as MessageRow,
} from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { anyQuestionOpen, watchQuestions } from "@/lib/approvals";
import { sittingLabel, startsNewSitting } from "@/lib/channels/message-time";
import { channelKeys } from "@/lib/channels/queries";
import { retryWay, type StandingFailure } from "@/lib/channels/retry";
import {
  type FailureGroup,
  repeatedFailureLine,
  turnFailureSentence,
} from "@/lib/channels/turn-failure";
import { focusRing } from "@/components/ui/focus";
import { t } from "@/lib/i18n";
import { markdownComponents } from "@/lib/markdown";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { copyText } from "@/lib/clipboard";
import { acknowledgeFailureGroup } from "@/lib/notifications/outbox";
import { noteTurnFailure } from "@/lib/support/last-failure";
import { useNow } from "@/lib/use-now";
import { BrowsingCard } from "@/components/computer/browsing-card";
import { AnswerRatingControls } from "./answer-rating";
import {
  openBrowsingTask,
  type TranscriptItem,
  toVisibleChatItems,
  unsettledFrom,
  withBrowsingTasks,
} from "./chat-messages";
import { LEADING_SKILL, type QueuedMessage } from "./composer";
import { useResent, useUnsent } from "./composer/outbox";
import { useIsOnline } from "@/components/layout/connection-notice";
import { ToolRenderBoundary } from "./tool-boundary";
import { ToolLine, toolKindOf } from "./tool-line";

type ChatTranscriptProps = {
  busy?: boolean;
  /**
   * The conversation this is, which is what lets a finished answer carry 좋아요·아쉬워요.
   *
   * Absent on the compose screen, where there is no conversation yet for a rating to belong to —
   * and there is no Bot's answer on it to rate either.
   */
  channelId?: string;
  /** Comma-separated `/` command names, used to tell a skill chip from a leading slash. */
  commandNames?: string;
  messages: ReadonlyArray<Readonly<Message>>;
  /** Message id to ISO-8601, for the time separators. Empty draws none. */
  messageTimes?: Readonly<Record<string, string>>;
  /**
   * Where this person's reading stopped and where it resumed, ISO-8601, both on the server's
   * clock. The line goes above the first Bot message inside that window — and only inside it: a
   * reply that arrives after `until` was watched arrive, and is not something anybody missed.
   */
  readWindow?: { from: string; until: string };
  /**
   * Typed while the Bot had the turn, and waiting for it to finish. Empty on a screen that does not
   * offer queueing at all.
   */
  queued?: readonly QueuedMessage[];
  /** Take one back before it runs. Without it a queued line is shown but cannot be undone. */
  onRemoveQueued?: (id: string) => void;
  /**
   * Why the last turn ended without an answer, if it did — as a CODE, not a sentence.
   *
   * It used to be the sentence, and the sentence was whatever threw: `HTTP 404: {"error":"Not
   * found."}` in red on a Korean screen, or `Unable to connect. Is the computer able to access the
   * url?`. A code because the reasons are not interchangeable — a rate limit wants waiting, a Bot
   * that is not running wants looking at — and because the words belong to this surface. See
   * `lib/channels/turn-failure.ts`.
   */
  stoppedCode?: string;
  /**
   * The turns that failed earlier in this conversation: message id to failure code, and the
   * failure group the line stands for when a routine kept failing the same way.
   *
   * From the server, and therefore still here after a reload — which is what was missing. A failed
   * turn used to leave nothing behind at all: reload, and the question sat alone with no answer.
   *
   * NOT MERGED INTO THE MESSAGES. A failure is not something anybody said, and this transcript is
   * handed back to the model on the next turn.
   */
  failures?: Readonly<Record<string, StandingFailure>>;
  /**
   * Ask the same thing again. Absent draws the failure line with nothing to press.
   *
   * THE ID TRAVELS WITH THE WORDS. It used to hand back the text alone, which the caller could only
   * send as a new message: the same question stored twice, measured 2026-09-10. Now the caller
   * reruns the thread with that message where it is whenever it can, and says the words again only
   * where the Bot has already answered part of it (`retryWay`) — which is a second asking, and is
   * stored as one.
   *
   * Offered under the last failure whoever's words it is under (UI/UX audit 0.5.3, item 5): the
   * person's question, or the half answer the Bot got out before it stopped. Never under a question
   * somebody has asked past, and never under a routine's heading, which nobody asked.
   */
  onRetry?: (message: RetriedMessage) => void;
};

/** What a press of 다시 시도 hands back: the failed message as it is in the thread. */
export type RetriedMessage = { id: string; text: string };

/** One shared empty array, so a screen without a queue does not hand down a new one per render. */
const EMPTY_QUEUE: readonly QueuedMessage[] = [];

/** Same reason as `EMPTY_QUEUE`: a conversation with no failed turns hands down one stable object. */
const EMPTY_FAILURES: Readonly<Record<string, StandingFailure>> = {};

/**
 * Split a person's message into the skill they invoked and the rest of what they typed.
 *
 * ONLY A KNOWN COMMAND COUNTS. "/etc/hosts is broken" is a sentence, not a skill, and drawing a chip
 * around it would invent a thing that never happened. The names come from the same list the `/` menu
 * was built from, so this stays true as skills are granted and revoked.
 *
 * The trigger only opens at the start of a line, so the chip is the first token or there is none.
 */
function splitSkillChip(
  text: string,
  commandNames: string,
): { chip: string; rest: string } | null {
  const match = LEADING_SKILL.exec(text);
  if (!match) {
    return null;
  }
  const known = commandNames.split(",").filter(Boolean);
  if (!known.includes(match[1])) {
    return null;
  }
  return { chip: match[1], rest: text.slice(match[0].length) };
}

/**
 * The Bot has the turn and has produced nothing yet.
 *
 * THE GAP THIS FILLS IS THE WORST ONE IN THE CONVERSATION. Between pressing send and the first token
 * there was `aria-busy` and nothing else: announced to a screen reader, invisible to everybody else.
 * A person who has just asked something watches their own message sit there, and a Bot that is
 * thinking is indistinguishable from a Bot that failed silently — which this app has shipped before.
 *
 * It borrows the shimmer a running tool line uses, so "working on it" reads the same whether the
 * work is a tool call or a model that has not spoken yet.
 */
function Thinking() {
  return (
    /*
     * Not a live region itself: one mounted together with its words is not announced. The
     * transcript says "Thinking" in its own always-mounted status line, politely — this is progress,
     * not something that interrupts what somebody is doing.
     */
    <p className="tool-line-running text-muted-foreground text-sm">
      {t("Thinking")}
    </p>
  );
}

/**
 * The turn ended and no answer came.
 *
 * In the same slot as `Thinking`, and for the same reason it is there: the person is looking at the
 * bottom of the transcript, immediately under their own message, because that is where the answer
 * was going to appear. Saying so above the composer put the explanation in a different part of the
 * screen from the gap it explains, and left the last thing in the conversation looking unfinished.
 *
 * NOT A MESSAGE, deliberately. It has no id, is never anchored, and is gone the moment the next turn
 * starts. Making it a transcript row would put a sentence into the conversation that nobody said,
 * and the conversation is sent back to the model on the next turn, so the Bot would then read its
 * own obituary as something it had written.
 */
function TurnFailed({
  code,
  group,
  onRetry,
}: {
  code: string;
  /**
   * The routine failure group this line stands for, when it stands for one.
   *
   * RED IS FOR WHAT IS STILL NEWS. A routine that failed the same way ten times used to be ten red
   * lines, and somebody shown red every hour learns to stop reading red — including the day it
   * matters. So the repeats have no line of their own (the server counts them into the group), the
   * one line says how many and when last, and it stops being red once the person has said 확인 or
   * a success has ended it. It stays, quiet, as the record of what happened.
   */
  group?: FailureGroup | undefined;
  onRetry?: (() => void) | undefined;
}) {
  // Remembered for the 문의·의견 box: "send what is on screen too" attaches this code, and this
  // line is the one place the screen says one.
  useEffect(() => noteTurnFailure(code), [code]);
  const queryClient = useQueryClient();
  /*
   * Quiet the moment it is pressed, not when the refetch lands: the press is the whole of what the
   * person did, and a red line that stays red for a round trip reads as a press that did nothing.
   * Put back if the server did not take it, so a line never claims an acknowledgement nobody holds.
   */
  const [pressed, setPressed] = useState(false);
  const quiet = Boolean(
    group && (group.acknowledged || group.closed || pressed),
  );
  // "Last 오전 9:00" becomes "어제" at midnight because the time is an input; see `useNow`.
  const now = useNow();
  const repeated = group ? repeatedFailureLine(group, now) : null;

  const handleAcknowledge = async () => {
    if (!group) return;
    setPressed(true);
    if (!(await acknowledgeFailureGroup(group.id))) {
      setPressed(false);
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: channelKeys.allFailures(),
    });
  };

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1"
      data-quiet={quiet ? "true" : undefined}
      data-testid="transcript-stopped"
      // A line that is no longer news is not an alert: a screen reader opening the conversation
      // should not be interrupted by last Tuesday's failure somebody already acknowledged.
      role={quiet ? "status" : "alert"}
    >
      <IconAlertTriangle
        aria-hidden="true"
        className={`size-4 shrink-0 ${quiet ? "text-muted-foreground" : "text-destructive"}`}
      />
      <span
        className={`text-sm ${quiet ? "text-muted-foreground" : "text-destructive"}`}
      >
        {turnFailureSentence(code)}
      </span>
      {repeated ? (
        <span className="text-muted-foreground text-xs">{repeated}</span>
      ) : null}
      {group && !quiet ? (
        <Button
          className="h-6 px-2 text-xs"
          onClick={() => void handleAcknowledge()}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("Acknowledge")}
        </Button>
      ) : null}
      {/*
       * THE PRESS THAT WAS MISSING. The old line said something had gone wrong and offered nothing
       * to do about it, so the only way to ask again was to retype the question — under a red
       * sentence in a language the reader does not speak.
       */}
      {onRetry ? (
        <Button
          className="h-6 px-2 text-xs"
          onClick={onRetry}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("Try again")}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * A message that never reached the server, kept on this device (`composer/outbox.ts`).
 *
 * MEASURED 2026-09-24 (UI/UX audit 0.5.3, item 6): sent with the server down, "오늘 마감 체크리스트
 * 써 줘" got a red line and a button, was not sent when the server came back, and was gone without
 * a trace after a reload. Now it stays where it was typed, saying it was not sent and what happens
 * next, with a way to send it now.
 *
 * Under the person's own bubble, on their side: this is about their message, not the Bot's answer.
 * A status, not an alert — it is a fact about the message that stays true until it is sent.
 */
function Unsent({
  autoTried,
  isOnline,
  isSending,
  onSend,
}: {
  /** Its one automatic try has been spent; the next send is the person's. */
  autoTried: boolean;
  isOnline: boolean;
  isSending: boolean;
  onSend?: (() => void) | undefined;
}) {
  const why = !isOnline
    ? t("Check your internet connection.")
    : autoTried
      ? null
      : t("It goes once by itself when the connection is back.");
  return (
    <div
      className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 py-1"
      data-testid="transcript-unsent"
      role="status"
    >
      <IconAlertTriangle
        aria-hidden="true"
        className="size-4 shrink-0 text-warning"
      />
      <span className="text-muted-foreground text-sm">
        {isSending
          ? t("Sending again…")
          : why
            ? `${t("Not sent")} · ${why}`
            : t("Not sent")}
      </span>
      {onSend && !isSending ? (
        <Button
          className="h-6 px-2 text-xs"
          onClick={onSend}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("Send again")}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Something the person said while the Bot was working, waiting its turn.
 *
 * IT IS DRAWN AS THEIR MESSAGE, NOT AS A NOTICE ABOUT ONE. The whole point of letting somebody type
 * mid-turn is that they can see their words landed, and a status line saying "1 message queued"
 * does not do that — they would still be wondering whether the sentence they typed is the sentence
 * that will run. So it is the same bubble, in the same column, with the same wrapping, and only two
 * things say it has not run yet: it is faded, and it says so underneath.
 *
 * The footer carries the taking-back too, because that is where the reader's eye already is once
 * they have decided this was a mistake, and because a control on the bubble itself would have to
 * hover over the words it is offering to delete.
 */
function Queued({
  text,
  onRemove,
}: {
  text: string;
  onRemove?: (() => void) | undefined;
}) {
  return (
    <MessageRow align="end">
      <MessageContent>
        <Bubble align="end" className="chat-prose opacity-60" variant="muted">
          <BubbleContent>
            {/* Shown exactly as typed, for the same reason a sent message is. */}
            <span className="whitespace-pre-wrap">{text}</span>
          </BubbleContent>
        </Bubble>
        <MessageFooter>
          {/*
           * `status` rather than `alert`, matching the thinking line: a person who has just chosen
           * to queue something is not being interrupted by the news that it is queued.
           */}
          <span role="status">{t("Queued")}</span>
          {onRemove ? (
            <button
              /*
               * The sentence it deletes, in the name. Three parked corrections put three buttons
               * called "Remove" in a row, and somebody reading by name alone is told what they can
               * do and nothing about which one it would happen to. The visible word stays short
               * because the bubble it sits under is the answer for everybody who can see it.
               */
              aria-label={t("Remove queued message: {text}", { text })}
              className={`ml-2 underline underline-offset-2 hover:text-foreground ${focusRing}`}
              onClick={onRemove}
              type="button"
            >
              {t("Remove")}
            </button>
          ) : null}
        </MessageFooter>
      </MessageContent>
    </MessageRow>
  );
}

/**
 * Put the newest queued message where the person who just typed it can see it.
 *
 * WITHOUT THIS THE AFFORDANCE IS INVISIBLE EXACTLY WHEN IT MATTERS. The scroller holds its anchor on
 * the turn being answered rather than following the bottom, so during a long streamed answer the
 * transcript sits a screen or so above the end — and a line appended below it lands off screen.
 * Measured at the point somebody would actually use this: eighty-odd pixels under the fold, with
 * the composer emptying at the same moment. They would have watched their correction vanish.
 *
 * Keyed on the newest queued id rather than on the list, so it does not fire again for every chunk
 * of the answer still streaming above it. It does fire when the bottom-most queued line is taken
 * back, which is a scroll nobody asked for and which lands on the end of the conversation anyway,
 * and it stays quiet on a drain, when the id goes to null.
 *
 * IT COSTS THE ANCHOR, AND THAT IS THE PRICE OF THE SCROLL RATHER THAN A SIDE EFFECT OF IT.
 * `scrollToEnd` drops whatever turn the scroller was holding its position against and starts
 * following the bottom instead, so the rest of that answer streams past under the reader rather
 * than staying put beneath the question. Somebody who has just typed at the bottom of the
 * conversation has asked to be at the bottom of the conversation, so following it is the reading
 * they chose; but they chose it for the whole turn and not only for the moment, and the button
 * back to the anchored view is the scroller's own, not ours to restore.
 *
 * Rendering nothing and living inside the provider is what buys access to the scroller at all; the
 * alternative is threading a ref out through three components with no other reason to know a
 * scroller exists.
 */
function ScrollNewestQueuedIntoView({ newest }: { newest: string | null }) {
  const { scrollToEnd } = useMessageScroller();

  useEffect(() => {
    if (newest === null) {
      return;
    }
    scrollToEnd();
  }, [newest, scrollToEnd]);

  return null;
}

/**
 * How many of the newest turns cascade when a channel is opened, and how far apart.
 *
 * The tail rather than the head: opening a channel lands you at the bottom, so these are the ones
 * actually on screen. Staggering from the top of a long history would spend the whole budget on
 * messages nobody can see and leave the visible ones arriving last.
 *
 * Twelve at 40ms is 440ms of cascade before the last one starts. Past roughly half a second this
 * stops reading as settling and starts reading as waiting.
 */
const FIRST_PAINT_STAGGER_COUNT = 12;
const FIRST_PAINT_STAGGER_SECONDS = 0.04;

/**
 * Decide, once per message, whether it waits its turn.
 *
 * FROZEN PER ID ON PURPOSE. `delay` is a prop on a memoised component, so a value that changed
 * between renders would break the memo that makes the streaming path cheap — and worse, a message
 * whose delay changed could replay its entrance mid-stream. Each id is decided the first time it is
 * seen and never revisited.
 *
 * `settled` flips after the first render that has any items, which is NOT the first render: history
 * is restored asynchronously, so a channel's transcript is empty for a beat. Anything appearing
 * after that is a live turn and is given no delay at all.
 */
function createFirstPaintDelays() {
  const decided = new Map<string, number>();
  let settled = false;

  return {
    settle() {
      settled = true;
    },
    delayFor(id: string, index: number, total: number): number {
      const known = decided.get(id);
      if (known !== undefined) {
        return known;
      }
      const offset = total - FIRST_PAINT_STAGGER_COUNT;
      const place = index - Math.max(0, offset);
      const delay =
        settled || place < 0 ? 0 : place * FIRST_PAINT_STAGGER_SECONDS;
      decided.set(id, delay);
      return delay;
    },
  };
}

/**
 * Decide, once per message, whether the scroller may anchor on it: only a person's own message,
 * sent while this transcript was open.
 *
 * THE JUMP THIS PREVENTS, measured 2026-09-24 on a 28-message conversation after a reload. The
 * scroller (`@shadcn/react/message-scroller`) scrolls to an anchor it has not handled whenever the
 * list's children change and their COUNT does not — its reading of that is "an optimistic message
 * was swapped for the real one". It marks an anchor handled only when the anchor arrives after the
 * first paint, so every user message in the restored history stayed unhandled. The first tool card
 * of the next turn replaces the "생각하는 중" line — one child out, one in, the count unchanged —
 * and the scroller took the OLDEST user message as the swapped one: `scrollTop` went from 2616 to 2
 * and the reader was thrown back to the start of the conversation. Any same-count swap did it: a
 * failure line clearing as a card arrived, a tool line becoming a browsing card.
 *
 * So the history is never an anchor. A message is one only if it is first seen after the transcript
 * settled (the same instant `createFirstPaintDelays` uses, for the same reason: history arrives
 * asynchronously) and as the newest item — which is what sending one looks like. Stored history
 * merged in later lands above what is already on screen, never as the newest, so it is not
 * mistaken for a send. What an anchor is FOR is untouched: the message somebody just sent is
 * scrolled to the top with the previous answer peeking above it.
 *
 * Frozen per id like the delays: `scrollAnchor` becomes a DOM attribute the scroller reads at every
 * change, and one that flipped on an old message would re-open exactly this hole.
 */
export function createAnchorDecider() {
  const decided = new Map<string, boolean>();
  let settled = false;

  return {
    settle() {
      settled = true;
    },
    isAnchor(id: string, isUserMessage: boolean, isNewest: boolean): boolean {
      const known = decided.get(id);
      if (known !== undefined) {
        return known;
      }
      const anchor = settled && isUserMessage && isNewest;
      decided.set(id, anchor);
      return anchor;
    },
  };
}

/**
 * A turn arriving in the transcript.
 *
 * WHY IT ANIMATES AT ALL: a message currently pops into existence at full opacity, and the eye has
 * nothing to follow from the composer to the transcript. This bridges that, and nothing more — it
 * is not decoration on something the reader is trying to read.
 *
 * IT RUNS ONCE, ON MOUNT. `initial`/`animate` fire when the element mounts, and the memoised parents
 * mean a streaming answer re-renders without remounting — so the fade plays when the message first
 * appears and never again while its text is still arriving. Animating per chunk would strobe.
 *
 * TRANSFORM AND OPACITY ONLY, so the scroller can still measure. `MessageScroller` sizes items and
 * places its anchor and spacer from layout; a transform is composited and changes no layout box, so
 * a message can fade in without moving the thing the scroller just measured.
 *
 * The full transform string rather than motion's `y` shorthand: the shorthand is not hardware
 * accelerated and drops frames exactly when the main thread is busy, which here is while a reply is
 * streaming.
 *
 * STAGGERED ONLY ON THE FIRST PAINT OF A CHANNEL. A turn sent mid-conversation arrives alone and
 * must not wait behind anything, so `delay` is zero for it. Opening a channel is the one moment the
 * whole history mounts at once, and cascading the last few reads as the conversation settling
 * rather than as a page appearing all at once. `createFirstPaintDelays` decides which is which.
 */
function Arriving({
  children,
  delay = 0,
}: {
  children: React.ReactNode;
  delay?: number;
}) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      /*
       * `data-slot` IS LOAD-BEARING, NOT DECORATION. `MessageContent` right-aligns a person's own
       * message with `group-data-[align=end]/message:*:data-slot:self-end` — a selector that reaches
       * DIRECT CHILDREN CARRYING A data-slot. Wrapping the bubble in a plain div made this the direct
       * child, the selector matched nothing, and every message a person sent quietly moved to the
       * left column and read as though the Bot had said it.
       */
      data-slot="message-arriving"
      /*
       * FULL WIDTH, AND A FLEX COLUMN, because that is what it displaced. `Bubble` is
       * `w-fit max-w-[80%]` and aligns itself with `group-data-[align=end]/message:self-end`. Both
       * need the parent this wrapper replaced: against a shrink-to-fit box the 80% resolves against
       * the bubble's own width and short messages wrap for no reason, and `self-end` does nothing at
       * all outside a flex container.
       */
      /*
       * `relative`, because the row of reply actions is lifted out of flow — see ReplyActions.
       *
       * AND RAISED WHILE THAT ROW IS UP. The transform this wrapper animates with makes it a
       * stacking context, so the row's own `z-10` counts only inside it, and the NEXT message's
       * wrapper — a stacking context too, later in the document — painted over it. Under a reply
       * with another bubble 4px below it the row sat behind that bubble: measured in a room, where
       * a failed 좋아요's line was cut in half by the next reply. Raising the wrapper while hovered,
       * focused or holding a line up puts the row back on top.
       */
      className="relative flex w-full flex-col group-hover/message:z-10 has-focus-visible:z-10 has-data-[lingering=true]:z-10"
      initial={{
        opacity: 0,
        // Reduced motion keeps the fade and drops the movement: gentler, not absent.
        transform: shouldReduceMotion ? "none" : "translateY(8px)",
      }}
      transition={{
        // Reduced motion gets the fade with no queue: a cascade is movement too, just spread over
        // time, and somebody who asked for less of it should not wait for their history to arrive.
        delay: shouldReduceMotion ? 0 : delay,
        duration: ENTRANCE_SECONDS,
        ease: EASE_OUT,
      }}
    >
      {children}
    </motion.div>
  );
}

/**
 * One drawn message, and it is memoised on PRIMITIVES ON PURPOSE.
 *
 * A streamed answer changes `messages` on every chunk, and `toVisibleChatItems` builds fresh objects
 * from it each time — so a memo comparing item objects would miss on every single one and buy
 * nothing. Passing role and text means an untouched message compares equal and is skipped.
 *
 * MEASURED, BEFORE AND AFTER. One reply into a 25-message thread cost 76 transcript renders and
 * 1,890 message renders, because every message in the history re-parsed its markdown on every
 * chunk. That is the jank: the scroll was following a list that rebuilt itself 76 times.
 *
 * It is also what keeps the entrance honest — no remount means no replay of the fade.
 */
const TranscriptMessage = memo(function TranscriptMessage({
  channelId,
  commandNames = "",
  delay,
  id,
  joinedNext = false,
  joinedPrev = false,
  partial = false,
  rateable = false,
  role,
  text,
}: {
  /** The conversation, for the rating controls. See ChatTranscriptProps. */
  channelId?: string | undefined;
  commandNames?: string;
  delay: number;
  /** The message's own id: what a rating of it is keyed by. */
  id: string;
  /**
   * The half of an answer a turn that failed got out: faded, and said to be only that. Without it
   * two words sat above the failure line looking like the whole reply — measured 2026-09-24,
   * "가게 마감" as a heading and nothing under it.
   */
  partial?: boolean;
  /** A finished answer, as opposed to one still being written. See `unsettledFrom`. */
  rateable?: boolean;
  /** The message below is from the same speaker, with no tool line between them. */
  joinedNext?: boolean;
  /** The message above is. */
  joinedPrev?: boolean;
  role: "user" | "assistant";
  text: string;
}) {
  const isUser = role === "user";
  const align = isUser ? "end" : "start";
  const invoked = isUser ? splitSkillChip(text, commandNames) : null;

  return (
    <MessageRow align={align}>
      <MessageContent>
        <Arriving delay={delay}>
          {/* The chat measure: what a Bot says and what a person typed read at one size. */}
          {/*
           * BOTH SIDES GET A BUBBLE.
           *
           * A Bot's reply used to be bare prose on the page while the person's message sat in a
           * grey box — which reads as one participant talking and the other narrating. Grok gives
           * the Bot the grey bubble and the person the near-black one, and that symmetry is what
           * makes the transcript read as a conversation between two parties.
           */}
          <Bubble
            align={align}
            className={partial ? "chat-prose opacity-60" : "chat-prose"}
            joinedNext={joinedNext}
            joinedPrev={joinedPrev}
            variant={isUser ? "user" : "agent"}
          >
            <BubbleContent>
              {isUser ? (
                // A person's own message is shown exactly as they typed it. Rendering it as markdown
                // would silently reformat what they said, and an asterisk in a sentence is not
                // emphasis. The chip is the one exception, and it is not reformatting: it is drawing
                // the thing that was already a chip in the composer as a chip here too, so the
                // transcript shows a skill was used rather than a slash that was typed.
                <span className="whitespace-pre-wrap">
                  {invoked ? (
                    <>
                      {/*
                       * The same icon the sidebar uses for Skills, so the badge says WHAT KIND of
                       * thing was invoked before it says which one. `inline-flex` with
                       * `align-middle` rather than a block: this sits mid-sentence, and a badge that
                       * breaks the line it is in reads as a separate message.
                       */}
                      <span className="mr-1 inline-flex items-center gap-1 rounded bg-foreground/10 px-1.5 py-0.5 align-middle font-mono text-foreground/80 text-xs">
                        <IconBox className="size-3 shrink-0" />/{invoked.chip}
                      </span>
                      {invoked.rest}
                    </>
                  ) : (
                    text
                  )}
                </span>
              ) : (
                /*
                 * A Bot's prose is markdown, and it arrives in pieces.
                 *
                 * Rendered with a streaming-aware renderer rather than an ordinary one: half a fenced
                 * code block or an unclosed bold marker is the NORMAL state for most of a run, and a
                 * plain markdown parser draws that as literal asterisks and backticks until the
                 * closing token arrives, so the answer visibly rewrites itself as it lands. This
                 * closes them for the duration.
                 */
                <Streamdown components={markdownComponents}>{text}</Streamdown>
              )}
            </BubbleContent>
          </Bubble>
          {partial ? (
            <p className="mt-1 text-muted-foreground text-xs">
              {t("Received up to here")}
            </p>
          ) : null}
          {/*
           * COPYING A REPLY WAS SELECT-AND-DRAG, OR NOTHING.
           *
           * A Bot's answer is the artefact — a summary, a list, an address it looked up — and the
           * only way to take it anywhere was to select it by hand across a markdown block. On the
           * assistant's side only: a person already has what they typed, and has nothing to rate.
           *
           * 좋아요·아쉬워요 sit beside it, on a finished answer in a conversation that can keep a
           * rating (`answer-rating.tsx`).
           */}
          {isUser ? null : (
            <ReplyActions>
              <CopyReply text={text} />
              {channelId && rateable ? (
                <AnswerRatingControls channelId={channelId} messageId={id} />
              ) : null}
            </ReplyActions>
          )}
        </Arriving>
      </MessageContent>
    </MessageRow>
  );
});

/**
 * The row of controls under a Bot's answer.
 *
 * OUT OF FLOW, BECAUSE A HIDDEN CONTROL WAS STILL TAKING 32px. The copy button sat under every
 * assistant bubble at `opacity: 0` — invisible, and still occupying its height plus margin in the
 * column. That is where the transcript's spacing actually went: two replies in a row read 48px apart
 * when the measured rhythm is 4px, and no amount of tuning the gap could fix it because the space
 * was a button nobody could see. Absolute, hugging the bubble's bottom edge, in the gutter the
 * bubble's max-width leaves — the whole row now, not the one button.
 *
 * Revealed on hover and on keyboard focus, so it is reachable by keyboard and does not sit over the
 * transcript the rest of the time — and held up while a control in it says it is in use
 * (`data-lingering`): a popover the person is typing into, or the line saying a rating arrived,
 * must not vanish because the pointer moved on to read the answer.
 */
function ReplyActions({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="-mt-1.5 absolute top-full left-0 z-10 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 has-focus-visible:opacity-100 has-data-[lingering=true]:opacity-100"
      data-slot="reply-actions"
    >
      {children}
    </div>
  );
}

/** Copy the reply. Silent when the clipboard is unavailable, which is not an error. */
function CopyReply({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const handleCopy = async () => {
    if (!(await copyText(text))) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Button
      aria-label={copied ? t("Copied") : t("Copy this reply")}
      className="text-muted-foreground"
      onClick={handleCopy}
      size="icon-sm"
      title={copied ? t("Copied") : t("Copy this reply")}
      type="button"
      variant="ghost"
    >
      {copied ? (
        <IconCheck className="size-3.5" />
      ) : (
        <IconCopy className="size-3.5" />
      )}
    </Button>
  );
}

/**
 * One drawn tool call, memoised on the same terms.
 *
 * The `toolCall` object is rebuilt here from its parts rather than passed down, because the one on
 * the message is a new object on every chunk and would defeat the memo exactly as the text items
 * did. A finished chart re-rendering on every token of the sentence after it is not free.
 *
 * `useRenderToolCall` is called HERE rather than passed in as a prop: a function whose identity the
 * parent cannot guarantee is the classic way to make a memo boundary useless.
 */
const TranscriptToolCall = memo(function TranscriptToolCall({
  delay,
  toolCallId,
  name,
  args,
  result,
}: {
  delay: number;
  toolCallId: string;
  name: string;
  args: string;
  result?: string;
}) {
  const renderToolCall = useRenderToolCall();
  const toolCall = useMemo(
    () => ({
      id: toolCallId,
      type: "function" as const,
      function: { name, arguments: args },
    }),
    [toolCallId, name, args],
  );

  const drawn = renderToolCall({
    toolCall,
    ...(result === undefined
      ? {}
      : {
          toolMessage: {
            id: `${toolCallId}-result`,
            role: "tool",
            toolCallId,
            content: result,
          },
        }),
  });

  return (
    <Arriving delay={delay}>
      <ToolRenderBoundary name={name}>
        {/*
         * A TOOL WITH NO REGISTERED RENDERER STILL HAPPENED. `renderToolCall` draws whatever was
         * registered for the name and nothing at all for anything else, which left a Bot that called
         * something the app does not know about looking like a Bot that did nothing — the same
         * failure `ToolRenderBoundary` exists to prevent, arriving by a different route.
         *
         * The fallback is a plain tool line: what was called, shimmering until its result lands. It
         * is the same line the computer and MCP tools draw, so an unrecognised call reads as an
         * ordinary event rather than as damage.
         */}
        {drawn ?? (
          <ToolLine
            kind={toolKindOf(name)}
            label={name}
            running={result === undefined}
          />
        )}
      </ToolRenderBoundary>
    </Arriving>
  );
});

/** Frozen and shared, so a transcript with no times does not rebuild its projection every render. */
const EMPTY_TIMES: Readonly<Record<string, string>> = Object.freeze({});

/**
 * The line that says "you had read up to here".
 *
 * Measured: 14px above, 8px below, 2px of its own padding, a 1px rule in the accent colour on each
 * side of an accent label. The accent is spent here on purpose — it is the one thing in a
 * transcript that is about the reader rather than about the conversation.
 */
function UnreadLine() {
  return (
    <div className="my-2 mt-3.5 flex w-full items-center gap-2 py-0.5">
      <span className="h-px flex-1 bg-[var(--sand-fill-accent)]" />
      <span className="shrink-0 text-[var(--sand-text-accent)] text-xs">
        {t("Unread")}
      </span>
      <span className="h-px flex-1 bg-[var(--sand-fill-accent)]" />
    </div>
  );
}

/**
 * "Today 1:45 PM", centred above the stretch of conversation it opens.
 *
 * Measured rather than styled to taste: 14px above, 8px below, 28px tall with 6px of its own
 * padding, 12/16 at the secondary colour. One line per sitting, not a clock on every bubble — a
 * timestamp beside every sentence is what makes a transcript read as a log instead of a chat.
 */
function TimeSeparator({ at }: { at: Date }) {
  // 오늘 becomes 어제 at midnight because the time is an input, not a read; see `useNow`.
  const now = useNow();
  return (
    <time
      className="mt-3.5 mb-2 flex h-7 w-auto items-center justify-center self-center whitespace-nowrap py-1.5 text-muted-foreground text-xs"
      dateTime={at.toISOString()}
    >
      {sittingLabel(at, now)}
    </time>
  );
}

/**
 * Is the neighbouring item another message from the same speaker?
 *
 * A tool line between two replies breaks the run on purpose: the Bot did something in between, and
 * drawing those two bubbles as one uninterrupted turn would hide that it had.
 */
function continues(
  neighbour: TranscriptItem | undefined,
  role: "user" | "assistant",
): boolean {
  return neighbour?.kind === "text" && neighbour.role === role;
}

export function ChatTranscript({
  busy = false,
  channelId,
  commandNames = "",
  messageTimes = EMPTY_TIMES,
  messages,
  readWindow,
  onRemoveQueued,
  onRetry,
  queued = EMPTY_QUEUE,
  stoppedCode,
  failures = EMPTY_FAILURES,
}: ChatTranscriptProps) {
  /*
   * MEMOISED ON `messages`, WHICH IS SAFE ONLY BECAUSE NOTHING HANDS THIS THE AGENT'S OWN ARRAY.
   *
   * A `useMemo` keyed on `messages` once silently broke the transcript: the agent hands back the
   * SAME array and mutates it, so the dependency never changed, the cached items were kept forever
   * and a reply never appeared. A Bot that answered looked like a Bot that had not.
   *
   * The React Compiler memoises this line exactly that way. It is correct because every caller
   * passes a new array whenever anything in it changed: `ChannelChat` copies the agent's on every
   * render, and is left uncompiled so that the copy is always taken, and a room's messages are
   * immutable state. A caller that passed a live CopilotKit array straight through would bring the
   * bug back.
   *
   * It was never the expensive part either. Rebuilding this list is a flatMap over messages; the
   * cost was markdown parsing and chart SVGs, and those are skipped by the memoised children below,
   * which is where the 25x came from.
   */
  const items = withBrowsingTasks(toVisibleChatItems(messages, messageTimes));

  /*
   * ONLY WHILE THERE IS NOTHING ELSE TO LOOK AT. Once a reply starts streaming, or a tool line
   * appears, the transcript is already saying the Bot is working — a second indicator under a
   * half-written answer would claim it had stopped and started again.
   *
   * So: the turn is in flight AND the last thing in the conversation is still the person's own
   * message. A tool call that is running shimmers on its own line and needs nothing from here.
   */
  /** Any tool call in this tab waiting on a person. Subscribed, so it clears the moment it does. */
  const awaitingAnswer = useSyncExternalStore(watchQuestions, anyQuestionOpen);
  /** What this device kept because the server never got it, and what went again by itself. */
  const unsentById = new Map(
    useUnsent(channelId).map((message) => [message.id, message]),
  );
  const resent = useResent();
  const isOnline = useIsOnline();

  const lastItem = items.at(-1);
  /**
   * The last thing the person actually typed, which is what "try again" means.
   *
   * Read off the transcript rather than remembered by the caller: a retry asks that message again,
   * and after a failure it is still the newest user message there is.
   */
  const lastAsked = [...items]
    .reverse()
    .find(
      (item): item is Extract<typeof item, { kind: "text" }> =>
        item.kind === "text" && item.role === "user",
    );
  /**
   * Whether 다시 시도 can be drawn under this question: it can be asked again in place, and nothing
   * is running that a second press would race. See `retriesInPlace`.
   */
  const retryable = (messageId: string) =>
    !busy && retryWay(messages, messageId) !== null;
  /** The person's own messages by id: what a failure under the Bot's half answer asks again. */
  const askedById = new Map(
    items.flatMap((item) =>
      item.kind === "text" && item.role === "user"
        ? [[item.id, item.text] as const]
        : [],
    ),
  );
  /** 다시 시도 for this question, or nothing to press when it cannot be asked again. */
  const retryFor = (askedId: string | undefined) => {
    if (!onRetry || askedId === undefined) return undefined;
    const text = askedById.get(askedId);
    if (text === undefined || !retryable(askedId)) return undefined;
    return () => onRetry({ id: askedId, text });
  };
  /**
   * The half answer a turn that just failed left, if it left one: the Bot's words after the last
   * question, above the failure line. Drawn faded, with "여기까지 받았어요", like a stored one.
   */
  const lastAskedAt = lastAsked ? items.indexOf(lastAsked) : -1;
  const liveHalfAnswerId =
    stoppedCode &&
    lastItem?.kind === "text" &&
    lastItem.role === "assistant" &&
    items.indexOf(lastItem) > lastAskedAt
      ? lastItem.id
      : null;
  const waitingOnFirstToken =
    busy && lastItem?.kind === "text" && lastItem.role === "user";
  /** From here on the turn is still being written, and nothing in it can be rated yet. */
  const settledBefore = unsettledFrom(items, busy);
  /** The task still being done, and the newest task — the one the live screen would show. */
  const openTaskId = openBrowsingTask(items, busy)?.id ?? null;
  const newestTaskId =
    items.findLast((item) => item.kind === "browse")?.id ?? null;

  /*
   * A REPLY THAT ARRIVED WAS NEVER ANNOUNCED.
   *
   * `aria-busy` said a turn had started and nothing said it had ended, so somebody using a screen
   * reader pressed send and then had to go looking for an answer that may or may not have arrived.
   *
   * The live region holds the finished reply, set on the busy true→false edge only. It cannot go on
   * the message list itself: that streams, and every chunk would re-announce the whole answer.
   * `hasStreamed` keeps a restored history from being read out on mount.
   */
  const [announcement, setAnnouncement] = useState("");
  const hasStreamed = useRef(false);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      hasStreamed.current = true;
      wasBusy.current = true;
      setAnnouncement("");
      return;
    }
    if (!wasBusy.current || !hasStreamed.current) return;
    wasBusy.current = false;
    const last = items.at(-1);
    if (last?.kind === "text" && last.role === "assistant") {
      setAnnouncement(t("Reply: {text}", { text: last.text.slice(0, 240) }));
    }
  }, [busy, items]);

  /*
   * One decider per mounted transcript, so opening a different channel starts the cascade over and
   * a message never inherits a delay from a conversation it was not in.
   *
   * State made once rather than a ref filled in on first render: the same one object for the life
   * of the transcript, without reading a ref while rendering, which the React Compiler refuses.
   */
  const [delays] = useState(createFirstPaintDelays);
  const [anchors] = useState(createAnchorDecider);

  /*
   * Settled AFTER the render that first had items, not on mount: history arrives asynchronously, so
   * on mount there is nothing to stagger yet and marking it settled then would mean the history
   * cascade never happens.
   */
  const hasItems = items.length > 0;
  useEffect(() => {
    if (hasItems) {
      delays.settle();
      anchors.settle();
    }
  }, [hasItems, delays, anchors]);

  /*
   * Which items open a new sitting, decided in one pass rather than per row.
   *
   * The comparison is against the last message that HAD a time, not the previous row — a tool call
   * carries none, and treating its absence as a gap would put a separator in the middle of a turn.
   * A conversation whose history predates stamping has no times at all and simply gets no
   * separators, which is the honest outcome: the app does not know when those were said.
   */
  const separators = new Map<string, Date>();
  let previousAt: Date | null = null;
  /*
   * WHERE THE READING STOPPED — the first message a Bot said after this person last looked.
   *
   * Only one, and only on a Bot's message: the line answers "what did I miss", and your own
   * messages are not something you can have missed. It is computed here rather than tracked,
   * because `readWindow` is frozen at the moment the room opened; a reply arriving now falls below a
   * line that does not move.
   */
  const readMark = readWindow
    ? new Date(readWindow.from).getTime()
    : Number.NaN;
  const readUntil = readWindow
    ? new Date(readWindow.until).getTime()
    : Number.NaN;
  let firstUnreadId: string | null = null;
  for (const item of items) {
    if (item.kind !== "text" || !item.at) continue;
    const at = new Date(item.at);
    if (Number.isNaN(at.getTime())) continue;
    if (startsNewSitting(at, previousAt)) separators.set(item.id, at);
    previousAt = at;
    if (
      firstUnreadId === null &&
      item.role === "assistant" &&
      !Number.isNaN(readMark) &&
      at.getTime() > readMark &&
      at.getTime() <= readUntil
    ) {
      firstUnreadId = item.id;
    }
  }

  const view = (
    <MessageScrollerProvider autoScroll scrollPreviousItemPeek={48}>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent
            aria-busy={busy}
            /*
             * NO GAP, AND NO CENTRED COLUMN.
             *
             * The scroller's own `gap-6` put 24px between every message, so a Bot's three-sentence
             * answer arrived as three remarks a beat apart instead of as one turn. Grok spaces the
             * transcript from the rows instead: 2px above and below each, and 12px on the row that
             * starts a new turn — 4px inside a run, 16px when the speaker changes. The bubble caps
             * its own measure, so the column does not need to.
             */
            className="mx-auto w-full max-w-none gap-0 px-4 py-4"
          >
            {/* The finished reply, once, for a reader who cannot see it arrive. */}
            <div aria-atomic="true" aria-live="polite" className="sr-only">
              {announcement}
            </div>
            {/*
             * WHAT THE TURN IS DOING, SAID. "생각하는 중" and "답을 기다리는 중" are drawn in the slot under
             * the last message and come and go with the turn, and a status line mounted together with
             * its words is not announced: somebody listening pressed send and heard nothing until the
             * reply. The words are said here as well, in a region that is always mounted. The drawn
             * lines are no longer live themselves, so nothing is said twice.
             */}
            <LiveRegion className="sr-only">
              {awaitingAnswer
                ? t("Waiting for your answer")
                : stoppedCode
                  ? null
                  : waitingOnFirstToken
                    ? t("Thinking")
                    : null}
            </LiveRegion>
            {/*
             * The memo boundary is INSIDE the scroller item, not around it. `MessageScrollerItem`
             * reads the scroller's context, so it re-renders whenever the scroll state moves and
             * memoising it would achieve nothing. Its child is what costs — markdown parsing and
             * chart SVGs — and that is what is skipped.
             */}
            {items.map((item, index) =>
              item.kind === "browse" ? (
                <MessageScrollerItem
                  className="py-0.5 pt-3"
                  key={item.id}
                  messageId={item.id}
                >
                  <Arriving
                    delay={delays.delayFor(item.id, index, items.length)}
                  >
                    <BrowsingCard
                      channelId={channelId}
                      isNewest={item.id === newestTaskId}
                      isOpen={item.id === openTaskId}
                      item={item}
                    />
                  </Arriving>
                </MessageScrollerItem>
              ) : item.kind === "tool" ? (
                <MessageScrollerItem
                  className="py-0.5 pt-3"
                  key={item.id}
                  messageId={item.id}
                >
                  <TranscriptToolCall
                    args={item.toolCall.function.arguments}
                    delay={delays.delayFor(item.id, index, items.length)}
                    name={item.toolCall.function.name}
                    result={item.result}
                    toolCallId={item.toolCall.id}
                  />
                </MessageScrollerItem>
              ) : (
                <Fragment key={item.id}>
                  {firstUnreadId === item.id ? <UnreadLine /> : null}
                  {separators.has(item.id) ? (
                    // Outside the scroller item on purpose: it is not a message, so it must not be
                    // measured, anchored or scrolled to as one.
                    <TimeSeparator at={separators.get(item.id) as Date} />
                  ) : null}
                  <MessageScrollerItem
                    className={
                      // A row that opens a sitting already has the separator's 8px above it.
                      continues(items[index - 1], item.role) &&
                      !separators.has(item.id)
                        ? "py-0.5"
                        : "py-0.5 pt-3"
                    }
                    messageId={item.id}
                    scrollAnchor={anchors.isAnchor(
                      item.id,
                      item.role === "user",
                      index === items.length - 1,
                    )}
                  >
                    <TranscriptMessage
                      channelId={channelId}
                      commandNames={commandNames}
                      delay={delays.delayFor(item.id, index, items.length)}
                      id={item.id}
                      partial={
                        item.role === "assistant" &&
                        (failures[item.id]?.askedId !== undefined ||
                          item.id === liveHalfAnswerId)
                      }
                      rateable={
                        item.role === "assistant" &&
                        index < settledBefore &&
                        failures[item.id]?.askedId === undefined
                      }
                      joinedNext={continues(items[index + 1], item.role)}
                      joinedPrev={continues(items[index - 1], item.role)}
                      role={item.role}
                      text={item.text}
                    />
                  </MessageScrollerItem>
                  {item.role === "user" && unsentById.has(item.id) ? (
                    <Unsent
                      autoTried={unsentById.get(item.id)?.autoTried === true}
                      isOnline={isOnline}
                      // Whatever turn is running carries it: every send takes what was kept.
                      isSending={busy}
                      onSend={
                        onRetry
                          ? () => onRetry({ id: item.id, text: item.text })
                          : undefined
                      }
                    />
                  ) : item.role === "user" && resent.has(item.id) ? (
                    <p
                      className="py-1 text-right text-muted-foreground text-xs"
                      role="status"
                    >
                      {t("Sent when the connection came back.")}
                    </p>
                  ) : null}
                  {
                    /*
                     * OUTSIDE THE SCROLLER ITEM, like the separators above it: a failure is not a
                     * message, must not be measured or anchored as one, and must never join the
                     * history that goes back to the model.
                     *
                     * Suppressed while the live line is up, so a turn that has just failed does not
                     * say so twice — the server's record and this tab's own view of the same failure.
                     */
                    failures[item.id] &&
                    !failures[item.id].askedAgain &&
                    !(stoppedCode && item.id === lastItem?.id) &&
                    /*
                     * And not while the question it is under is being asked again. The failure
                     * stays on the server's record until an answer lands after it
                     * (`standingFailures`), and "no answer came back" above a turn that is running
                     * says the retry already failed.
                     */
                    !(busy && item.id === lastAsked?.id) ? (
                      <TurnFailed
                        code={failures[item.id].code}
                        group={failures[item.id].group}
                        onRetry={retryFor(
                          /*
                           * The person's own words: the question itself, or the one the server
                           * says this half answer was answering. Never a routine's heading: the
                           * server names no question for a run nobody asked, and "try again"
                           * there would send that heading back as if the person had typed it.
                           * The routine runs again at its next slot; nothing here can hurry it.
                           */
                          item.role === "user"
                            ? item.id
                            : failures[item.id].askedId,
                        )}
                      />
                    ) : null
                  }
                </Fragment>
              ),
            )}
            {/*
             * Outside the item list, so neither of these is a message. Each has no id, is never
             * anchored, and is gone by the next turn — giving one a `MessageScrollerItem` would ask
             * the scroller to measure and anchor something that exists for a second and a half.
             *
             * One or the other, never both: a turn that ended has stopped being in flight, and a
             * shimmering "Thinking" under a line saying the Bot stopped would contradict it.
             */}
            {/*
             * A pending question outranks both. The card is a row in the list, so scrolling up past
             * it takes the only sign a Bot is blocked with it — and a Bot waiting on permission
             * looks exactly like a Bot that has stalled.
             */}
            {awaitingAnswer ? (
              // Said by the region at the top of the list, which was there before this line was.
              <p className="text-muted-foreground text-sm">
                {t("Waiting for your answer")}
              </p>
            ) : stoppedCode ? (
              <TurnFailed
                code={stoppedCode}
                onRetry={retryFor(lastAsked?.id)}
              />
            ) : waitingOnFirstToken ? (
              <Thinking />
            ) : null}
            {/*
             * Below the thinking line, and outside the item list for the same reason it is: these
             * are not yet turns. They have ids of their own, but they are this tab's ids and not the
             * thread's, so handing them to the scroller would ask it to anchor on something that is
             * about to be replaced by a message with a different id — and the replacement is the
             * one worth scrolling to.
             */}
            {queued.map((message) => (
              <Queued
                key={message.id}
                onRemove={
                  onRemoveQueued ? () => onRemoveQueued(message.id) : undefined
                }
                text={message.text}
              />
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
        <ScrollNewestQueuedIntoView newest={queued.at(-1)?.id ?? null} />
      </MessageScroller>
    </MessageScrollerProvider>
  );

  return view;
}
