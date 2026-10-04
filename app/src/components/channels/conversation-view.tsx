import type { Message } from "@ag-ui/core";
import { type ReactNode, useState } from "react";
import {
  ChatTranscript,
  type OlderPages,
  type RetriedMessage,
} from "@/components/channels/chat-transcript";
import {
  type CommandOption,
  Composer,
  type ComposerDraft,
  type ParkedMessage,
} from "@/components/channels/composer";
import { readingColumn } from "@/components/channels/reading-column";
import { UsageNotice } from "@/components/channels/usage-notice";
import { SectionBoundary } from "@/components/layout/section-boundary";
import type { StandingFailure } from "@/lib/channels/retry";
import { ensure } from "@/lib/ensure";

/** Frozen and shared, so "nothing waiting" is one identity rather than a new array per render. */
const NONE: readonly ParkedMessage[] = Object.freeze([]);

export function ConversationView({
  banner,
  channelId,
  messages,
  messageTimes,
  readWindow,
  busy = false,
  isResumed = false,
  waitingForBot = false,
  notice,
  commands,
  disabled = false,
  pending = false,
  stoppedCode,
  noticeCode,
  failures,
  onRetry,
  stoppable,
  parked,
  emptyState,
  onSubmit,
  onStop,
  placeholder,
  attach,
  older,
  head,
}: {
  /** Files as well as words; see `ComposerProps.attach`. Absent draws no paperclip. */
  attach?: { channelId: string; images: boolean } | undefined;
  /** What the empty composer says; see `ComposerProps.placeholder`. */
  placeholder?: string | undefined;
  /**
   * A slim line between the header and the transcript: what the Bot is doing in its browser right
   * now (`browsing-banner.tsx`). Above the scroller, so it stays put while the conversation scrolls.
   */
  banner?: ReactNode;
  /** The conversation, so a finished answer can be rated. Absent on the compose screen. */
  channelId?: string;
  messages: readonly Message[];
  /** Message id to ISO-8601, for the transcript's time separators. */
  messageTimes?: Readonly<Record<string, string>>;
  /** Where this person's reading stopped and resumed (ISO-8601), for the "unread" line. */
  readWindow?: { from: string; until: string };
  busy?: boolean;
  /** The conversation was already held when this screen mounted. See `ChatTranscriptProps`. */
  isResumed?: boolean;
  /** The turn is waiting for the Bot to finish something else. See `ChatTranscriptProps`. */
  waitingForBot?: boolean;
  /** Shown above the composer. An error, or why this conversation is read-only. */
  notice?: ReactNode;
  /**
   * The `/` menu for this Bot's granted skills, supplied by the route that owns grant loading.
   */
  commands?: readonly CommandOption[];
  disabled?: boolean;
  /**
   * A turn is in flight: the Bot has been asked something and has not come back yet.
   *
   * It has to mean the TURN, from the moment the person's words are handed over until the whole
   * of it has come back: the composer parks what is typed while this is true, and what is parked
   * goes when it falls (`parked`).
   */
  pending?: boolean;
  /**
   * Why the last turn ended without an answer, as a CODE. Drawn at the end of the transcript.
   *
   * A code rather than the sentence it used to be: the sentence was whatever threw, in English.
   * See `lib/channels/turn-failure.ts`.
   */
  stoppedCode?: string;
  /**
   * The last turn arrived but is not the whole answer (`TURN_NOTICES`), as the CUSTOM event's name.
   * Drawn quietly under the answer it is about, not in red: nothing failed, and what came is kept.
   */
  noticeCode?: string;
  /** Turns that failed earlier and are still on the server's record: message id to failure. */
  failures?: Readonly<Record<string, StandingFailure>>;
  /** Ask one of them again. The transcript hands back the message that got no answer. */
  onRetry?: (message: RetriedMessage) => void;
  /**
   * There is a run for Stop to abort, which is a narrower fact than `pending` and is the honest one
   * to draw a Stop button from. Defaults to `pending` for a caller with no gap between the two.
   */
  stoppable?: boolean;
  /**
   * Let somebody type at a Bot that is already working: the caller keeps what is parked, and sends
   * it itself when the turn is over.
   *
   * Asked for rather than assumed, because it is only true of a conversation that will still be
   * here when the turn ends. The compose screen creates the channel on send and navigates away; a
   * message parked there would go down with the unmount, and a message that silently disappears is
   * a worse answer than a send button that will not go.
   *
   * Kept by the caller (`ServerChannelChat`, in the outbox) and not in this mount: the turn is the
   * server's and a reload does not end it, so a correction parked in React state here was lost by
   * one, with nothing saying so (review, 2026-10-02). The composer hands what is typed mid-turn to
   * `onPark`, and the transcript draws `messages`.
   */
  parked?: {
    messages: readonly ParkedMessage[];
    onPark: (draft: ComposerDraft) => void;
    onRemove: (id: string) => void;
    /** What is typed now answers the question the turn is stopped on. See `ComposerProps`. */
    isAnswering?: boolean;
  };
  /**
   * What fills the middle before anything has been said.
   *
   * The compose screen introduces the coworker here — face, name, standing role — because a blank
   * scroller above a composer is a form, and meeting a coworker should not feel like a form.
   */
  emptyState?: ReactNode;
  onSubmit: (draft: ComposerDraft) => void | Promise<void>;
  /** Stop the Bot mid-answer; forwarded to turn the send button into a stop button. */
  onStop?: () => void;
  /** The conversation above what is held, a page at a time. See `ChatTranscriptProps.older`. */
  older?: OlderPages;
  /** Above the first message: the Bot's greeting. See `ChatTranscriptProps.head`. */
  head?: ReactNode;
}) {
  /** What is drawn as waiting for the Bot: the caller's list, where it keeps one. */
  const waiting: readonly ParkedMessage[] = parked ? parked.messages : NONE;

  /**
   * A turn this screen started and has not seen finish.
   *
   * It is a backstop under `pending` rather than the thing that makes `pending` usable. A caller
   * that reports the turn honestly already covers the gap between `onSubmit` being called and the
   * turn showing up in its own state; one that does not leaves a gap in which a person typing
   * quickly would have their second message read as the start of a second turn.
   *
   * It cannot be the whole answer. This only knows about turns that came in through the composer.
   * A conversation starts turns by other routes — the first message of a new channel, a button
   * inside a rendered component — and for those the only thing that keeps a correction parked is
   * what the caller passes as `pending`.
   *
   * The composer tracks the same await for its own send button. Two trackers of one promise, which
   * is duplication, and they cannot drift: they rise in the same tick and fall on the same resolve.
   */
  const [running, setRunning] = useState(false);
  const inFlight = pending || running;

  const submit = async (draft: ComposerDraft) => {
    setRunning(true);
    // `try`…`finally`, through `ensure`: the React Compiler cannot compile the statement itself.
    await ensure(
      () => onSubmit(draft),
      () => setRunning(false),
    );
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {banner}
      <div className="relative flex flex-1 min-h-0">
        {emptyState && messages.length === 0 && waiting.length === 0 ? (
          /*
           * `z-10`, because the transcript is a later sibling and was painting over this. The
           * overlay itself stays click-through so it never sits between somebody and the composer;
           * an empty state with a control in it opts back in on its own element.
           */
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            {emptyState}
          </div>
        ) : null}
        {/*
         * The command NAMES, joined, rather than the option objects.
         *
         * The transcript needs them only to tell a real skill chip from a message that happens to
         * begin with a slash, and its message rows are memoised on primitives — handing them an
         * array would give every message a new prop identity on each refetch and re-render the whole
         * conversation to change nothing.
         */}
        {/*
         * THE TRANSCRIPT FAILS ALONE. It draws what a model wrote, while it is still being written,
         * through a markdown renderer and a card per tool — the likeliest thing on this screen to
         * throw — and the composer below it holds what somebody is in the middle of typing, and the
         * messages they parked. Both live out here, so a transcript that failed takes neither.
         */}
        <SectionBoundary className="flex-1" section="transcript">
          <ChatTranscript
            busy={busy}
            isResumed={isResumed}
            waitingForBot={waitingForBot}
            {...(channelId ? { channelId } : {})}
            commandNames={(commands ?? [])
              .map((command) => command.name)
              .join(",")}
            messages={messages}
            {...(messageTimes ? { messageTimes } : {})}
            {...(readWindow ? { readWindow } : {})}
            {...(parked ? { onRemoveQueued: parked.onRemove } : {})}
            // The same gate the composer's Stop is drawn from, for the same reason (below).
            onStopForQueued={(stoppable ?? pending) ? onStop : undefined}
            queued={waiting}
            {...(stoppedCode ? { stoppedCode } : {})}
            {...(noticeCode ? { noticeCode } : {})}
            {...(failures ? { failures } : {})}
            {...(onRetry ? { onRetry } : {})}
            {...(older ? { older } : {})}
            {...(head ? { head } : {})}
          />
        </SectionBoundary>
      </div>
      {/*
       * IN THE TRANSCRIPT'S COLUMN, edge for edge (`reading-column.ts`).
       *
       * It has been both ways. Both were a centred 588px column until 2026-08-21; then the
       * transcript ran the width of the pane with each bubble capping its own measure, and this
       * followed it, because the box a person types into has to sit under the width it types
       * into. That is still the rule. What changed is the width above: the Bot's answer is words
       * on the page now (the owner's "proposal A", 2026-10-04), the column is their measure, and
       * a composer running the width of the pane under a 720px column of text would be the
       * mismatch the rule is about.
       *
       * The notices sit in it too: they are about what is typed next.
       */}
      <div
        className={`${readingColumn} shrink-0 pb-4`}
        data-slot="composer-column"
      >
        {/* Every conversation screen, not one caller's: the next question is typed here on all of them. */}
        <UsageNotice />
        {notice}
        <Composer
          {...(commands ? { commands } : {})}
          className="w-full mt-auto"
          compact
          disabled={disabled}
          onQueue={parked?.onPark}
          onStop={onStop}
          attach={attach}
          isAnswering={parked?.isAnswering === true}
          onSubmit={submit}
          placeholder={placeholder}
          // With this screen's own send that has not resolved yet (`running`, above).
          pending={inFlight}
          /*
           * The caller's answer, not `inFlight`. `running` is true from the instant `start` is
           * entered, which is before `onSubmit` has done anything at all, so a Stop drawn from
           * `inFlight` appears while there is still nothing to stop — the press is swallowed and the
           * message goes anyway.
           */
          stoppable={stoppable ?? pending}
        />
      </div>
    </div>
  );
}
