import { useCallback, useEffect, useState } from "react";
import { pokeControl, watchControl } from "@/components/computer/control-poll";
import { DrivingScreen } from "@/components/computer/live-view";
import { releaseControl } from "@/components/computer/take-the-wheel";
import { t } from "@/lib/i18n";
import type { BusinessSite } from "@/lib/sites/catalogue";
import { checkSiteConnection } from "@/lib/sites/queries";

/**
 * The wheel, while somebody logs in.
 *
 * Reuses the takeover the product already has — `takeControl`/`releaseControl`, and since 0.5.3 the
 * very sheet a request for help in the conversation opens (`DrivingScreen`) — rather than building a
 * second one. It used to be an overlay of its own that called the same act "제어 돌려주기" where the
 * conversation said "다 했어요" (0.5.3 audit, item 4). The only thing this adds is knowing WHY the
 * wheel was taken, which is what lets it ask the server, on the way back, whether the login actually
 * worked.
 *
 * IT WATCHES THE WHEEL RATHER THAN ASSUMING IT. This overlay used to say "조종권은 당신에게
 * 있습니다" from the moment it opened and never look again. Control can end without this window
 * doing anything — the takeover has a deadline, and another tab of the same person's can take it —
 * and a person typing a password into a browser the Bot has taken back is typing it into whatever
 * page the Bot has since opened. So the state is read, and when the wheel is not theirs the sheet
 * says so instead of the sentence it was drawn with.
 *
 * NOTHING HERE EVER SEES A PASSWORD. Everything typed during the handoff goes over the live-screen
 * socket straight to Chromium; this component never reads it, and the audit trail records that
 * somebody held the wheel, not what they pressed.
 */
export function Handoff({
  site,
  botId,
  onDone,
}: {
  site: BusinessSite;
  botId: string;
  /** Called after the wheel is handed back, with what the page turned out to say. */
  onDone: (signedIn: boolean | null) => void;
}) {
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

  useEffect(
    () =>
      watchControl(botId, {
        onState: (state) => setHasWheel(state.holder === "human"),
        // Awake for as long as the sheet is up: this is the one view where the answer changing is
        // the thing the person most needs told, and a settled loop would never tell them.
        isLive: () => true,
      }),
    [botId],
  );

  return (
    <DrivingScreen
      botId={botId}
      busyLabel={t("Checking the page…")}
      failure={failure}
      heading={
        hasWheel === false ? (
          <strong className="font-medium text-destructive">
            {t(
              "The Bot has taken the browser back. Nothing you type reaches it.",
            )}
          </strong>
        ) : (
          t("Log in on {name}, then press I'm done.", { name: t(site.name) })
        )
      }
      isHandingBack={isHandingBack}
      onDone={() => void handBack()}
    />
  );
}
