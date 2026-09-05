import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TeachATask } from "@/components/computer/teach-a-task";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { readRecording, type Recording } from "@/lib/computer/demonstration";
import { focusRing, focusRingInset } from "@/components/ui/focus";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { pokeControl, watchControl } from "./control-poll";
import { decodeFrame, paintFrame } from "./frame-bitmap";
import { LiveScreen } from "./live-screen";
import {
  type ControlState,
  readControl,
  releaseControl,
  supplySecret,
  takeControl,
} from "./take-the-wheel";

type Screenshot = {
  base64: string;
  width: number;
  height: number;
  capturedAt: string;
  /** `about:blank` when the browser has not been sent anywhere yet. Absent on older computers. */
  url?: string;
};

/** Explicit blank-browser URLs say so in words; missing URL fields are treated as real pages. */
function isBlankBrowser(shot: Screenshot): boolean {
  if (shot.url === undefined) return false;
  const url = shot.url.trim();
  return url === "" || url === "about:blank";
}

/** Default browser viewport ratio, reserved before the first screenshot arrives. */
const DEFAULT_ASPECT_RATIO = 1280 / 800;

/** Minimum readable inline screen size. */
const DEFAULT_MIN_WIDTH = 320;
const DEFAULT_MIN_HEIGHT = 200;

/**
 * One horizontal rule for the whole card.
 *
 * Every block inside the card starts here: the picture, the sentences, the buttons. Measured at
 * 1440x900, three left edges used to coexist in the 287px column this pane leaves — 1150 for the
 * row text, 1162 for the recorded-steps list, and the picture at the card's own 1138 — which is
 * enough to read as a stack of unrelated things rather than one card. They are all 1146 now.
 *
 * WHICH IS WHY NO ROW HAS A TINTED BAND ANY MORE. A band has to pad itself away from its own edges,
 * and that padding is the second left edge; bleeding it back out with `-mx-2` was tried and puts an
 * 8px-radius rectangle across the card's own 16px corner, which is the thing directly above this
 * that was being fixed. A hairline says a new row has started, and the words stay on the rule.
 */
const CARD_PADDING = "p-2";

/**
 * The house ring, from `ui/focus.ts`, plus the border box it needs to recolour.
 *
 * These buttons cannot all be the `Button` primitive — one is the picture itself and one is a
 * full-screen backdrop — and what they showed a keyboard before was the browser's own
 * `outline: auto 1px`, in the colour the base layer sets to 20%-alpha black. Measured: on the
 * full-size view's black scrim that is nothing at all, and everywhere else it is a ring from a
 * different design than the one every other control in the app draws.
 */
const FOCUS_RING = `border border-transparent bg-clip-padding ${focusRing}`;

/**
 * The full-size view's own controls, which sit on a black scrim in both themes.
 *
 * White rather than the primary fill, and a white ring: `--ring` is near-black at 40% alpha in the
 * light theme, so the primitive's own focus ring is invisible on this scrim exactly half the time.
 */
const OVERLAY_BUTTON =
  "bg-white text-black hover:bg-white/90 focus-visible:border-white focus-visible:ring-white/70";

/** Identical frames in a row that mean the page has stopped changing. */
const SETTLED_FRAMES = 3;

/** Hard cap for post-action polling on pages that never settle. */
const SETTLE_TIMEOUT_MS = 30_000;

/** Short confirmation window after a secret is sent to the page. */
const SECRET_CONFIRM_MS = 6_000;

type Props = {
  /** Which computer to watch. One shared computer unless each Bot has been given its own. */
  computerId: string;
  /** Off by default so idle Bot screens do not poll indefinitely. */
  active?: boolean;
  intervalMs?: number;
  /** Width divided by height. Overridable for a Bot whose computer is not the default shape. */
  aspectRatio?: number;
  minWidth?: number;
  minHeight?: number;
  /**
   * Whether this instance offers to be taught.
   *
   * One instance does. This component draws beside the conversation and again on the line of every
   * computer tool call in it, and a teaching panel per past action is four ways into the same
   * recording with four separate drafts.
   */
  teachable?: boolean;
};

