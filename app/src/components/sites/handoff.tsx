import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { pokeControl, watchControl } from "@/components/computer/control-poll";
import { releaseControl } from "@/components/computer/take-the-wheel";
import { LiveScreen } from "@/components/computer/live-screen";
import { LiveRegion } from "@/components/layout/live-region";
import { SectionBoundary } from "@/components/layout/section-boundary";
import { useOverlayModal } from "@/components/layout/use-overlay-modal";
import { Button } from "@/components/ui/button";
import { screenProblemText } from "@/lib/computer/screen-problems";
import { t } from "@/lib/i18n";
import type { BusinessSite } from "@/lib/sites/catalogue";
import { checkSiteConnection } from "@/lib/sites/queries";

/**
 * The wheel, while somebody logs in.
 *
 * Reuses the takeover the product already has — `takeControl`/`releaseControl` and the same
 * `LiveScreen` socket the Bot's screen uses when a person drives it — rather than building a second
 * one. The only thing this adds is knowing WHY the wheel was taken, which is what lets it ask the
 * server, on the way back, whether the login actually worked.
 *
 * IT WATCHES THE WHEEL RATHER THAN ASSUMING IT. This overlay used to say "조종권은 당신에게
 * 있습니다" from the moment it opened and never look again. Control can end without this window
 * doing anything — the takeover has a deadline, and another tab of the same person's can take it —
 * and a person typing a password into a browser the Bot has taken back is typing it into whatever
 * page the Bot has since opened. So the state is read, and when the wheel is not theirs the overlay
 * says so instead of the sentence it was drawn with.
 *
 * NOTHING HERE EVER SEES A PASSWORD. Everything typed during the handoff goes over the live-screen
 * socket straight to Chromium; this component never reads it, and the audit trail records that
 * somebody held the wheel, not what they pressed.
 */
export const Handoff = ({
  site,
  botId,
  onDone,
}: {
  site: BusinessSite;
  botId: string;
  /** Called after the wheel is handed back, with what the page turned out to say. */
  onDone: (signedIn: boolean | null) => void;
}) => {
  /** A fact code from the live screen, said in the person's words where it is rendered. */
  const [problem, setProblem] = useState<string | null>(null);
  const [isHandingBack, setHandingBack] = useState(false);
  /** Why the wheel did not go back, when it did not. */
  const [failure, setFailure] = useState<string | null>(null);
  /** Null until the first read comes back: "we do not know yet" is not "the Bot has it". */
  const [hasWheel, setHasWheel] = useState<boolean | null>(null);

  /*
   * CLOSES ONCE THE WHEEL IS BACK, AND NOT BEFORE (`docs/laf/dialogs.md`). A release the computer
   * refused used to be read past — the page was checked and the overlay closed as if it had worked,
   * leaving the Bot blocked — and one nothing answered threw out of here with the button stuck on
   * 화면을 확인하는 중… for good. Now either stays open, says so, and offers 다시 시도.
   */
  const handBack = useCallback(async () => {
    setFailure(null);
    setHandingBack(true);
    const released = await releaseControl(botId).catch(() => null);
    // Every other view watching this computer shares one control loop, and it may have settled.
    pokeControl(botId);
    if (!released) {
      setHandingBack(false);
      setFailure(
        t("The browser could not be handed back to the Bot. Try again."),
      );
      return;
    }
    // A check nothing answered is the row's "could not be read", which `onDone(null)` already says.
    const checked = await checkSiteConnection(site.id, botId).catch(() => null);
    onDone(checked ? checked.signedIn : null);
  }, [botId, site.id, onDone]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // Once, not once per press: a second Escape while the wheel goes back sent a second release.
      if (isHandingBack) return;
      // Hands back BEFORE it closes, the same contract the Bot's screen makes: an overlay that
      // vanishes while somebody still holds the wheel leaves the Bot blocked on a takeover nobody
      // can see they have.
      void handBack();
    };
    // In the capture phase, so its `preventDefault` is set before any window listener added earlier
    // reads it — the Bot's screen measured one Escape closing its overlay and the pane beneath.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [handBack, isHandingBack]);

  // The page under it is inert while it is up, and focus goes back to the row that opened it.
  useOverlayModal(true);

  useEffect(
    () =>
      watchControl(botId, {
        onState: (state) => setHasWheel(state.holder === "human"),
        // Awake for as long as the overlay is up: this is the one view where the answer changing
        // is the thing the person most needs told, and a settled loop would never tell them.
        isLive: () => true,
      }),
    [botId],
  );

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      aria-label={t("The Bot's screen")}
      aria-modal="true"
      className="fixed inset-0 z-50 flex flex-col p-4 sm:p-8"
      role="dialog"
    >
      <div className="absolute inset-0 bg-black/80" />
      <div className="relative mb-3 flex items-center justify-between gap-4 text-sm text-white">
        <span className="pointer-events-none">
          {hasWheel === false ? (
            <strong className="font-medium text-destructive">
              {t(
                "The Bot has taken the browser back. Nothing you type reaches it.",
              )}
            </strong>
          ) : (
            <>
              <strong className="font-medium">{t("You have control.")}</strong>{" "}
              {t("Log in on {name}, then hand it back.", {
                name: t(site.name),
              })}
            </>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <Button
            disabled={isHandingBack}
            // Keeps the focus it was pressed with while the wheel goes back and the page is read.
            focusableWhenDisabled
            onClick={() => {
              if (!isHandingBack) void handBack();
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            {isHandingBack
              ? t("Checking the page…")
              : failure
                ? t("Try again")
                : t("Hand back to the Bot")}
          </Button>
          <span className="pointer-events-none text-white/70">
            {t("Press Escape to hand back and close")}
          </span>
        </span>
      </div>
      {/* Mounted with the overlay, so a hand-back that did not happen is heard when it is said. */}
      <LiveRegion
        as="p"
        className="relative mb-3 self-start rounded-md bg-destructive px-3 py-1.5 text-sm text-white"
        tone="alert"
      >
        {failure}
      </LiveRegion>
      <div className="relative min-h-0 flex-1 overflow-auto rounded-lg bg-black">
        {/* The same seam as the Bot's own full-size view: the hand-back button above outlives it. */}
        <SectionBoundary
          className="m-4 rounded-lg bg-background"
          section="live_screen"
        >
          <LiveScreen computerId={botId} driving onProblem={setProblem} />
        </SectionBoundary>
      </div>
      <LiveRegion
        as="p"
        className="relative mt-2 text-sm text-white"
        tone="alert"
      >
        {problem ? screenProblemText(problem) : null}
      </LiveRegion>
    </div>,
    document.body,
  );
};
