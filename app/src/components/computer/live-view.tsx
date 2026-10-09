import { IconLoader2 } from "@tabler/icons-react";
import { type ReactNode, useCallback, useState } from "react";
import { LiveRegion } from "@/components/layout/live-region";
import { SectionBoundary } from "@/components/layout/section-boundary";
import { Button } from "@/components/ui/button";
import { markPageGone } from "@/lib/computer/browsing-now";
import {
  type ScreenPanelSize,
  setScreenOpen,
  setScreenPanel,
  useScreenPanel,
  useScreenPanelViewport,
} from "@/lib/computer/screen-panel";
import { screenProblemText } from "@/lib/computer/screen-problems";
import { t } from "@/lib/i18n";
import { LiveScreen } from "./live-screen";

/**
 * The three widths, as buttons.
 *
 * A TABLE, SO THE COVERAGE CHECK CANNOT SEE THEM — which is why `app/tests/screen-panel.test.ts`
 * walks it against the Korean dictionary by hand. `i18n-coverage.test.ts` greps for a translation
 * call with a literal string in it (CLAUDE.md), and these are read through a variable.
 *
 * Words rather than a drag handle: three ordinary buttons, reachable by Tab, and a person can say
 * which one they picked.
 */
export const PANEL_SIZES: readonly { size: ScreenPanelSize; label: string }[] =
  [
    { size: "small", label: "Small" },
    { size: "medium", label: "Medium" },
    { size: "large", label: "Large" },
  ];

/**
 * THE BOT'S BROWSER, LIVE — OPENED BY A PERSON, AND GONE WHEN THERE IS NOTHING TO SHOW.
 *
 * What it replaces had three faults the owner named in one sentence: it opened itself every time the
 * Bot browsed, closing it did not last, and when the Bot closed its page an empty box stayed. So:
 *
 *  - It is opened only by somebody pressing something (`screen-panel.ts` says who may).
 *  - X and Escape close it (`DetailPanel`), and it stays closed.
 *  - It shows the Bot's current page and follows it: the computer's cast moves to whatever tab the
 *    Bot is on (`agent-computer/src/live-screen.ts`), so a closed tab gives way to the next one. When
 *    there is none, the computer's answer is a blank page, and this closes itself instead of drawing
 *    it. The conversation's task card keeps the last picture; there is never an empty box.
 *
 * WATCHED, ON EVERY SURFACE, AND NEVER DRIVEN (owner, 2026-10-09). It used to offer 직접 하기 and,
 * once the wheel was a person's, leave the pane for a sheet the size of the window that sent their
 * clicks and keys to the Bot's page. Nobody drives the Bot's browser now — not in the PC app, not in
 * a browser tab, not on a phone — so this is a picture with its size buttons and nothing to press on
 * it. A value a page needs goes through the masked box the Bot's request opens in the conversation.
 */
export function LiveView({ botId }: { botId: string }) {
  const panel = useScreenPanel();
  const { isWide } = useScreenPanelViewport();

  /*
   * Stable, and it has to be: the stream's effect depends on it through `Screen`, and a new function
   * every render would close the socket and open another on every frame.
   */
  const handleNoPage = useCallback(() => {
    // No page. Said once, to the card that would otherwise offer this view again, then closed.
    markPageGone(botId);
    setScreenOpen(false);
  }, [botId]);

  return (
    <div className="flex flex-col gap-3 px-4 pt-1 pb-6">
      <Screen
        beside={
          /* Not below `lg`: there the screen is the whole window and every size is the same size. */
          isWide ? (
            <fieldset
              aria-label={t("Screen size")}
              className="flex shrink-0 items-center gap-0.5"
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
          ) : null
        }
        botId={botId}
        frameClassName="aspect-[16/10] w-full"
        onNoPage={handleNoPage}
      />
    </div>
  );
}

/**
 * The picture, and what is said about it: the line above it, and the words over the frame when
 * there is no picture.
 */
function Screen({
  botId,
  frameClassName,
  beside,
  onNoPage,
}: {
  botId: string;
  /** The frame's size. */
  frameClassName: string;
  /** Drawn at the end of the line above the picture. */
  beside?: ReactNode;
  /** The computer has no page. Must be stable: the stream's effect depends on it. */
  onNoPage: () => void;
}) {
  /** The page's site; undefined until the first frame, "" for a page that is not a web address. */
  const [site, setSite] = useState<string | undefined>(undefined);
  /** A fact code (`laf:…`) for why there is no picture, or null. Words come from `screenProblemText`. */
  const [problem, setProblem] = useState<string | null>(null);
  /** Bumped by 다시 연결, which remounts the stream. */
  const [attempt, setAttempt] = useState(0);

  /*
   * Stable, and it has to be: the stream's effect depends on it, and a new function every render
   * would close the socket and open another on every frame.
   */
  const handleSite = useCallback(
    (next: string | null | undefined) => {
      if (next === null) {
        onNoPage();
        return;
      }
      setSite(next ?? "");
      setProblem(null);
    },
    [onNoPage],
  );

  const handleProblem = useCallback((code: string | null) => {
    setProblem(code);
  }, []);

  const isConnecting = site === undefined && problem === null;

  return (
    <>
      {/*
       * Why the screen is not showing, heard as well as drawn. The sentence below is drawn over the
       * picture only once there is a problem, and a line drawn with its words is not read out; this
       * one is mounted with the view (`LiveRegion`) and hidden, since the drawn one is the one seen.
       */}
      <LiveRegion className="sr-only" tone="alert">
        {problem ? screenProblemText(problem) : null}
      </LiveRegion>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full ${isConnecting || problem ? "bg-muted-foreground/40" : "bg-primary"}`}
          />
          <span className="truncate">
            {problem
              ? t("Not connected")
              : isConnecting
                ? t("Connecting to the screen…")
                : site
                  ? t("Live · {site}", { site })
                  : t("Live")}
          </span>
        </p>
        {beside}
      </div>

      <div
        className={`relative flex items-center justify-center overflow-hidden rounded-xl bg-black ${frameClassName}`}
      >
        {/* The stream fails inside the frame, not with it: the pane's own controls stay pressable. */}
        <SectionBoundary
          className="m-4 rounded-lg bg-background"
          section="live_screen"
        >
          <LiveScreen
            computerId={botId}
            key={attempt}
            onProblem={handleProblem}
            onSite={handleSite}
          />
        </SectionBoundary>
        {isConnecting ? (
          <span className="absolute inset-0 flex items-center justify-center">
            <IconLoader2
              aria-hidden="true"
              className="size-5 animate-spin text-white/70"
            />
          </span>
        ) : null}
        {problem ? (
          /*
           * LIGHT WORDS, BECAUSE THE FRAME IS BLACK IN BOTH THEMES. This was `bg-muted` with
           * `text-muted-foreground`, and in the light theme those are a 9% grey veil and 60%
           * near-black: measured rgba(20,20,20,.6) over the black frame, a sentence nobody could
           * read above the one button that would have fixed it.
           */
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm">
            <span className="text-pretty text-white/80">
              {screenProblemText(problem)}
            </span>
            {/*
             * 다시 연결, named for what it does: a new socket, which the computer makes the one it
             * casts to (`agent-computer/src/live-screen.ts`), from the first step of the schedule.
             */}
            <Button
              onClick={() => {
                setProblem(null);
                setSite(undefined);
                setAttempt((count) => count + 1);
              }}
              size="sm"
              variant="outline"
            >
              {t("Reconnect")}
            </Button>
          </span>
        ) : null}
      </div>
    </>
  );
}
