import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { pokeControl, watchControl } from "@/components/computer/control-poll";
import { releaseControl } from "@/components/computer/take-the-wheel";
import { LiveScreen } from "@/components/computer/live-screen";
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
  /** Null until the first read comes back: "we do not know yet" is not "the Bot has it". */
  const [hasWheel, setHasWheel] = useState<boolean | null>(null);

  const handBack = useCallback(async () => {
    setHandingBack(true);
    await releaseControl(botId);
    // Every other view watching this computer shares one control loop, and it may have settled.
    pokeControl(botId);
    const checked = await checkSiteConnection(site.id, botId);
    onDone(checked ? checked.signedIn : null);
  }, [botId, site.id, onDone]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Hands back BEFORE it closes, the same contract the Bot's screen makes: an overlay that
      // vanishes while somebody still holds the wheel leaves the Bot blocked on a takeover nobody
      // can see they have.
      void handBack();
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handBack]);

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
            onClick={() => void handBack()}
            size="sm"
            type="button"
            variant="secondary"
          >
            {isHandingBack
              ? t("Checking the page…")
              : t("Hand back to the Bot")}
          </Button>
          <span className="pointer-events-none text-white/70">
            {t("Press Escape to hand back and close")}
          </span>
        </span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto rounded-lg bg-black">
        <LiveScreen computerId={botId} driving onProblem={setProblem} />
      </div>
      {problem ? (
        <p className="relative mt-2 text-sm text-white" role="alert">
          {screenProblemText(problem)}
        </p>
      ) : null}
    </div>,
    document.body,
  );
};