export function ComputerView({
  computerId,
  active = true,
  intervalMs = 1000,
  aspectRatio = DEFAULT_ASPECT_RATIO,
  minWidth = DEFAULT_MIN_WIDTH,
  minHeight = DEFAULT_MIN_HEIGHT,
  teachable = false,
}: Props) {
  const [shot, setShot] = useState<Screenshot | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [control, setControl] = useState<ControlState | null>(null);
  /**
   * What the server has recorded while somebody teaches, or null when nobody is.
   *
   * Read from the server rather than counted here: the events are recorded as they pass through the
   * proxy on their way to the browser, and this component never sees one.
   */
  const [recording, setRecording] = useState<Recording | null>(null);
  /** Held only until it is sent. Never lifted into a URL, a log, or anything that outlives this form. */
  const [secret, setSecret] = useState("");
  const [secretProblem, setSecretProblem] = useState<string | null>(null);
  const [sendingSecret, setSendingSecret] = useState(false);
  /*
   * A UNIQUE ID PER MOUNT. This component renders twice at once — the card in the transcript
   * and the pane beside it — so a hardcoded `id` put two masked fields on the page under one
   * name, and the label pointed at whichever the browser found first. Typing a password into
   * the wrong one of two identical boxes is not a mistake anybody can see themselves make.
   */
  const secretFieldId = useId();
  /**
   * Mounted whatever the state is, so the first frame has something to be painted onto.
   *
   * The poll decodes and paints before it tells React there is a screenshot. A canvas that only
   * appears once `shot` is set would therefore be blank for one whole poll interval — a second of
   * empty white where the picture is about to be.
   */
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const driving = control?.holder === "human";
  /** Read by the polling loop without restarting it on control changes. */
  const drivingRef = useRef(false);
  drivingRef.current = driving;

  /**
   * Release control; the Bot's waiting tool call resumes from this state change.
   *
   * Stable, because the Escape handler below depends on it and must not re-bind every render.
   */
  const refreshRecording = useCallback(async () => {
    setRecording(await readRecording(computerId));
  }, [computerId]);

  const handBack = useCallback(async () => {
    const state = await releaseControl(computerId);
    if (state) setControl(state);
    // The other cards watching this computer share one loop, and it may have settled. Wake it, or
    // the pane beside the conversation goes on saying somebody holds the wheel.
    pokeControl(computerId);
    // Handing back is what ends a recording, so what was kept is read straight afterwards — that is
    // the moment the panel has something to offer.
    await refreshRecording();
  }, [computerId, refreshRecording]);

  /*
   * Read once on arrival, because a recording outlives the page that made it.
   *
   * It lives on the server for as long as the wheel is held and until somebody keeps or discards
   * it, so a reload — or coming back to the tab later — must not look like nothing was recorded.
   * Measured: after a reload the panel offered "teach a task" while a finished recording sat on the
   * server with nothing pointing at it, which loses somebody's demonstration without saying so.
   */
  useEffect(() => {
    void refreshRecording();
  }, [refreshRecording]);

  const teach = useCallback(async () => {
    const state = await takeControl(computerId, true);
    if (state) setControl(state);
    pokeControl(computerId);
    await refreshRecording();
  }, [computerId, refreshRecording]);
  /** Secret prompts keep the screen live even though the human does not hold the wheel. */
  const secretPending = Boolean(control?.secretWanted);
  const secretPendingRef = useRef(false);
  secretPendingRef.current = secretPending;
  // Held in a ref so a slow response cannot overwrite a newer frame after the component moved on.
  const generation = useRef(0);
  /** Force a short watch window after non-Bot actions such as secret entry. */
  const watchUntil = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `secretPending` intentionally restarts settled polling.
  useEffect(() => {
    const mine = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    // Consecutive identical frames observed during post-action settling.
    let unchanged = 0;
    let lastFrame = "";
    const graceStartedAt = Date.now();

    /** Continue while active, human-driven, secret-pending, or not yet visually settled. */
    const shouldContinue = () => {
      if (active) return true;
      if (drivingRef.current) return true;
      if (secretPendingRef.current) return true;
      if (Date.now() < watchUntil.current) return true;
      if (Date.now() - graceStartedAt > SETTLE_TIMEOUT_MS) return false;
      return unchanged < SETTLED_FRAMES;
    };

    // Always fetch at least one frame; only repeated refreshes are conditional.
    const tick = async () => {
      try {
        const response = await fetch(
          `/api/computers/${computerId}/screenshot`,
          {
            credentials: "include",
          },
        );
        if (generation.current !== mine) return;

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          setProblem(
            body?.error ?? t("The screen is not available right now."),
          );
        } else {
          const next = (await response.json()) as Screenshot;
          // Exact byte comparison is the settling signal.
          unchanged = next.base64 === lastFrame ? unchanged + 1 : 0;
          lastFrame = next.base64;
          // Decode before swapping so the visible frame is never blank between polls.
          const bitmap = await decodeFrame(next.base64, "image/png");
          if (generation.current !== mine) {
            bitmap?.close();
            return;
          }
          const canvas = canvasRef.current;
          if (bitmap && canvas) paintFrame(canvas, bitmap);
          bitmap?.close();
          setShot(next);
          setProblem(null);
        }
      } catch {
        if (generation.current !== mine) return;
        setProblem(t("The screen is not available right now."));
      } finally {
        if (generation.current === mine && shouldContinue()) {
          timer = setTimeout(tick, intervalMs);
        }
      }
    };

    void tick();
    return () => {
      generation.current++;
      clearTimeout(timer);
    };
  }, [computerId, active, intervalMs, secretPending]);

  /*
   * Control state, on the shared loop rather than one of this card's own.
   *
   * Independent of the screenshot poll because help and secret prompts have to surface on a card
   * whose screen has settled — but it now settles too, and every card watching one computer settles
   * together. `isLive` is this card's vote: while it is the live one, while somebody holds the
   * wheel, and while a secret is being waited for, the loop keeps its 1 Hz whatever the state does.
   */
  const isLive = useCallback(
    () => active || drivingRef.current || secretPendingRef.current,
    [active],
  );
  useEffect(
    () => watchControl(computerId, { isLive, onState: setControl }),
    [computerId, isLive],
  );
  // Input forwarding lives in LiveScreen on the socket.
  // Escape is bound to the window so it works regardless of overlay focus.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      /*
       * HANDS BACK BEFORE IT CLOSES. Escape used to shut the overlay while leaving the person still
       * holding the wheel — the Bot stayed blocked on a takeover nobody could see they still had.
       *
       * `preventDefault` is load-bearing now that DetailPanel also listens for Escape and respects
       * `defaultPrevented`: without it, one press would close this overlay and the pane behind it.
       */
      if (driving) void handBack();
      setExpanded(false);
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, driving, handBack]);

  // Sized from the ratio, never from the payload, so the frame is identical in all three states.
  const frameStyle = { aspectRatio, minWidth, minHeight };

  // Always render the card frame; help/secret controls live below the conditional picture.
  const blankBrowser = shot ? isBlankBrowser(shot) : false;
  /** Blank browser placeholders should not be opened as readable screens. */
  const showScreen = shot !== null && !blankBrowser;

  /** Nothing has arrived yet and nothing has gone wrong: the one state that is genuinely loading. */
  const isLoadingFirstFrame = shot === null && problem === null;

  return (
    <>
      <figure
        className={`flex flex-col gap-2 rounded-2xl border ${CARD_PADDING}`}
      >
        {/* Inline preview remains in transcript; click opens a readable full-size view. */}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          // Disabled while blank/waiting but still reserves the frame.
          disabled={!showScreen}
          /*
           * ITS OWN ROUNDED RECTANGLE, INSET FROM THE CARD.
           *
           * The picture used to run edge to edge inside a rounded, clipped card, so the panel that
           * followed it cut straight across the bottom of the screen and the box's shape simply
           * stopped where that panel began. A complete rectangle cannot be crossed: whatever comes
           * next sits below it, on the same left rule.
           *
           * `bg-muted` is the letterbox behind `object-contain`, and it is dropped while loading so
           * the Skeleton's pulse is not muted-on-muted and therefore invisible.
           */
          className={`relative block w-full overflow-hidden rounded-xl enabled:cursor-zoom-in ${FOCUS_RING} ${isLoadingFirstFrame ? "" : "bg-muted"}`}
          style={frameStyle}
          aria-label={t("Open the Bot's screen full size")}
        >
          {/*
           * Mounted in every state, painted by the poll, revealed when there is something to see.
           * See `canvasRef` above for why it cannot be conditional.
           */}
          <canvas
            ref={canvasRef}
            aria-hidden={!showScreen}
            aria-label={t("What the Bot is looking at")}
            // A canvas has no implicit role, so without this the label it carries is announced by
            // nothing. The `<img>` it replaced got that for free from its `alt`.
            role="img"
            // Keep unexpected screenshot dimensions inside the reserved frame.
            className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-300 ${showScreen ? "opacity-100" : "opacity-0"}`}
          />

          {/*
           * NO ARTWORK BEHIND THE WAITING STATE.
           *
           * A blank browser used to be covered by a full-bleed pink-to-mint-to-chartreuse gradient
           * illustration on a hardcoded white base — a visual language from no part of this product,
           * which then forced the message on top of it into a black scrim and white text that
           * ignored the theme in both directions. The frame is a themed surface now, and the
           * sentence sits on it in the ordinary muted colour, which is what the rest of the app does
           * when it has nothing to show.
           *
           * Waiting is the exception, and it is not artwork: it is the same `Skeleton` the routines
           * below this card use while they load, so a screen on its way looks like everything else
           * on its way instead of like a grey rectangle that might be all there is. The sentence
           * stays for anyone reading the page rather than looking at it.
           */}
          {isLoadingFirstFrame ? (
            <>
              <Skeleton className="absolute inset-0 h-full w-full rounded-xl" />
              <span className="sr-only">
                {t("Waiting for the Bot's screen…")}
              </span>
            </>
          ) : showScreen ? null : (
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-4 text-center text-muted-foreground text-sm">
              {problem ? (
                <>
                  <span className="font-medium text-foreground">
                    {t("You cannot see the screen right now")}
                  </span>
                  <span>{problem}</span>
                  <span>
                    {t(
                      "The Bot may still be working. An administrator can check whether its computer is running.",
                    )}
                  </span>
                </>
              ) : (
                <span>{t("The Bot has not opened a page yet.")}</span>
              )}
            </span>
          )}
        </button>

        {/*
          Secret values go directly to the page path and are never included in the conversation.
          Audit records that a secret was supplied, not the value.
        */}
        {control?.secretWanted ? (
          <form
            /*
             * No horizontal padding of its own, and no tinted band.
             *
             * A row that pads itself starts its words further right than the row above it, and this
             * card had three such starts in one 320px column. The rule is the card's padding; a row
             * separates itself with the hairline above it, never by moving inwards.
             */
            className="border-t pt-2 text-sm"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!secret || sendingSecret) return;
              setSendingSecret(true);
              watchUntil.current = Date.now() + SECRET_CONFIRM_MS;
              const result = await supplySecret(computerId, secret);
              setSendingSecret(false);
              // Clear even on failure so plaintext is not left in the DOM.
              setSecret("");
              setSecretProblem(result.ok ? null : (result.error ?? null));
              const { state } = await readControl(computerId);
              if (state) setControl(state);
              pokeControl(computerId);
            }}
          >
            <label className="block" htmlFor={secretFieldId}>
              <span className="font-medium">{t("The Bot needs")} </span>
              <span>{control.secretWanted}</span>
              {control.secretInto ? (
                // The page and the field the server resolved, beside the Bot's own words for
                // what it wants: the two facts a person needs to tell a login box from a box a
                // page told the Bot to point at.
                <span className="text-muted-foreground">
                  {" · "}
                  {control.secretInto.element.name || control.secretInto.host}
                  {control.secretInto.element.name
                    ? ` · ${control.secretInto.host}`
                    : ""}
                </span>
              ) : null}
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                id={secretFieldId}
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder={t("Typed here, never shown to the Bot")}
                className={`min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm ${focusRing}`}
              />
              <Button
                disabled={!secret || sendingSecret}
                size="sm"
                type="submit"
              >
                {sendingSecret ? t("Sending…") : t("Send to the page")}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                "This goes straight to the page. It is not shown in the conversation and the Bot never receives it.",
              )}
            </p>
            {secretProblem ? (
              <p className="mt-1 text-xs text-destructive">{secretProblem}</p>
            ) : null}
          </form>
        ) : null}

        {driving ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-sm">
            <span>{t("You have control of this browser.")}</span>
            <span className="flex shrink-0 gap-2">
              <Button
                onClick={() => setExpanded(true)}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("Open full size")}
              </Button>
              <Button onClick={() => void handBack()} size="sm" type="button">
                {t("Hand back")}
              </Button>
            </span>
          </div>
        ) : null}

        {/*
         * Teaching, below the wheel and above the Bot's request for help. It is the same browser
         * and the same wheel; what differs is why somebody took it, and the panel says so.
         */}
        {/*
         * IN THE PANE, AND NOWHERE ELSE. This component draws once beside the conversation and
         * again on the line of every computer tool call in it, so a thread with four actions in it
         * has five of these — and each holds its own draft, so pressing in one leaves the others
         * showing what they showed before. Teaching is a standing control of the workspace, not a
         * thing that belongs on the line of one action that has already happened.
         */}
        {teachable ? (
          <TeachATask
            computerId={computerId}
            driving={driving}
            onRefresh={refreshRecording}
            onStart={teach}
            recording={recording}
          />
        ) : null}

        {control?.requested && !driving ? (
          /*
           * The colour is on the sentence, not on a band behind it.
           *
           * A tinted row has to pad itself away from its own edges, which is what put this row's
           * words 12px right of every other row's. The urgency was never in the tint: it is in
           * "The Bot needs you", which now carries the warning hue itself and starts on the rule.
           */
          <div className="flex flex-wrap items-start justify-between gap-2 border-t pt-2 text-sm">
            <span>
              <strong className="font-medium text-warning">
                {t("The Bot needs you.")}
              </strong>{" "}
              {control.reason}
            </span>
            <Button
              onClick={async () => {
                const state = await takeControl(computerId);
                if (state) setControl(state);
                pokeControl(computerId);
                setExpanded(true);
              }}
              size="sm"
              type="button"
            >
              {t("Take control")}
            </Button>
          </div>
        ) : null}
      </figure>

      {/*
        Portal to body so fixed positioning is measured against the viewport, not containing panes.
      */}
      {expanded && typeof document !== "undefined"
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label={t("The Bot's screen")}
              className="fixed inset-0 z-50 flex flex-col p-4 sm:p-8"
            >
              {/* Backdrop closes only while read-only; during driving, Escape remains the exit. */}
              <button
                type="button"
                onClick={() => !driving && setExpanded(false)}
                aria-label={t("Close the Bot's screen")}
                aria-hidden={driving}
                tabIndex={driving ? -1 : 0}
                /*
                 * INSET RING, AND WHITE RATHER THAN THE THEME'S — COMPOSED THROUGH `cn`.
                 *
                 * This element is the whole viewport, so an outward ring is drawn past its edges
                 * and clipped away; and the scrim is black in BOTH themes while `--ring` is
                 * near-black at 40% alpha in the light one. So the SHAPE is the house inset ring
                 * and only the colour is overridden.
                 *
                 * It has to go through `cn`. Written as a plain template string the measured ring
                 * came back `oklab(0.19 … / 0.2) 2px inset` — the house colour, not white — because
                 * Tailwind orders its output by utility rather than by the order classes appear in
                 * the attribute, so two ring colours in one class list is a coin toss and it landed
                 * on invisible. `cn` is `tailwind-merge`, which drops the loser instead of guessing.
                 */
                className={cn(
                  "absolute inset-0 bg-black/80",
                  focusRingInset,
                  "focus-visible:ring-white/70",
                  driving ? "cursor-default" : "cursor-zoom-out",
                )}
              />
              <div className="relative mb-3 flex items-center justify-between gap-4 text-sm text-white">
                <span className="pointer-events-none">
                  {driving ? (
                    <>
                      <strong className="font-medium">
                        {t("You have control.")}
                      </strong>{" "}
                      {t("Click and type on the page as you normally would.")}
                      {control?.reason ? ` ${control.reason}` : null}
                    </>
                  ) : active ? (
                    t("The Bot's screen, updating live")
                  ) : (
                    t("The Bot's screen")
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {driving ? (
                    <Button
                      className={OVERLAY_BUTTON}
                      onClick={() => {
                        setExpanded(false);
                        void handBack();
                      }}
                      size="sm"
                      type="button"
                    >
                      {t("Hand back to the Bot")}
                    </Button>
                  ) : (
                    /*
                     * Always offered, not only when the Bot asks. This is the person's own
                     * computer, and the login handoff that matters most is the one the Bot did
                     * not know to request — somebody watching it stall on a password field takes
                     * the wheel, signs in, hands back. The Bot asking merely makes the same
                     * button urgent.
                     */
                    <Button
                      className={
                        control?.requested
                          ? "bg-primary text-primary-foreground focus-visible:border-white focus-visible:ring-white/70"
                          : OVERLAY_BUTTON
                      }
                      onClick={async () => {
                        const state = await takeControl(computerId);
                        if (state) setControl(state);
                        pokeControl(computerId);
                      }}
                      size="sm"
                      type="button"
                    >
                      {control?.requested
                        ? t("Take control — the Bot asked for you")
                        : t("Take control")}
                    </Button>
                  )}
                  <span className="pointer-events-none text-white/70">
                    {/* Escape hands the wheel back on the way out; say so, since it is not obvious. */}
                    {driving
                      ? t("Press Escape to hand back and close")
                      : t("Click anywhere or press Escape to close")}
                  </span>
                </span>
              </div>
              {/* Overlay uses the live socket; the inline card keeps low-cost polling. */}
              <div className="relative min-h-0 flex-1 overflow-auto rounded-lg bg-black">
                <LiveScreen
                  computerId={computerId}
                  driving={driving}
                  onProblem={setProblem}
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
