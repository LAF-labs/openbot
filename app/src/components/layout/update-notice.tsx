import { IconRefresh } from "@tabler/icons-react";
import { useState } from "react";
import { usePresence } from "@/components/channels/use-presence";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useMyBots } from "@/lib/agents/my-bots";
import {
  reloadIntoNewBuild,
  type UpdateOffer,
  updateOffer,
  useBuildFacts,
} from "@/lib/build-watch";
import { t } from "@/lib/i18n";
import { restartToUpdate, shellStatusOf } from "@/lib/notifications/shell";
import { cn } from "@/lib/utils";

/**
 * 새 버전이 있어요 — THE ONE THING THE APP SAYS ABOUT A NEWER VERSION OF ITSELF, AND THE ONE PRESS.
 *
 * Two things can be newer, and a person should not have to know which. The server and its page
 * are replaced on the VM, and a window left open is still the page from before
 * (`lib/build-watch.ts`): 새 버전이 있어요 · 새로고침, and the press reloads into the new page with
 * what was typed kept (`reloadPage`). In the installed app the shell itself is also replaced — it
 * fetches a newer shell at launch and holds it (`install_updates` in desktop/src-tauri/src/lib.rs):
 * 다시 시작해서 업데이트, and the press restarts into it. The same control says whichever is true,
 * and the restart when both are, since the app that comes back loads the page afresh.
 *
 * WHAT TOLD THE PERSON BEFORE (2026-09-26 to 2026-10-06): about the shell, a card floated in the
 * window's corner — 새 버전이 준비됐어요, 나중에, 지금 다시 시작 — and about the page, nothing at
 * all. The card went when this came: two notices for one fact would be the thing drawn twice, and
 * a card that stays covers the top of the conversation under it.
 *
 * IT NEVER INTERRUPTS. No dialog, no card over the conversation, nothing that leaves by itself and
 * nothing that happens by itself: one icon in the row at the top, beside the profile button, with
 * its words a hover away (`app-header.tsx`) — where the app keeps what is about the app rather
 * than about the Bot. It was a row at the foot of the sidebar and a row over a phone's bar until
 * both went (2026-10-09). It is not drawn on Settings or Admin, which have no such row: it is
 * waiting where the person comes back to.
 *
 * NEVER MID-TURN, AND NEVER LATER BY ITSELF. While the Bot is working, or waiting on the person,
 * the control is drawn and cannot be pressed, and says why. The other way to keep a turn whole —
 * take the press and reload when the turn ends — was not taken: the reload would then land minutes
 * after the press, at the moment the answer finishes and the person starts the next sentence, and
 * a reload under typing drops the syllable a Korean keyboard is still composing. So a reload only
 * ever happens under the person's finger. It is the rule the shell's restart has kept since
 * 2026-09-26 — decided while the window drove the Bot's turn and a restart ended it; the server
 * runs the turn now and it goes on through either, and the rule was left as it was, because either
 * still takes the answer off the screen somebody is watching it arrive on. The shell itself
 * refuses a restart it has no update for.
 *
 * NOTHING IS ASKED ABOUT THE BOT UNTIL THERE IS SOMETHING TO HOLD. This is mounted on every screen;
 * whether the Bot is busy is read only by the inner control, which exists only while there is an
 * offer.
 */
export function UpdateNotice({
  className,
  shape,
}: {
  className?: string;
  /** `row` in the column and over the phone's bar; `icon` in the 64px rail. */
  shape: "row" | "icon";
}) {
  const facts = useBuildFacts();
  if (updateOffer({ ...facts, isBotBusy: false }).kind === "none") return null;
  return <UpdateControl className={className} shape={shape} />;
}

