import { isSameAsk } from "@shared/secret-ask";
import { IconHandStop } from "@tabler/icons-react";
import { useId, useState, useSyncExternalStore } from "react";
import { ApprovalRequest } from "@/components/channels/approval-request";
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
import { questionOn, watchQuestions } from "@/lib/approvals";
import { labelForCode, outcomeOf } from "@/lib/computer/browsing";
import { setScreenOpen } from "@/lib/computer/screen-panel";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { t } from "@/lib/i18n";
import { loginKeys } from "@/lib/logins/queries";
import { queryClient } from "@/query-client";
import { loginRefusalText } from "@/lib/logins/refusals";
import { BUSINESS_SITES } from "@/lib/sites/catalogue";
import { useServerOwnsTurn } from "@/lib/turns/answers";
import { skipOnServer } from "@/lib/turns/client";
import { cn } from "@/lib/utils";
import { pokeControl } from "./control-poll";
import {
  type ControlState,
  readControl,
  releaseControl,
  supplySecret,
} from "./take-the-wheel";
import { useControl } from "./use-control";

/**
 * THE BOT HANDING SOMETHING TO A PERSON, AS A CARD IN THE CONVERSATION — NEVER A POP-UP.
 *
 * Something done outside the Bot's screen — approving on a phone, confirming in an app — or a value
 * it must not be told: the Bot asks, and the ask sits in the conversation at the point it was made,
 * beside what the Bot was doing when it got stuck. It used to be a line inside the side pane, and
 * the pane opened itself to show it.
 *
 * Two answers, and each reaches the waiting call as a different fact:
 *  - 다 했어요 closes the request (`/control/release`), which is what the waiting call reads as done.
 *  - 건너뛰기 tells the call to go on without it (`help-skips.ts`), and clears the request too.
 *
 * And 화면 보기, to look at what the Bot is looking at. Never 직접 하기: nobody drives the Bot's
 * browser, on any surface (owner, 2026-10-09).
 *
 * A secret is asked for with a masked box instead of 다 했어요: the value goes straight into the page
 * and never into the conversation, the model, or anything that outlives this form.
 */
