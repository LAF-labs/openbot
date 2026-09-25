import { IconHandStop } from "@tabler/icons-react";
import { useId, useState } from "react";
import { LiveRegion } from "@/components/layout/live-region";
import { Button } from "@/components/ui/button";
import {
  chatCard,
  chatCardChip,
  chatCardPadding,
  chatCardTitle,
  chatCardWaiting,
} from "@/components/ui/card-surface";
import { focusRing } from "@/components/ui/focus";
import { outcomeOf } from "@/lib/computer/browsing";
import { skipHelp } from "@/lib/computer/help-skips";
import {
  setScreenOpen,
  useScreenPanelViewport,
} from "@/lib/computer/screen-panel";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { pokeControl } from "./control-poll";
import {
  type ControlState,
  readControl,
  releaseControl,
  supplySecret,
  takeControl,
} from "./take-the-wheel";
import { useControl } from "./use-control";

/**
 * THE BOT HANDING SOMETHING TO A PERSON, AS A CARD IN THE CONVERSATION — NEVER A POP-UP.
 *
 * A login, a code sent to a phone, a captcha, a password it must not be told: the Bot asks, and the
 * ask sits in the conversation at the point it was made, beside what the Bot was doing when it got
 * stuck. It used to be a line inside the side pane, and the pane opened itself to show it.
 *
 * Three answers, and each one reaches the waiting call as a different fact:
 *  - 직접 하기 takes the wheel and opens the live screen, where the person does it themselves.
 *  - 다 했어요 hands the wheel back (`/control/release`), which is what the waiting call reads as done.
 *  - 건너뛰기 tells the call to go on without it (`help-skips.ts`), and clears the request too.
 *
 * A secret is asked for with a masked box instead of 다 했어요: the value goes straight into the page
 * and never into the conversation, the model, or anything that outlives this form.
 */
