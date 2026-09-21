import { IconChevronDown, IconChevronUp, IconClock } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { ComputerView } from "@/components/computer/computer-view";
import { ReadNotice } from "@/components/layout/read-states";
import { SectionBoundary } from "@/components/layout/section-boundary";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type ScreenPanelSize,
  setScreenPanel,
  useScreenPanel,
  useScreenPanelViewport,
} from "@/lib/computer/screen-panel";
import { t } from "@/lib/i18n";
import { readLineOf } from "@/lib/read-line";
import { settledOf, useReading } from "@/lib/reading";
import { routineListQueryOptions, scheduleLabel } from "@/lib/routines/queries";

/**
 * The three widths, as buttons.
 *
 * A TABLE, SO THE COVERAGE CHECK CANNOT SEE THEM — which is why `app/tests/screen-panel.test.ts`
 * walks it against the Korean dictionary by hand. `i18n-coverage.test.ts` greps for a translation
 * call with a literal string in it (CLAUDE.md), and these are read as `t(label)`, so a width added
 * here without Korean would ship as an English word on a Korean pane with the gate still green.
 *
 * And the spelling of that call is not written out anywhere above, deliberately: the check is a
 * regular expression over the source and does not strip comments, so a comment quoting the shape
 * it looks for IS one, and this file failed it with a key of `…` for exactly that reason.
 *
 * Words rather than a slider or a drag handle. A drag handle has no keyboard of its own — it needs
 * arrow keys bolted on, and a width nobody can name afterwards — while 작게·보통·크게 is three
 * ordinary buttons, reachable by Tab because they are buttons, and a person can say which one they
 * picked. The person this app is for does not want a number of pixels.
 */
export const PANEL_SIZES: readonly { size: ScreenPanelSize; label: string }[] =
  [
    { size: "small", label: "Small" },
    { size: "medium", label: "Medium" },
    { size: "large", label: "Large" },
  ];

/**
 * What a Bot is doing, beside what it is saying.
 *
 * The panel used to be one thing or the other: either the Bot's screen or its profile, chosen by a
 * URL flag, so watching it work meant giving up everything else about it. A colleague at a desk has
 * a screen and a schedule at the same time, and both are things you glance at while reading the
 * conversation rather than navigate to.
 *
 * The profile keeps its own pane — it is where a Bot is edited, which is a different activity from
 * watching one.
 */
