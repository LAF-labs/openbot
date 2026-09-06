import { IconArrowUp, IconPlayerStopFilled } from "@tabler/icons-react";
import { PromptArea, type PromptAreaHandle } from "prompt-area";
import type { Segment } from "prompt-area/helpers";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Button } from "../../ui/button";
import {
  applyCommandChips,
  type CommandOption,
  type ComposerDraft,
  enforceSingleAgent,
  toDraft,
} from "./draft";
import { PLACEHOLDER_COMMANDS } from "./sources";
import { type AgentOption, buildTriggers } from "./triggers";

const MAX_HEIGHT_PX = 220;
/**
 * Tracks the compact line box so PromptArea stays vertically centered in one row.
 *
 * The composer types at the chat measure (--chat-font-size, 16px/1.65), so one line is 26px, not
 * the 19px the old `text-sm` box gave. A min-height under the real line box lets the first line sit
 * high in the row instead of centred in it.
 */
const COMPACT_MIN_HEIGHT_PX = 26;
const COMPACT_MAX_HEIGHT_PX = 104;

/**
 * One identity for "nobody to mention". `agents = []` in the parameter list is a NEW array on
 * every render, which is how a caller that passed nothing at all still handed the editor a fresh
 * trigger list each time the screen redrew — see `sources` below.
 */
const EMPTY_AGENTS: readonly AgentOption[] = [];

export type ComposerProps = {
  className?: string;
  compact?: boolean;
  /** Agents that `@` can address. Empty means the mention menu reports an empty channel. */
  agents?: readonly AgentOption[];
  commands?: readonly CommandOption[];
  /**
   * Receives the whole draft rather than a string, so a mention or a command reaches the caller as
   * structured data instead of something it would have to re-parse out of the text.
   */
  onSubmit?: (draft: ComposerDraft) => void | Promise<void>;
  /**
   * Park this message until the turn in flight is over, instead of refusing the keystroke.
   *
   * Its presence is what lets a person type at a Bot that is already working. Without it the
   * composer goes on refusing mid-turn sends, which is still the right answer for a screen that has
   * nowhere to put a parked message — the compose screen creates the channel on send and then
   * navigates away, so anything parked there would be dropped on unmount, and a message that
   * silently disappears is worse than a send button that visibly will not go.
   *
   * Called instead of `onSubmit`, not as well as it, and it does not return a promise: parking is
   * a state change, and awaiting one would hold the composer's send lock for the length of somebody
   * else's turn and block the next correction.
   */
  onQueue?: (draft: ComposerDraft) => void;
  /** Stop the Bot mid-answer; while pending, the send button becomes a stop button. */
  onStop?: () => void;
  /**
   * The conversation cannot take another message at all, which is a property of the conversation
   * rather than of the moment: a channel whose coworker was deleted. This is the only thing that
   * stops a person typing.
   */
  disabled?: boolean;
  /**
   * A turn is in flight. It gates sending, not writing: a channel is `pending` while it is still
   * connecting and restoring its history, and the composer is on screen throughout.
   */
  pending?: boolean;
  /**
   * There is a run on the wire for Stop to reach.
   *
   * Not the same question as `pending`, and telling them apart is the whole reason this exists. A
   * turn is in flight from the moment somebody presses send; the run it becomes does not exist
   * until the caller has waited for whatever it has to wait for, which on a channel that is still
   * joining is up to a second and a half. A Stop button drawn in that window aborts a controller
   * nobody has made yet: the press is swallowed, the message goes anyway, and the one control the
   * whole affordance leans on has quietly lied.
   *
   * Defaults to `pending`, which is the right answer for a caller with no gap between the two.
   */
  stoppable?: boolean;
};

