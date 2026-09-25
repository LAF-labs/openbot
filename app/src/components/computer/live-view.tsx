import { IconLoader2, IconPointer } from "@tabler/icons-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { LiveRegion } from "@/components/layout/live-region";
import { SectionBoundary } from "@/components/layout/section-boundary";
import { useOverlayModal } from "@/components/layout/use-overlay-modal";
import { Button } from "@/components/ui/button";
import { markPageGone } from "@/lib/computer/browsing-now";
import { type Recording, readRecording } from "@/lib/computer/demonstration";
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
 * The hand-backs a closing view asked for, by Bot, held one task before they are sent.
 *
 * MEASURED 2026-09-25 (0.5.4 final QA, dev server): 직접 하기 on a help card took the wheel, the
 * screen mounted already knowing it was driven, React's development double-mount ran the unmount
 * cleanup, and the wheel was handed back 67 ms after it was taken — the Bot carried on past a login
 * nobody had done. The same cleanup ran whenever the view only moved (a layout that remounts it).
 * A view of the same Bot mounting in the same commit cancels the hand-back; a real close still sends it.
 */
const pendingReleases = new Map<string, ReturnType<typeof setTimeout>>();

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
 *
 * WATCHED HERE, DRIVEN IN `DrivingScreen`. On a wide window, the moment the wheel is a person's the
 * screen leaves the pane for the whole window; see there for why.
 */
export function LiveView({ botId }: { botId: string }) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [isPressing, setIsPressing] = useState(false);
  const [pressFailure, setPressFailure] = useState<string | null>(null);
  /** A click or key that did not land (`Screen`'s `onInputProblem`), cleared by the next press. */
  const [inputProblem, setInputProblem] = useState<string | null>(null);
  const panel = useScreenPanel();
  const { isWide } = useScreenPanelViewport();
  const control = useControl(botId, true);
  const isDriving = control?.holder === "human";
  const isFullWindow = isDriving && isWide;
  /**
   * The Bot has asked for somebody — a login, a captcha, a code sent to a phone — or somebody took
   * the wheel to answer it (`reason` is kept while they hold it, dropped when they hand back).
   */
  const isHelping = control?.requested === true || Boolean(control?.reason);

  /*
   * Stable, and it has to be: the stream's effect depends on it through `Screen`, and a new function
   * every render would close the socket and open another on every frame.
   */
  const handleNoPage = useCallback(() => {
    // No page. Said once, to the card that would otherwise offer this view again, then closed.
    markPageGone(botId);
    setScreenOpen(false);
  }, [botId]);

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
  useEffect(() => {
    // A view of this Bot mounting again in the same commit was only moving: it keeps the wheel.
    const pending = pendingReleases.get(botId);
    if (pending !== undefined) {
      clearTimeout(pending);
      pendingReleases.delete(botId);
    }
    return () => {
      if (!drivingRef.current) return;
      pendingReleases.set(
        botId,
        setTimeout(() => {
          pendingReleases.delete(botId);
          void releaseControl(botId).then(() => pokeControl(botId));
        }, 0),
      );
    };
  }, [botId]);

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

  /*
   * Teaching is driving with a recorder on: the same wide-screen rule as 직접 하기. Not offered while
   * the Bot is asking for help — a captcha or a code sent to a phone is not a task anybody can show
   * a Bot how to do, and "한 번만 직접 해 보이면, 다음부터는 이 봇이 합니다" under one was a promise
   * the recording could not keep (0.5.3 audit, item 4). A recording already made is still shown.
   */
  const teaching =
    isWide && (recording || !isHelping) ? (
      <TeachATask
        computerId={botId}
        driving={isDriving}
        onRefresh={refreshRecording}
        onStart={teach}
        recording={recording}
      />
    ) : null;

  const said =
    pressFailure ?? (inputProblem ? screenProblemText(inputProblem) : null);

  if (isFullWindow) {
    return (
      <DrivingScreen
        botId={botId}
        busyLabel={t("Handing back…")}
        failure={pressFailure}
        heading={t(
          "You have the browser. Press I'm done when you are finished.",
        )}
        isHandingBack={isPressing}
        onDone={() => void handleHandBack()}
      >
        {recording && !recording.finished ? teaching : null}
      </DrivingScreen>
    );
  }

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
        driving={isDriving}
        frameClassName="aspect-[16/10] w-full"
        onInputProblem={setInputProblem}
        onNoPage={handleNoPage}
      />

      {isDriving ? (
        // Below `lg` only: a wide window drives in `DrivingScreen`.
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>
            {t("You have the browser. Press I'm done when you are finished.")}
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
            {isPressing ? t("Handing it to you…") : t("Take over")}
          </Button>
        </div>
      ) : null}

      <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
        {said}
      </LiveRegion>

      {teaching}
    </div>
  );
}