/** The words for an offer: what there is, the press's own word where it has one, and why not now. */
function wordsOf(
  offer: Exclude<UpdateOffer, { kind: "none" }>,
  restart: { isRestarting: boolean; hasFailed: boolean },
): { phrase: string; action: string | null; reason: string | null } {
  if (offer.kind === "restart") {
    return {
      // The press and the news in one phrase, as the app this is modelled on says it.
      phrase: t("Restart to update"),
      action: null,
      reason: restart.hasFailed
        ? t("Could not restart. Quit the app and open it again.")
        : restart.isRestarting
          ? t("Restarting…")
          : offer.isHeld
            ? t("Your Bot is working. Restart once it is done.")
            : null,
    };
  }
  return {
    phrase: t("A new version is here"),
    action: t("Refresh"),
    reason: offer.isHeld
      ? t("Your Bot is working. Refresh once it is done.")
      : null,
  };
}

function UpdateControl({
  className,
  shape,
}: {
  className?: string;
  shape: "row" | "icon";
}) {
  const facts = useBuildFacts();
  /*
   * The first of the person's Bots: there is one (docs/laf/deployment-model.md). The same answer
   * as the pill beside its name and the tray's line (`ShellSync`), folded the way the tray folds
   * it — and held only while the Bot is WORKING. A Bot waiting on the person (a question, a
   * request for help) is not working: the sentence under a held control says it is and to wait
   * until it is done, which told somebody to wait for a Bot that was waiting for them, for as long
   * as the question stood (review of pull request 112). The question is the server's and is drawn
   * again by the page a reload brings.
   */
  const { bots } = useMyBots();
  const presence = usePresence(bots?.[0]?.id);
  const offer = updateOffer({
    ...facts,
    isBotBusy: shellStatusOf(presence.kind) === "working",
  });
  const [isRestarting, setIsRestarting] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);

  if (offer.kind === "none") return null;

  const isWithheld = offer.isHeld || isRestarting;
  const handlePress = async () => {
    if (isWithheld) return;
    if (offer.kind === "reload") {
      reloadIntoNewBuild();
      return;
    }
    setIsRestarting(true);
    setHasFailed(false);
    // Nothing after a success runs: the page goes with the process.
    const isRestarted = await restartToUpdate();
    if (!isRestarted) {
      setIsRestarting(false);
      setHasFailed(true);
    }
  };

  const { phrase, action, reason } = wordsOf(offer, {
    isRestarting,
    hasFailed,
  });

  if (shape === "icon") {
    /*
     * 64px has room for the icon and none for a sentence, so the sentence is the button's name and
     * its tooltip: what there is, or why it cannot be pressed yet. `aria-disabled`, not `disabled`:
     * a disabled button takes no hover and no focus, and the reason would be unreachable.
     */
    const name = reason ?? [phrase, action].filter(Boolean).join(" · ");
    return (
      <div
        className={cn("flex justify-center", className)}
        data-update-notice={offer.kind}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-disabled={isWithheld || undefined}
                aria-label={name}
                className={cn(
                  buttonVariants({ size: "icon-lg", variant: "ghost" }),
                  isWithheld
                    ? "text-muted-foreground opacity-60"
                    : "text-primary",
                )}
                onClick={handlePress}
                type="button"
              />
            }
          >
            <IconRefresh className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="right">{name}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div
      className={cn("flex flex-col", className)}
      data-update-notice={offer.kind}
    >
      {/*
       * ROOM FOR BOTH WORDS AT 216px, by arithmetic and not yet by eye: the column leaves the row
       * 183px, and the icon, 새 버전이 있어요 at 13px and 새로고침 at 12px come to 174 at their
       * widest (a Hangul glyph taken as its full em). At 13px and the wider gap it was 182 — one
       * rounding from an ellipsis. The phrase still truncates rather than push the press out.
       */}
      <Button
        className="h-9 w-full justify-start gap-1.5 rounded-lg px-2 font-normal text-sm"
        disabled={isWithheld}
        onClick={handlePress}
        variant="ghost"
      >
        <IconRefresh
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0",
            isWithheld ? "text-muted-foreground" : "text-primary",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-left">{phrase}</span>
        {action ? (
          <span className="shrink-0 font-medium text-xs">{action}</span>
        ) : null}
      </Button>
      {/* Said in words, not left to a tooltip: a phone has no hover, and neither does a disabled button. */}
      {reason ? (
        <p className="px-2 pb-1 text-muted-foreground text-xs" role="status">
          {reason}
        </p>
      ) : null}
    </div>
  );
}
