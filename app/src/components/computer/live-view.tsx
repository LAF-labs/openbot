import { IconLoader2, IconPointer } from "@tabler/icons-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { LiveRegion } from "@/components/layout/live-region";
import { SectionBoundary } from "@/components/layout/section-boundary";
import { Button } from "@/components/ui/button";
import { markPageGone } from "@/lib/computer/browsing-now";
import { readRecording, type Recording } from "@/lib/computer/demonstration";
import {
  type ScreenPanelSize,
  setScreenOpen,
  setScreenPanel,
  useScreenPanel,
  useScreenPanelViewport,
} from "@/lib/computer/screen-panel";
import { screenProblemText } from "@/lib/computer/screen-problems";
import { t } from "@/lib/i18n";
import { pokeControl } from "./control-poll";
import { LiveScreen } from "./live-screen";
import { releaseControl, takeControl } from "./take-the-wheel";
import { TeachATask } from "./teach-a-task";
import { useControl } from "./use-control";

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
 * The picture is the cast, not a polled PNG: it is what a person drives with, and it is the one
 * stream that carries the page's site (`screencast.ts`).
 */
export function LiveView({ botId }: { botId: string }) {
  /** The page's site; undefined until the first frame, "" for a page that is not a web address. */
  const [site, setSite] = useState<string | undefined>(undefined);
  /** A fact code (`laf:…`) for why there is no picture, or null. Words come from `screenProblemText`. */
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * A fact code for a click or key that did not land, said under a picture that is still there.
   *
   * Apart from `problem` because it is not one: the stream is fine, one piece of input was not, and
   * covering the picture for it — to be uncovered by the very next frame — says neither.
   */
  const [inputProblem, setInputProblem] = useState<string | null>(null);
  /** Whether a frame has arrived: what decides which of the two a code from the stream is. */
  const hasPicture = useRef(false);
  /** Bumped by 다시 시도, which remounts the stream. */
  const [attempt, setAttempt] = useState(0);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [isPressing, setIsPressing] = useState(false);
  const [pressFailure, setPressFailure] = useState<string | null>(null);
  const panel = useScreenPanel();
  const { isWide } = useScreenPanelViewport();
  const control = useControl(botId, true);
  const isDriving = control?.holder === "human";

  /*
   * Stable, and it has to be: the stream's effect depends on it, and a new function every render
   * would close the socket and open another on every frame.
   */
  const handleSite = useCallback(
    (next: string | null | undefined) => {
      if (next === null) {
        // No page. Said once, to the card that would otherwise offer this view again, then closed.
        markPageGone(botId);
        setScreenOpen(false);
        return;
      }
      hasPicture.current = true;
      setSite(next ?? "");
      setProblem(null);
    },
    [botId],
  );

  const handleProblem = useCallback((code: string | null) => {
    if (code !== null && hasPicture.current) {
      setInputProblem(code);
      return;
    }
    setProblem(code);
  }, []);

  /*
   * CLOSING HANDS THE WHEEL BACK. A person who closes the screen while holding the wheel has stopped
   * driving, whatever button they used — X, Escape, the header — and a Bot left blocked on a
   * takeover nobody can see is the failure the old full-size view's Escape had. Read from a ref in
   * the cleanup, because the cleanup runs after the last render it could have read state from.
   */
  const drivingRef = useRef(false);
  useLayoutEffect(() => {
    drivingRef.current = isDriving;
  });
  useEffect(
    () => () => {
      if (drivingRef.current) {
        void releaseControl(botId).then(() => pokeControl(botId));
      }
    },
    [botId],
  );

  const refreshRecording = useCallback(async () => {
    setRecording(await readRecording(botId));
  }, [botId]);

  // A recording outlives the page that made it: read on arrival so one is never lost to a reload.
  useEffect(() => {
    void refreshRecording();
  }, [refreshRecording]);

  const teach = useCallback(async () => {
    await takeControl(botId, true);
    pokeControl(botId);
    await refreshRecording();
  }, [botId, refreshRecording]);

  const handleTake = async () => {
    setPressFailure(null);
    setInputProblem(null);
    setIsPressing(true);
    const state = await takeControl(botId).catch(() => null);
    setIsPressing(false);
    pokeControl(botId);
    // Verified, not assumed.
    if (state?.holder !== "human") {
      setPressFailure(
        t("The browser could not be handed over. Please try again."),
      );
    }
  };

  const handleHandBack = async () => {
    setPressFailure(null);
    setInputProblem(null);
    setIsPressing(true);
    const state = await releaseControl(botId).catch(() => null);
    setIsPressing(false);
    pokeControl(botId);
    // Handing back is what ends a recording, so what was kept is read straight afterwards.
    await refreshRecording();
    if (!state) {
      setPressFailure(
        t("The browser could not be handed back to the Bot. Try again."),
      );
    }
  };

  const isConnecting = site === undefined && problem === null;

  return (
    <div className="flex flex-col gap-3 px-4 pt-1 pb-6">
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
        {/* Not below `lg`: there the screen is the whole window and every size is the same size. */}
        {isWide && !isDriving ? (
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
        ) : null}
      </div>

      <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-black">
        {/* The stream fails inside the frame, not with it: the hand-back below must stay pressable. */}
        <SectionBoundary
          className="m-4 rounded-lg bg-background"
          section="live_screen"
        >
          <LiveScreen
            computerId={botId}
            driving={isDriving}
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
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted p-4 text-center text-sm">
            <span className="text-muted-foreground">
              {screenProblemText(problem)}
            </span>
            <Button
              onClick={() => {
                hasPicture.current = false;
                setProblem(null);
                setSite(undefined);
                setAttempt((count) => count + 1);
              }}
              size="sm"
              variant="outline"
            >
              {t("Try again")}
            </Button>
          </span>
        ) : null}
      </div>

      {isDriving ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>
            {t(
              "You are using the browser. The Bot waits until you hand it back.",
            )}
          </span>
          <Button
            disabled={isPressing}
            onClick={() => void handleHandBack()}
            size="sm"
          >
            {isPressing ? t("Handing back…") : t("I'm done")}
          </Button>
        </div>
      ) : isWide ? (
        /*
         * Always offered on a wide screen, not only when the Bot asks: the login that matters most is
         * the one the Bot did not know to ask for. Not on a phone yet — driving a page by touch has
         * not been measured, and a control that half-works is worse than none (CLAUDE.md).
         */
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">
            {t("You can click and type on this page yourself.")}
          </span>
          <Button
            disabled={isPressing}
            onClick={() => void handleTake()}
            size="sm"
            variant="secondary"
          >
            <IconPointer aria-hidden="true" />
            {isPressing ? t("Taking control…") : t("Take over")}
          </Button>
        </div>
      ) : null}

      <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
        {pressFailure ??
          (inputProblem ? screenProblemText(inputProblem) : null)}
      </LiveRegion>

      {/* Teaching is driving with a recorder on: the same wide-screen rule as 직접 하기. */}
      {isWide ? (
        <TeachATask
          computerId={botId}
          driving={isDriving}
          onRefresh={refreshRecording}
          onStart={teach}
          recording={recording}
        />
      ) : null}
    </div>
  );
}