export function Composer({
  className,
  compact = false,
  agents = EMPTY_AGENTS,
  commands = PLACEHOLDER_COMMANDS,
  onSubmit,
  onQueue,
  onStop,
  disabled = false,
  pending = false,
  stoppable,
}: ComposerProps) {
  const [value, setValue] = useState<Segment[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitInFlight = useRef(false);
  const promptAreaRef = useRef<PromptAreaHandle>(null);
  /** A send has completed and the caret is owed back, as soon as the editor will take it. */
  const wantsFocus = useRef(false);

  const isBusy = pending || isSubmitting;

  /*
   * THE EDITOR IS HANDED ONE TRIGGER LIST AND ONE `onChange` FOR ITS WHOLE LIFE.
   *
   * Measured 2026-09-06: a character typed within half a second of a conversation opening ended
   * up at the END of everything typed after it — "안녕하세요" came out "녕하세요안", one try in
   * three, never on a settled screen. The roster and the granted skills arrive a moment after the
   * composer mounts, and each render that carried them rebuilt `triggers` and `handleChange`. The
   * editor keys the effect that syncs its DOM from `value` on both, so every such render re-ran
   * it — against the `value` that render had closed over. A keystroke landing between the commit
   * and that effect had already moved the editor's own record on, so the stale value was judged
   * foreign and rendered over the box: the character vanished, came back on the next render, and
   * the caret came back at the start. Everything after was typed in front of it.
   *
   * So the lists are read through a ref at the moment a menu asks, and neither the trigger list
   * nor the change handler ever changes identity. The effect then re-runs only when `value` does,
   * and a render caused by `value` is never behind the editor's record of it.
   */
  const sources = useRef({ agents, commands });
  sources.current = { agents, commands };
  const triggers = useMemo(
    () =>
      buildTriggers({
        agents: () => sources.current.agents,
        commands: () => sources.current.commands,
      }),
    [],
  );
  const draft = useMemo(() => toDraft(value), [value]);

  const handleChange = useCallback((next: Segment[]) => {
    const { segments, actions } = applyCommandChips(
      enforceSingleAgent(next),
      sources.current.commands,
    );
    setValue(segments);
    // Run after the commit so an action that navigates or opens a panel is not fighting the
    // editor's own state update for the same tick.
    for (const action of actions) {
      action();
    }
  }, []);

  /**
   * The single submit path for Enter, the send button, and the form.
   *
   * `submitInFlight` is a ref rather than `isSubmitting` because a second Enter can land before
   * React has re-rendered with the new state, which would send the message twice.
   */
  const submitDraft = useCallback(
    async (segments: Segment[]) => {
      const submitted = toDraft(segments);
      if (submitted.isEmpty || disabled) {
        return;
      }

      /*
       * A TURN IS IN FLIGHT, AND THIS IS THE FORK THE WHOLE AFFORDANCE HANGS ON.
       *
       * With somewhere to park it the message goes there and the box empties, so the person sees
       * their words land. Without, we are back to refusing, which is what every caller that does
       * not queue still gets.
       *
       * It returns before `submitInFlight` and `isSubmitting` are touched on purpose. Those guard
       * one send from starting twice; a send here is held open for the length of the whole run, so
       * borrowing them for a parked message would let the first turn lock out every correction
       * typed while it worked — the exact thing this exists to allow.
       */
      if (isBusy) {
        if (!onQueue) {
          return;
        }
        setValue([]);
        onQueue(submitted);
        return;
      }

      if (submitInFlight.current || !onSubmit) {
        return;
      }

      submitInFlight.current = true;
      setIsSubmitting(true);
      // Clear optimistically; restore if the send fails before becoming a message.
      setValue([]);
      try {
        await onSubmit(submitted);
      } catch (error) {
        setValue(segments);
        throw error;
      } finally {
        submitInFlight.current = false;
        setIsSubmitting(false);
        // Asked for here, performed in the effect below, which runs after the commit that clears
        // `isSubmitting` and so after the render the caret would otherwise be placed against.
        wantsFocus.current = true;
      }
    },
    [disabled, isBusy, onQueue, onSubmit],
  );

  /**
   * Put the caret back the moment the composer can accept it again.
   *
   * Keyed off the editor becoming interactive rather than off the send resolving, so it survives
   * whatever the parent does with `pending` in between — and it runs after the commit, which is the
   * only point at which the element is enabled and focusable.
   */
  useEffect(() => {
    if (!wantsFocus.current || disabled || isBusy) {
      return;
    }
    wantsFocus.current = false;
    promptAreaRef.current?.focus();
  }, [disabled, isBusy]);

  /**
   * THE CARET IS THE COMPOSER'S FROM THE MOMENT THE SCREEN OPENS.
   *
   * Nothing focused the editor when a conversation opened; the effect above only gives the caret
   * BACK after a send. So the first thing typed into a freshly opened conversation went to the
   * body, and the conversation started with a click on the one control the whole screen exists
   * for. Half of what was measured on 2026-09-06 as "the first character moves to the end" was
   * simply this: the characters typed before the click were never in the box.
   *
   * A PASSIVE effect, and not the layout effect it looks like it should be. The editor initialises
   * in a passive effect of its own — the one that syncs its DOM from `value` — and until that has
   * run, a keystroke is compared against the empty value the mount closed over and rendered over
   * (the same wipe `sources` above describes, measured here with the focus in a layout effect:
   * "안녕하세요" came out "녕하세요안" again). Passive effects run child-first, so this one lands
   * in the same flush as the editor's, immediately after it, and never before it. A keystroke in
   * the few milliseconds between the first paint and that flush still goes to the body — as it
   * always did — which is the honest half of the trade: lost is better than moved.
   *
   * Keyed on `disabled` so the compose screen hands the caret over the moment a Bot is picked —
   * the box is enabled by that press and the person's next move is to type — and stays off it
   * while there is nobody to write to.
   */
  useEffect(() => {
    if (disabled) {
      return;
    }
    promptAreaRef.current?.focus();
  }, [disabled]);

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitDraft(value);
  };

  /**
   * There is a turn in flight and somewhere to park what is being typed.
   *
   * Not the same question as "is anything typed" — an empty composer mid-turn can queue nothing,
   * and the button it wants is Stop.
   */
  const canQueue = Boolean(onQueue) && isBusy && !disabled;
  /** Something is typed, mid-turn, with a queue to put it in. */
  const parking = canQueue && !draft.isEmpty;
  const canSend = !disabled && !draft.isEmpty && (!isBusy || canQueue);
  /**
   * Stop is available only once there is a run for it to reach, and it gives way to Send the moment
   * there is something typed to park.
   *
   * `stoppable` rather than `pending`, because a turn is in flight before its run is, and a button
   * that cannot do the thing it names is worse than no button at all.
   *
   * One button, so one of the two has to yield. Send wins because the correction is the thing that
   * cannot wait: park it and the box empties, which brings Stop straight back — so stopping is
   * never more than one press away, and the press before it is the one that saves the sentence.
   * Showing both would be honest and would also put two round buttons in a row on a compact
   * composer that has room for one.
   */
  const canStop = Boolean(onStop) && (stoppable ?? pending) && !parking;
  /**
   * The same arrow either way, because it is the same gesture, but a screen reader is told which of
   * the two it is about to do. "Send" on a button that will not send for another minute is a small
   * lie told to exactly the people who cannot see the queue it lands in.
   */
  const sendLabel = parking ? t("Queue message") : t("Send message");

  if (compact) {
    return (
      <form
        aria-busy={isBusy}
        className={cn(
          /*
           * `py-3` IS LOAD-BEARING ONCE THE TEXT WRAPS. On one line `min-h-14` and `items-center`
           * fake the vertical padding, so it read as correct for as long as nobody typed a
           * paragraph. Past that the row grows to fit its content exactly and the glyphs sit
           * against the border.
           *
           * It goes on the form rather than on the editor because the editor scrolls internally at
           * COMPACT_MAX_HEIGHT_PX: padding inside that box would scroll away with the text, so the
           * first visible line would still touch the top edge on a long message.
           */
          /*
           * THE MEASURED COMPOSER: an elevated pill on a hairline, lifted by a shadow so faint it
           * reads as a raised surface rather than as a card.
           *
           * A 3px focus ring used to bloom around it. Grok focuses by darkening the hairline to
           * `border/focus` and nothing else — on a control that is already the brightest thing on
           * the screen, a ring is noise, and it was the one place the app shouted.
           *
           * `pl-4` replaces the inset the removed `+` button used to provide.
           */
          "flex min-h-12 items-center gap-3 rounded-[24px] border-[0.5px] border-border bg-[var(--sand-fill-elevated)] py-2 pr-2 pl-4 shadow-[var(--sand-shadow-composer)] transition-colors focus-within:border-[var(--sand-border-focus)]",
          className,
        )}
        onSubmit={handleFormSubmit}
      >
        {/*
         * THE `+` IS GONE. It was permanently disabled and drawn at full strength
         * (`disabled:opacity-100`), so it read as a working control that ignored every click, and it
         * announced itself as "More message options unavailable" to anybody using a screen reader.
         * A control that can never do anything is not a promise worth keeping on screen.
         */}
        <PromptArea
          aria-label={t("Message")}
          className="chat-prose min-w-0 flex-1 border-0 bg-transparent p-0 shadow-none"
          disabled={disabled}
          maxHeight={COMPACT_MAX_HEIGHT_PX}
          minHeight={COMPACT_MIN_HEIGHT_PX}
          onChange={handleChange}
          onSubmit={submitDraft}
          placeholder={t("Ask anything")}
          ref={promptAreaRef}
          triggers={triggers}
          value={value}
        />
        {canStop ? (
          <Button
            aria-label={t("Stop the Bot")}
            className="size-8 rounded-full p-0"
            data-testid="composer-stop"
            onClick={onStop}
            size="icon"
            title={t("Stop the Bot")}
            type="button"
          >
            <IconPlayerStopFilled className="size-3" />
          </Button>
        ) : (
          <Button
            aria-label={sendLabel}
            className="size-8 rounded-full p-0"
            disabled={!canSend}
            size="icon"
            title={sendLabel}
            type="submit"
          >
            <IconArrowUp className="size-3.5" />
          </Button>
        )}
      </form>
    );
  }

  return (
    <div className={cn("w-xl", className)}>
      <form
        aria-busy={isBusy}
        // The same surface as the in-conversation composer, squared off because it grows a toolbar.
        className="overflow-hidden rounded-2xl border-[0.5px] border-border bg-[var(--sand-fill-elevated)] shadow-[var(--sand-shadow-composer)] transition-colors focus-within:border-[var(--sand-border-focus)]"
        onSubmit={handleFormSubmit}
      >
        {/*
         * A dead `<input type="file">` used to sit here: unnamed, in the tab order of the landing
         * screen, opening a file picker whose result went to `() => {}`. Attachments are not a
         * feature yet, and a control that discards what you give it is worse than none.
         */}
        <div className="grow px-3 pt-3 pb-2">
          <PromptArea
            aria-label={t("Message")}
            autoGrow
            className="chat-prose w-full border-0 bg-transparent p-0 shadow-none"
            disabled={disabled}
            maxHeight={MAX_HEIGHT_PX}
            onChange={handleChange}
            onSubmit={submitDraft}
            placeholder={t("Ask anything")}
            ref={promptAreaRef}
            triggers={triggers}
            value={value}
          />
        </div>

        <div className="mb-2 flex items-center justify-between px-2">
          <div />

          <div>
            {/*
             * size-8, the same button as the compact composer's. It was size-7 here, so the send
             * button was a pixel-and-a-bit smaller on Home than in a channel — two sizes for one
             * control, on the two screens a person switches between constantly.
             */}
            {canStop ? (
              <Button
                aria-label={t("Stop the Bot")}
                className="size-8 rounded-full p-0"
                data-testid="composer-stop"
                onClick={onStop}
                title={t("Stop the Bot")}
                type="button"
              >
                <IconPlayerStopFilled className="size-3" />
              </Button>
            ) : (
              <Button
                aria-label={sendLabel}
                className="size-8 rounded-full p-0 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canSend}
                title={sendLabel}
                type="submit"
              >
                <IconArrowUp className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