export function HelpCard({
  botId,
  toolCallId,
  kind,
  said,
  status,
  result,
}: {
  botId: string;
  toolCallId: string;
  kind: "help" | "secret";
  /** The Bot's own words for what it needs: the reason, or the secret's label. */
  said: string | undefined;
  status: "inProgress" | "executing" | "complete";
  result: string | undefined;
}) {
  /*
   * WAITING IS WHAT THE COMPUTER SAYS, NOT ONLY WHAT THIS TAB IS RUNNING.
   *
   * After a reload the call that asked is no longer running here — the SDK draws it `inProgress`,
   * with no result — while the computer still holds the request, and the header, which reads the
   * computer, still said 도움 필요 over a card with no buttons (0.5.4 QA). So an unfinished card
   * reads the computer too, and while its own request is open there it keeps its buttons: 다 했어요
   * and 건너뛰기 close that request, and 직접 하기 still hands over the browser. Once the request
   * is closed the card stops saying it needs anybody, and the header agrees.
   */
  const control = useControl(
    status === "complete" ? undefined : botId,
    status === "executing",
  );
  const isWaiting =
    status === "executing" ||
    (status === "inProgress" && isOwnRequestOpen(kind, said, control));
  const { isWide } = useScreenPanelViewport();
  const [isPressing, setIsPressing] = useState(false);
  /** Held only until it is sent. Never lifted into a URL, a log, or anything that outlives this form. */
  const [secret, setSecret] = useState("");
  const [secretProblem, setSecretProblem] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const secretFieldId = useId();
  const isDriving = control?.holder === "human";

  const ending = status === "complete" ? endingOf(result) : null;

  const handleTakeOver = async () => {
    setIsPressing(true);
    const state = await takeControl(botId).catch(() => null);
    setIsPressing(false);
    pokeControl(botId);
    if (state?.holder === "human") setScreenOpen(true);
  };

  const handleDone = async () => {
    setIsPressing(true);
    await releaseControl(botId).catch(() => null);
    setIsPressing(false);
    pokeControl(botId);
  };

  const handleSkip = async () => {
    // The skip first: the release below is read by the waiting call as "done" unless it knows.
    skipHelp(toolCallId);
    await handleDone();
  };

  return (
    <div
      className={cn(
        chatCard,
        chatCardPadding,
        "flex flex-col gap-2 text-sm",
        isWaiting && chatCardWaiting,
      )}
      // How the header's drawer finds the request it lists, while it is one.
      data-waiting-card={isWaiting ? "help" : undefined}
    >
      {/*
       * THE ASK IS HEARD WHEN THE BOT STARTS WAITING. The card is drawn as the call begins and only
       * turns into a request once the call is waiting on somebody; the pill that says so changed
       * without a sound, the way a permission question did before `approval-request.tsx` spoke.
       * Polite, for the same reason as there: a question waits for a natural break.
       */}
      <LiveRegion className="sr-only">
        {isWaiting
          ? `${kind === "secret" ? t("The Bot needs a value it must not see") : t("The Bot needs your help")}${said ? `: ${said}` : ""}`
          : null}
      </LiveRegion>
      <div className="flex items-center justify-between gap-2">
        <span className={cn(chatCardTitle, "flex min-w-0 items-center gap-2")}>
          <IconHandStop
            aria-hidden="true"
            className={`size-4 shrink-0 ${isWaiting ? "text-warning" : "text-muted-foreground"}`}
          />
          <span className="truncate">
            {kind === "secret"
              ? t("The Bot needs a value it must not see")
              : t("The Bot needs your help")}
          </span>
        </span>
        {/*
         * Nothing while it is neither waiting nor ended: a call still being written, or one a reload
         * left unfinished whose request the computer no longer holds. 도움 필요 there was the card
         * disagreeing with the header.
         */}
        {ending || isWaiting ? (
          <span
            className={cn(
              chatCardChip,
              isWaiting
                ? "bg-warning/12 text-warning"
                : "bg-muted text-muted-foreground",
            )}
          >
            {ending ? endingLabel(ending) : t("Needs you")}
          </span>
        ) : null}
      </div>

      {said ? <p className="text-pretty ps-6">{said}</p> : null}

      {/* The masked box: only while the computer is actually waiting for this value. */}
      {kind === "secret" && isWaiting && control?.secretWanted ? (
        <form
          className="flex flex-col gap-1.5 ps-6"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!secret || isSending) return;
            setIsSending(true);
            const sent = await supplySecret(botId, secret);
            setIsSending(false);
            // Cleared even on failure, so the plaintext is not left in the page.
            setSecret("");
            setSecretProblem(sent.ok ? null : (sent.error ?? null));
            await readControl(botId);
            pokeControl(botId);
          }}
        >
          <label
            className="text-muted-foreground text-xs"
            htmlFor={secretFieldId}
          >
            {control.secretInto
              ? t("Goes into {field} on {site}", {
                  field:
                    control.secretInto.element.name || control.secretWanted,
                  site: control.secretInto.host,
                })
              : control.secretWanted}
          </label>
          <div className="flex gap-2">
            <input
              autoComplete="off"
              autoCorrect="off"
              className={`min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm ${focusRing}`}
              id={secretFieldId}
              onChange={(event) => setSecret(event.target.value)}
              placeholder={t("Typed here, never shown to the Bot")}
              spellCheck={false}
              type="password"
              value={secret}
            />
            <Button disabled={!secret || isSending} size="sm" type="submit">
              {isSending ? t("Sending…") : t("Send to the page")}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            {t(
              "This goes straight to the page. It is not shown in the conversation and the Bot never receives it.",
            )}
          </p>
          {/* Mounted with the box, so a value that did not go through is heard as it is said. */}
          <LiveRegion as="p" className="text-destructive text-xs" tone="alert">
            {secretProblem}
          </LiveRegion>
        </form>
      ) : null}

      {/* Mounted with the card, so taking the wheel is heard when it is said (`LiveRegion`). */}
      <LiveRegion as="p" className="ps-6 text-muted-foreground text-xs">
        {isWaiting && isDriving
          ? t("You have the browser. Press I'm done when you are finished.")
          : null}
      </LiveRegion>

      {isWaiting ? (
        <div className="flex flex-wrap gap-2 ps-6">
          {/* On a wide screen only: driving a page by touch has not been measured yet. */}
          {isWide && !isDriving ? (
            <Button
              disabled={isPressing}
              onClick={() => void handleTakeOver()}
              size="sm"
            >
              {t("Do it myself")}
            </Button>
          ) : null}
          {isDriving ? (
            <Button
              onClick={() => setScreenOpen(true)}
              size="sm"
              variant="outline"
            >
              {t("View screen")}
            </Button>
          ) : null}
          {kind === "help" || isDriving ? (
            <Button
              disabled={isPressing}
              onClick={() => void handleDone()}
              size="sm"
              variant={isDriving ? "default" : "secondary"}
            >
              {t("I'm done")}
            </Button>
          ) : null}
          <Button
            disabled={isPressing}
            onClick={() => void handleSkip()}
            size="sm"
            title={t("The Bot carries on without this step")}
            variant="ghost"
          >
            {t("Skip")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Whether the computer still holds THIS card's request: the reason, or the secret's label, is the
 * one the Bot wrote on it. The computer trims what it keeps (`agent-computer/src/control.ts`).
 *
 * Matched rather than assumed, so an old card left unfinished by a reload days ago does not grow
 * buttons for somebody else's request.
 *
 * A request the person has taken the wheel for is no longer "requested", but it is still open: the
 * Bot's call waits for the hand-back, and the computer keeps the reason while the person holds the
 * wheel. MEASURED 2026-09-25 (0.5.4 final QA): the window that was driving went away without
 * handing back, and after a reload the card had no buttons, the header said 쉬는 중, and the only
 * way back was the screen icon nobody would think to press — the Bot waited behind it. So a card
 * whose words the person is holding the wheel for keeps 직접 하기 (back into the screen), 다 했어요
 * and 건너뛰기.
 */
export function isOwnRequestOpen(
  kind: "help" | "secret",
  said: string | undefined,
  control: ControlState | null,
): boolean {
  const asked = said?.trim();
  if (!control || !asked) return false;
  return kind === "help"
    ? (control.requested || control.holder === "human") &&
        control.reason === asked
    : control.secretWanted === asked;
}

type HelpEnding =
  | "done"
  | "entered"
  | "skipped"
  | "unanswered"
  | "stopped"
  | "failed";

/** How the request ended, from the code its call returned. */
function endingOf(result: string | undefined): HelpEnding {
  const outcome = outcomeOf(result);
  switch (outcome.code) {
    case "laf:control_returned":
      return "done";
    case "laf:secret_entered":
      return "entered";
    case "laf:help_skipped":
    case "laf:secret_skipped":
      return "skipped";
    case "laf:nobody_took_control":
    case "laf:secret_not_entered":
      return "unanswered";
    case "laf:request_cancelled":
    case "laf:stopped":
      return "stopped";
    default:
      return outcome.ok === false ? "failed" : "done";
  }
}

function endingLabel(ending: HelpEnding): string {
  switch (ending) {
    case "done":
      return t("Done");
    case "entered":
      return t("Entered");
    case "skipped":
      return t("Skipped");
    case "unanswered":
      return t("No answer");
    case "stopped":
      return t("Stopped");
    case "failed":
      return t("Didn't work");
  }
}