export function HelpCard({
  toolCallId,
  kind,
  said,
  ask,
  status,
  result,
}: {
  toolCallId: string;
  kind: "help" | "secret";
  /** The Bot's own words for what it needs: the reason, or the names of the card's boxes. */
  said: string | undefined;
  /** For a value: which ask this card is — its boxes, in order, and the snapshot they are of. */
  ask?: SecretAsk | undefined;
  status: "inProgress" | "executing" | "complete";
  result: string | undefined;
}) {
  /*
   * WHOSE COMPUTER, READ HERE AND NOT HANDED IN. The card was given its Bot by the renderer that
   * draws it, as `botId={bot.current}` — the holder a surface fills in an effect. That renderer is
   * registered once for as long as the screen is mounted, and CopilotKit draws it through a memo
   * that compares the call and nothing else, so the holder was read when the card was first drawn
   * and never again. Whenever the conversation was drawn afresh under a screen that had stayed —
   * the channel could not be read for a moment and then could — its cards were in the first commit,
   * before the surface had declared its Bot, and the holder still said the sentinel. Measured
   * 2026-10-05 through the real route (`conversation-return.test.tsx`): the card asked
   * `/api/computers/default/control`, was told there is no such Bot, and stood with no chip, no
   * buttons and, for a secret, no box, under a header saying 도움 필요, until the Bot's wait ran out.
   *
   * The declared Bot is state, and a card that reads it is drawn again when it is declared — the
   * memo above it has no say. Until then there is nobody to ask about and nothing to press.
   */
  const botId = useDeclaredBotId();
  /*
   * WAITING IS WHAT THE COMPUTER SAYS, NOT ONLY WHAT THIS TAB IS RUNNING.
   *
   * After a reload the call that asked is no longer running here — the SDK draws it `inProgress`,
   * with no result — while the computer still holds the request, and the header, which reads the
   * computer, still said 도움 필요 over a card with no buttons (0.5.4 QA). So an unfinished card
   * reads the computer too, and while its own request is open there it keeps its buttons: 다 했어요
   * and 건너뛰기 close that request. Once the request is closed the card stops saying it needs
   * anybody, and the header agrees.
   */
  const control = useControl(
    status === "complete" ? undefined : botId,
    status === "executing",
  );
  const serverOwned = useServerOwnsTurn();
  const isWaiting =
    status === "executing" ||
    (status === "inProgress" && isOwnRequestOpen(kind, said, control, ask));
  const [isPressing, setIsPressing] = useState(false);
  /*
   * ONE CARD, A BOX FOR EVERY VALUE (2026-10-10). The boxes are the SERVER's reading of the ask —
   * each by the control's own name on the page — and a computer or a server from before a card
   * held several says one, the way it always has.
   */
  const boxes = boxesOf(kind === "secret" ? control : null);
  /** Held only until it is sent. Never lifted into a URL, a log, or anything that outlives this form. */
  const [typed, setTyped] = useState<readonly string[]>([]);
  const values = boxes.map((_, index) => typed[index] ?? "");
  const isAnswered = values.every((value) => value !== "");
  const [secretProblem, setSecretProblem] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const secretFieldId = useId();
  /*
   * KEEPING WHAT IS TYPED AS A SAVED LOGIN (2026-10-10, record §6, piece 2-6). Offered only where
   * the server said the card is one that can be kept — a sign-in nothing is saved for yet — and
   * off until the person ticks it. What became of it is said under the card, where it stays after
   * the boxes have gone.
   */
  const isSavable = kind === "secret" && control?.secretInto?.savable === true;
  const [isKeeping, setIsKeeping] = useState(false);
  const [keptNote, setKeptNote] = useState<string | null>(null);

  const ending = status === "complete" ? endingOf(result) : null;
  /*
   * A REFUSAL IS SAID AS WHAT IT WAS. Asking for a value is decided by the gateway now, so its
   * call can end the way any act's can: a rule of the deployment's refused it, or the person
   * answered the question about it with a no. Both arrived here as a result that is not ok, and
   * were chipped "Didn't work" — over a request nobody tried and failed at.
   */
  const outcome = status === "complete" ? outcomeOf(result) : null;
  const refusedAs =
    outcome?.refused === true
      ? labelForCode(outcome.code, undefined)
      : undefined;

  const handleDone = async () => {
    if (!botId) return;
    setIsPressing(true);
    await releaseControl(botId).catch(() => null);
    setIsPressing(false);
    pokeControl(botId);
  };

  /*
   * 건너뛰기, TOLD TO THE CALL THAT IS WAITING FOR THE ANSWER. The computer has two answers to a
   * request: it is closed (`/control/release`), or a person types the secret in. Neither says "skip
   * this". Closing is how a skip clears the request on the computer — the next
   * request has to find it clear — but the call waiting on it would read that as "done", and tell
   * the model a login it never got had happened. So the skip is sent to the turn first, by the
   * call's id, and its wait reads it before the release that follows (`server/src/turns/people.ts`).
   * Only inside a conversation: drawn anywhere else there is no turn waiting to be told.
   */
  const handleSkip = async () => {
    if (!botId) return;
    if (serverOwned) await skipOnServer(botId, toolCallId);
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
            {ending ? (refusedAs ?? endingLabel(ending)) : t("Needs you")}
          </span>
        ) : null}
      </div>

      {said ? <p className="text-pretty ps-6">{said}</p> : null}

      {/* The masked box: only while the computer is actually waiting for this value. */}
      {kind === "secret" && isWaiting && boxes.length > 0 ? (
        <form
          className="flex flex-col gap-1.5 ps-6"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!botId || !isAnswered || isSending) return;
            setIsSending(true);
            const keeping = isSavable && isKeeping;
            const sent = await supplySecret(
              botId,
              values,
              keeping
                ? { label: loginNameFor(control?.secretInto?.host ?? "") }
                : undefined,
            );
            setIsSending(false);
            // Cleared even on failure, so the plaintext is not left in the page.
            setTyped([]);
            setSecretProblem(sent.ok ? null : (sent.error ?? null));
            if (sent.ok && keeping) {
              setKeptNote(
                sent.loginSaved
                  ? t(
                      "Saved to Accounts. Your Bot signs in here itself next time.",
                    )
                  : loginRefusalText(sent.loginRefused ?? ""),
              );
              // 계정's list and 연결's rows read the same list: it has one more now.
              if (sent.loginSaved) {
                void queryClient.invalidateQueries({ queryKey: loginKeys.all });
              }
            }
            await readControl(botId);
            pokeControl(botId);
          }}
        >
          {boxes.map((box, index) => (
            <div className="flex flex-col gap-1" key={box.ref || index}>
              <label
                className="text-muted-foreground text-xs"
                htmlFor={`${secretFieldId}-${index}`}
              >
                {box.site
                  ? t("Goes into {field} on {site}", {
                      field: box.name || box.label,
                      site: box.site,
                    })
                  : box.label}
              </label>
              <input
                autoComplete="off"
                autoCorrect="off"
                className={`min-w-0 rounded-md border bg-background px-2 py-1 text-sm ${focusRing}`}
                id={`${secretFieldId}-${index}`}
                onChange={(event) =>
                  setTyped(
                    boxes.map((_, at) =>
                      at === index ? event.target.value : (typed[at] ?? ""),
                    ),
                  )
                }
                placeholder={t("Typed here, never shown to the Bot")}
                spellCheck={false}
                type="password"
                value={values[index] ?? ""}
              />
            </div>
          ))}
          {isSavable ? (
            <label className="flex items-center gap-2 text-xs">
              <input
                checked={isKeeping}
                className="size-3.5 accent-foreground"
                disabled={isSending}
                onChange={(event) => setIsKeeping(event.target.checked)}
                type="checkbox"
              />
              {t("Save this login for next time")}
            </label>
          ) : null}
          {/* One press for the whole card, and only once every box holds something. */}
          <div className="flex">
            <Button disabled={!isAnswered || isSending} size="sm" type="submit">
              {isSending ? t("Sending…") : t("Send to the page")}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            {t(
              "This goes straight to the page. It is not shown in the conversation and the Bot never receives it.",
            )}
          </p>
        </form>
      ) : null}

      {/*
       * WHY A VALUE DID NOT GO THROUGH, KEPT AFTER THE BOX HAS GONE. The computer closes the request
       * when the value cannot be put in its field, so the box left the card in the same moment the
       * failure arrived — and this line was inside the box's form: a person pressed 보내기, the
       * box vanished, and nothing said the value had gone nowhere. Mounted with the card rather
       * than with the box, so it stays, and so it is heard as it is said (`LiveRegion`).
       */}
      {kind === "secret" ? (
        <LiveRegion
          as="p"
          className="ps-6 text-destructive text-xs"
          tone="alert"
        >
          {secretProblem}
        </LiveRegion>
      ) : null}

      {/* What became of the tick: kept, or why not. Under the card for the same reason. */}
      {kind === "secret" && keptNote ? (
        <p className="ps-6 text-muted-foreground text-xs">{keptNote}</p>
      ) : null}

      {isWaiting ? (
        <div className="flex flex-wrap gap-2 ps-6">
          {/*
           * NO 직접 하기 (owner, 2026-10-09): nobody drives the Bot's browser. A hand is something
           * done outside its screen — a phone to approve on, an app to confirm in — and then said
           * done here. The screen is still there to look at.
           */}
          {kind === "help" ? (
            <Button
              disabled={isPressing || !botId}
              onClick={() => void handleDone()}
              size="sm"
            >
              {t("I'm done")}
            </Button>
          ) : null}
          <Button
            onClick={() => setScreenOpen(true)}
            size="sm"
            variant="outline"
          >
            {t("View screen")}
          </Button>
          <Button
            disabled={isPressing || !botId}
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
 * THE BOT'S REQUEST FOR A VALUE — AND, WHERE A RULE ASKED ONE, THE QUESTION ABOUT MAKING IT.
 *
 * Asking for a value is decided by the gateway like any act of the Bot's (2026-10-10), so a
 * deployment's rule can put a question in front of it: may the Bot ask you for a value on this
 * site? Every other act's question is drawn on the line for its call (`computer-tools.tsx`,
 * `ActionLine`; the browsing card). This call has a card of its own and had no line, so its
 * question was drawn nowhere — the conversation said it was waiting for an answer and offered no
 * way to give one (Codex's second read of that change).
 *
 * WHILE THE QUESTION IS OPEN IT IS THE ONLY CARD. The masked box is not wanted yet — nothing has
 * asked the computer for a value — and a second card saying "needs you" beside the question,
 * with a 건너뛰기 that skips a wait the turn has not reached, would be two things to answer where
 * there is one. Answered, the question goes and the request's own card takes its place.
 */
export function SecretRequestCard(
  props: Omit<Parameters<typeof HelpCard>[0], "kind">,
) {
  const isAsked = useSyncExternalStore(
    watchQuestions,
    () => questionOn(props.toolCallId) !== undefined,
  );
  if (isAsked && props.status !== "complete") {
    return <ApprovalRequest toolCallId={props.toolCallId} />;
  }
  return <HelpCard kind="secret" {...props} />;
}

/**
 * Whether the computer still holds THIS card's request: the reason, or the secret's label, is the
 * one the Bot wrote on it. The computer trims what it keeps (`agent-computer/src/control.ts`).
 *
 * Matched rather than assumed, so an old card left unfinished by a reload days ago does not grow
 * buttons for somebody else's request.
 */
export function isOwnRequestOpen(
  kind: "help" | "secret",
  said: string | undefined,
  control: ControlState | null,
  ask?: SecretAsk,
): boolean {
  if (!control) return false;
  if (kind === "help") {
    const asked = said?.trim();
    return !!asked && control.requested && control.reason === asked;
  }
  /*
   * A VALUE'S CARD IS KNOWN BY ITS BOXES, NOT BY ITS WORDS (2026-10-10). This compared the label
   * the model wrote with the one the computer holds — which the server has tidied on the way
   * (one line, bounded), so a label with a line break in it never matched its own card. The boxes
   * and the snapshot they are of are exact, and are what a value says it answers
   * (`@shared/secret-ask`).
   */
  if (!ask || !control.secretWanted) return false;
  const refs =
    control.secretFields?.map((field) => field.ref) ??
    (control.secretRef ? [control.secretRef] : []);
  return isSameAsk({ refs, snapshotId: control.secretSnapshotId }, ask);
}

/** Which ask a card for a value is: its boxes, in order, and the snapshot they are of. */
export type SecretAsk = { refs: readonly string[]; snapshotId?: number };

/** A box of the card as it is drawn: what to call it, and whose page it is on when that is known. */
type SecretBox = { ref: string; label: string; name: string; site?: string };

/**
 * The boxes to draw for the value the computer is waiting for: every one the server resolved, or
 * — from a server or a computer that says only one — that one, as it has always been drawn.
 */
/**
 * What a login kept from the card is called, until the person renames it in 계정: the site's
 * name where the address is one site's own, and the address otherwise. An id provider several
 * sites sign in at (`nid.naver.com`) is nobody's alone, and is called by its address.
 */
function loginNameFor(host: string): string {
  const sites = BUSINESS_SITES.filter((site) =>
    [...site.hosts, ...(site.signInHosts ?? [])].includes(host),
  );
  const [only] = sites;
  return sites.length === 1 && only ? t(only.name) : host;
}

function boxesOf(control: ControlState | null): SecretBox[] {
  if (!control?.secretWanted) return [];
  const into = control.secretInto;
  if (into?.fields?.length) {
    return into.fields.map((field) => ({
      ref: field.ref,
      label: field.label,
      name: field.name,
      site: into.host,
    }));
  }
  return [
    {
      ref: control.secretRef ?? "",
      label: control.secretWanted,
      name: into?.element.name ?? "",
      ...(into ? { site: into.host } : {}),
    },
  ];
}

type HelpEnding =
  | "done"
  | "entered"
  /** A login the person saved for the site answered: nobody typed, and nobody was asked. */
  | "saved"
  /** The site has several saved logins and the Bot has to say which: nothing went in yet. */
  | "several"
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
    case "laf:login_filled":
      return "saved";
    case "laf:login_choice":
      return "several";
    case "laf:help_skipped":
    case "laf:secret_skipped":
      return "skipped";
    case "laf:nobody_took_control":
    case "laf:secret_not_entered":
      return "unanswered";
    case "laf:request_cancelled":
    case "laf:stopped":
      return "stopped";
    // Somebody came, and the page was not what the card said: not "done", which is how an
    // ending this did not know was drawn.
    case "laf:secret_not_filled":
      return "failed";
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
    case "saved":
      return t("From a saved login");
    case "several":
      return t("Several saved logins");
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