/**
 * The picture, and what is said about it: the line above it, the words over the frame when there is
 * no picture, and the line under it when a click did not land.
 *
 * ONE PER STREAM, WHICH IS WHY IT IS A COMPONENT. The pane and `DrivingScreen` each mount one, and
 * each is a new socket with nothing known yet — so each starts at "화면에 연결하는 중…" rather than
 * with the site and the picture the other one had.
 */
function Screen({
  botId,
  driving,
  frameClassName,
  beside,
  onNoPage,
  onInputProblem,
}: {
  botId: string;
  driving: boolean;
  /** The frame's size: a fixed shape in the pane, the rest of the window in the sheet. */
  frameClassName: string;
  /** Drawn at the end of the line above the picture. */
  beside?: ReactNode;
  /** The computer has no page. Absent, the last picture stays: somebody driving keeps their screen. */
  onNoPage?: () => void;
  /**
   * A fact code for a click or key that did not land, to be said under a picture that is still
   * there. Handed up because the line it is said on is shared with the presses of whoever mounted
   * this, and they clear it. Must be stable, as `onNoPage` must: the stream's effect depends on both.
   *
   * Apart from `problem` because it is not one: the stream is fine, one piece of input was not, and
   * covering the picture for it — to be uncovered by the very next frame — says neither.
   */
  onInputProblem: (code: string) => void;
}) {
  /** The page's site; undefined until the first frame, "" for a page that is not a web address. */
  const [site, setSite] = useState<string | undefined>(undefined);
  /** A fact code (`laf:…`) for why there is no picture, or null. Words come from `screenProblemText`. */
  const [problem, setProblem] = useState<string | null>(null);
  /** Whether a frame has arrived: what decides which of the two a code from the stream is. */
  const hasPicture = useRef(false);
  /** Bumped by 다시 연결, which remounts the stream. */
  const [attempt, setAttempt] = useState(0);

  /*
   * Stable, and it has to be: the stream's effect depends on it, and a new function every render
   * would close the socket and open another on every frame.
   */
  const handleSite = useCallback(
    (next: string | null | undefined) => {
      if (next === null && onNoPage) {
        onNoPage();
        return;
      }
      hasPicture.current = true;
      setSite(next ?? "");
      setProblem(null);
    },
    [onNoPage],
  );

  const handleProblem = useCallback(
    (code: string | null) => {
      if (code !== null && hasPicture.current) {
        onInputProblem(code);
        return;
      }
      setProblem(code);
    },
    [onInputProblem],
  );

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
        {driving ? null : beside}
      </div>

      <div
        className={`relative flex items-center justify-center overflow-hidden rounded-xl bg-black ${frameClassName}`}
      >
        {/* The stream fails inside the frame, not with it: 다 했어요 must stay pressable. */}
        <SectionBoundary
          className="m-4 rounded-lg bg-background"
          section="live_screen"
        >
          <LiveScreen
            computerId={botId}
            driving={driving}
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
                hasPicture.current = false;
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

/**
 * THE BOT'S SCREEN WHILE A PERSON DOES SOMETHING ON IT: THE WHOLE WINDOW, AND ONE PAIR OF WORDS.
 *
 * MEASURED 2026-09-24 (0.5.3 audit, item 4): 직접 하기 on a request for help left the screen in the
 * side pane, 580px wide in a 1280px window, with the Bot's 1280px page drawn at 43% — the Naver
 * login's two boxes a few millimetres tall, and a captcha's letters smaller still. The sign-in
 * handoff on the 연결 screen already took the whole window and drew the same page at 87%. So both
 * are this one sheet now: a wide window gives the page all of itself for as long as somebody holds
 * the wheel, and gives it back when they press 다 했어요.
 *
 * AND ONE PAIR OF WORDS. The chat card said "직접 하기 / 다 했어요"; the handoff said "제어 중입니다
 * … 봇에게 제어 돌려주기" and "Esc를 누르면 제어를 돌려주고 닫습니다" — two names for one act, and
 * "제어" is nobody's word for it. Whoever opens this, the way out is 다 했어요, and Escape is the
 * same press.
 *
 * A PORTAL WITH A SURFACE OF ITS OWN, NOT A VEIL. The handoff's `bg-black/80` let the page under it
 * show through behind its white heading (measured: "앱으로 돌아가기" printed through it). This is
 * `bg-background`, so every word on it is the app's ordinary colour in either theme, and only the
 * frame is black.
 *
 * Escape hands back BEFORE anything closes — an overlay that vanishes while somebody holds the wheel
 * leaves the Bot blocked on a takeover nobody can see they have — and is taken in the capture phase,
 * so the pane under it (`DetailPanel`, which closes on Escape) sees it already handled.
 */
export function DrivingScreen({
  botId,
  heading,
  isHandingBack,
  busyLabel,
  failure,
  onDone,
  children,
}: {
  botId: string;
  /** What the person is here to do, said above the picture. */
  heading: ReactNode;
  /** 다 했어요 has been pressed and has not come back yet. */
  isHandingBack: boolean;
  /** What 다 했어요 says while it is on its way. */
  busyLabel: string;
  /** Why the wheel did not go back, when it did not; 다 했어요 then says 다시 시도. */
  failure: string | null;
  onDone: () => void;
  /** Drawn under the picture: the recording's line while somebody is teaching. */
  children?: ReactNode;
}) {
  /** A click or key that did not land; said on the same line as `failure`, which wins. */
  const [inputProblem, setInputProblem] = useState<string | null>(null);

  const handleDone = () => {
    // Once, not once per press: a second Escape while the wheel goes back sent a second release.
    if (isHandingBack) return;
    setInputProblem(null);
    onDone();
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      handleDone();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  });

  // The page under it is inert while it is up, and focus goes back to what opened it.
  useOverlayModal(true);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      aria-label={t("The Bot's screen")}
      aria-modal="true"
      className="fixed inset-0 z-50 flex flex-col gap-2 bg-background px-4 pt-3 pb-4 sm:px-6"
      role="dialog"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 font-medium text-sm">{heading}</p>
        <div className="flex shrink-0 items-center gap-3">
          {/* Not on a phone, which has no Escape to press. */}
          <span className="hidden text-muted-foreground text-xs sm:inline">
            {t("Escape does the same as I'm done")}
          </span>
          <Button
            disabled={isHandingBack}
            // Keeps the focus it was pressed with while the wheel goes back.
            focusableWhenDisabled
            onClick={handleDone}
            size="sm"
            type="button"
          >
            {isHandingBack
              ? busyLabel
              : failure
                ? t("Try again")
                : t("I'm done")}
          </Button>
        </div>
      </div>
      <Screen
        botId={botId}
        driving
        frameClassName="min-h-0 flex-1"
        onInputProblem={setInputProblem}
      />
      {/* Mounted with the sheet, so a hand-back that did not happen is heard when it is said. */}
      <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
        {failure ?? (inputProblem ? screenProblemText(inputProblem) : null)}
      </LiveRegion>
      {children}
    </div>,
    document.body,
  );
}
