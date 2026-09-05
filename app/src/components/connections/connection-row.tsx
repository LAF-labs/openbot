import { IconLoader2 } from "@tabler/icons-react";
import type * as React from "react";
import { useCallback, useId, useState } from "react";
import { ConnectionMark } from "@/components/connections/connection-mark";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { t } from "@/lib/i18n";

/**
 * ONE ROW, ONE SWITCH, THREE COMPLETELY DIFFERENT MACHINES BEHIND IT.
 *
 * A Google account is a consent screen at Google. 알림톡 is a form and a code to somebody's phone.
 * 배민 is the Bot's own browser opened at a login page with the wheel handed over. The screen used
 * to show those as three kinds of card with three kinds of button, stacked twenty-four deep under
 * one heading, and the person's question in front of all of them is the same one: is this on?
 *
 * So the row is the answer to that question and nothing else — a name, one line of what the Bot can
 * do with it, where it got to, and a switch. What the switch STARTS is the caller's business; what
 * it LOOKS like is decided here, once, so a Google row and a 배민 row cannot drift into two
 * different-looking things.
 *
 * TURNING ONE OFF ASKS, AND ASKS HERE. Every off is somebody's account leaving; a stray tap on a
 * touchpad must not be able to do it silently. It is inline rather than a modal because the row it
 * is about has to stay visible — a dialog saying "연결을 끊을까요?" over a list of twenty-four rows
 * is a question about which one.
 */

/** How the status line reads, so the three tones are decided once rather than per caller. */
export type RowTone = "muted" | "good" | "warn";

const TONES: Record<RowTone, string> = {
  muted: "text-muted-foreground",
  good: "text-primary",
  warn: "text-destructive",
};

export const ConnectionRow = ({
  name,
  mark,
  can,
  status,
  tone = "muted",
  isOn,
  isBusy = false,
  confirmText,
  onToggle,
  note = null,
  children,
}: {
  /** The Korean name. Already through `t()`; this component never translates. */
  name: string;
  /** Which brand mark to draw. See `connection-mark.tsx`; absent draws the generic one. */
  mark?: string;
  /** One line of what the Bot can do once this is on. */
  can: string;
  /**
   * Where it got to, in a sentence — or nothing.
   *
   * NOTHING IS A REAL ANSWER, and it is the common one. Every one of the fifteen site rows carried
   * the words 연결 안 됨 immediately beside a switch that was off, so the screen said "off" twice on
   * every row and the two connected rows had to compete with fourteen copies of a sentence that was
   * only restating the control. A row that has not been turned on yet says nothing; the switch is
   * the state. Status text is for what the switch CANNOT say — connected and to whom, needs signing
   * in again, waiting on another window, or a handoff that has to be repeated every time.
   */
  status?: React.ReactNode;
  tone?: RowTone;
  /** Where the switch sits. Not the same as connected: a pending consent sits on. */
  isOn: boolean;
  /** The switch is disabled and a spinner sits beside it. */
  isBusy?: boolean;
  /**
   * What the confirmation asks before an off goes through. Absent means the off needs no asking,
   * which is only right for a row that is not yet connected to anything.
   */
  confirmText?: string;
  onToggle: (next: boolean) => void;
  /** What just went wrong with this row. Cleared by the caller on the next attempt. */
  note?: string | null;
  /** The inline form or extra actions this row opens under itself. */
  children?: React.ReactNode;
}) => {
  const [isAsking, setAsking] = useState(false);
  const labelId = useId();

  const handleChange = useCallback(
    (next: boolean) => {
      if (!next && confirmText) {
        setAsking(true);
        return;
      }
      setAsking(false);
      onToggle(next);
    },
    [confirmText, onToggle],
  );

  return (
    <Item size="sm">
      {/*
       * `self-start`, which is the whole of the alignment bug. `ItemMedia` top-aligns itself only
       * when the item contains an `ItemDescription`, and this row's two lines under the title are
       * plain paragraphs — so the tile was centred against the whole three-line block and floated
       * level with the second line, a full line below the name it belongs to.
       */}
      <ItemMedia className="size-8 shrink-0 self-start">
        <ConnectionMark mark={mark} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle id={labelId}>{name}</ItemTitle>
        <p className="text-muted-foreground text-xs leading-relaxed">{can}</p>
        {status ? <p className={`text-xs ${TONES[tone]}`}>{status}</p> : null}

        {isAsking ? (
          <div className="mt-2 rounded-lg border border-border p-3">
            <p className="text-sm leading-relaxed">{confirmText}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  setAsking(false);
                  onToggle(false);
                }}
                size="sm"
                type="button"
                variant="destructive"
              >
                {t("Disconnect")}
              </Button>
              <Button
                onClick={() => setAsking(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("Cancel")}
              </Button>
            </div>
          </div>
        ) : null}

        {children}

        {note ? (
          <p className="mt-2 text-destructive text-xs" role="alert">
            {note}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions className="self-start">
        {isBusy ? (
          <IconLoader2
            aria-hidden="true"
            className="size-4 animate-spin text-muted-foreground"
          />
        ) : null}
        <Switch
          aria-labelledby={labelId}
          checked={isOn}
          disabled={isBusy}
          onCheckedChange={handleChange}
        />
      </ItemActions>
    </Item>
  );
};

/** What a row looks like before the answer is in. Never a state, and never a sentence. */
export const ConnectionRowSkeleton = () => (
  <Item size="sm">
    <ItemMedia className="size-8 shrink-0 animate-pulse self-start rounded-lg bg-muted" />
    <ItemContent className="gap-2">
      <div className="h-3.5 w-28 animate-pulse rounded bg-muted" />
      <div className="h-3 w-64 max-w-full animate-pulse rounded bg-muted" />
    </ItemContent>
    <ItemActions className="self-start">
      <div className="h-[18.4px] w-8 animate-pulse rounded-full bg-muted" />
    </ItemActions>
  </Item>
);