export function BotPanel({
  agentId,
  name,
}: {
  agentId: string;
  /** Whose screen this is. The Bot's own name, never the conversation's. */
  name: string | undefined;
}) {
  const panel = useScreenPanel();
  const { isWide } = useScreenPanelViewport();
  /*
   * The card is `aria-controls` of the button that folds it, so the two have to share an id, and
   * this pane is drawn once per Bot rather than once per app — `useId` because a hardcoded one is
   * how the password field on this same card ended up on the page twice under one name.
   */
  const screenId = useId();
  const routines = useQuery(routineListQueryOptions());
  /*
   * THIS BOT'S routines, read out of everybody's: empty is about this Bot, so a person with ten
   * routines on other Bots is still offered the first one for this one.
   */
  const reading = useReading(routines, {
    isEmpty: (all) => !all.some((routine) => routine.agentId === agentId),
  });
  const mine = (settledOf(reading)?.data ?? []).filter(
    (routine) => routine.agentId === agentId,
  );

  return (
    <div className="flex flex-col gap-6 px-4 pt-2 pb-6">
      <section className="flex flex-col gap-2">
        {/*
         * WHOSE SCREEN IT IS, AND THE TWO CONTROLS OVER HOW MUCH ROOM IT TAKES.
         *
         * The name used to sit UNDER the card as a centred caption, which left the card with no
         * header for a control to live in and said the Bot's name a second time a few pixels below
         * the header that already says it. As a heading it matches 루틴 below it, and the row it
         * makes is where 접기 and the three widths belong.
         */}
        <div className="flex items-center justify-between gap-1">
          <h2 className="min-w-0 truncate font-medium text-muted-foreground text-xs">
            {name ? t("{name}'s screen", { name }) : t("The Bot's screen")}
          </h2>
          <div className="flex shrink-0 items-center gap-0.5">
            {/*
             * Not while folded — there is no picture for a width to apply to — and not on a window
             * narrow enough that the pane lies OVER the conversation, where every width covers the
             * same thing (`screenPanelWidth`).
             */}
            {isWide && !panel.isFolded ? (
              // A `fieldset` with `aria-pressed` on each button: the house grammar for one choice
              // out of three (`shop/business-kind-picker.tsx`, `agents/agent-profile.tsx`).
              <fieldset
                aria-label={t("Screen size")}
                className="flex items-center gap-0.5"
              >
                {PANEL_SIZES.map(({ size, label }) => (
                  <Button
                    aria-pressed={panel.size === size}
                    key={size}
                    onClick={() => setScreenPanel({ ...panel, size })}
                    size="xs"
                    variant="ghost"
                  >
                    {t(label)}
                  </Button>
                ))}
              </fieldset>
            ) : null}
            <Button
              aria-controls={screenId}
              aria-expanded={!panel.isFolded}
              // Named, not just arrowed: a chevron on its own is the one control on this pane a
              // person cannot guess, and `aria-expanded` alone reads as "collapsed, button".
              aria-label={
                panel.isFolded
                  ? t("Expand the screen")
                  : t("Collapse the screen")
              }
              onClick={() =>
                setScreenPanel({ ...panel, isFolded: !panel.isFolded })
              }
              size="icon-xs"
              variant="ghost"
            >
              {panel.isFolded ? <IconChevronDown /> : <IconChevronUp />}
            </Button>
          </div>
        </div>
        {/*
         * `minWidth` 0: the view's own 320px floor is wider than the 288px this pane leaves inside
         * its padding, so the thumbnail pushed the pane out to 400px from the inside. It scales to
         * whatever it is given; the floor exists for the full-size view, not for a preview.
         */}
        {/*
         * ITS OWN SEAM, INSIDE THE PANE'S. The screen card decodes a frame a second, polls the wheel
         * and holds the teaching panel; the routines under it are a plain list. A card that failed
         * leaves the list — and the pane's own seam (`DetailPanel`) is still there for the rest.
         */}
        <div id={screenId}>
          <SectionBoundary className="rounded-2xl border" section="computer">
            <ComputerView
              active
              computerId={agentId}
              isFolded={panel.isFolded}
              minWidth={0}
              teachable
            />
          </SectionBoundary>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium text-muted-foreground text-xs">
          {t("Routines")}
        </h2>

        {/*
         * ITS LINE, MOUNTED BEFORE IT SPEAKS. The failure had no way to ask again — a red line, and
         * nothing to press but reload the window.
         */}
        <ReadNotice
          line={readLineOf(reading, {
            failed: t("Your routines could not be loaded."),
            notHere: t("Routines are not offered here."),
          })}
          onRetry={() => void routines.refetch()}
          size="compact"
        />

        {reading.state === "loading" ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : null}

        {settledOf(reading)?.state === "empty" ? (
          /*
           * A Bot with no standing work is the normal case, so this is an empty state and not an
           * error: a sentence saying what a routine IS, then the button that makes one. It was an
           * underlined link the size of a footnote — the only way onward on this pane, drawn as
           * fine print.
           */
          <div className="flex flex-col items-center gap-3 px-2 py-4 text-center">
            <p className="text-muted-foreground text-sm">
              {t("A routine is work this Bot repeats on a schedule.")}
            </p>
            <Button
              nativeButton={false}
              render={(props) => <Link to="/routines" {...props} />}
              variant="secondary"
            >
              {t("Create a routine")}
            </Button>
          </div>
        ) : null}

        <ul className="flex flex-col gap-1">
          {mine.map((routine) => (
            <li key={routine.id}>
              <Link
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-foreground/5"
                to="/routines"
              >
                <IconClock
                  className={
                    routine.enabled
                      ? "size-4 shrink-0 text-muted-foreground"
                      : "size-4 shrink-0 text-muted-foreground/40"
                  }
                />
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {routine.name}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {routine.enabled ? scheduleLabel(routine) : t("Paused")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
