import {
  IconBrowser,
  IconChevronDown,
  IconClockX,
  IconShieldCheck,
  IconShieldX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState, useSyncExternalStore } from "react";
import { ApprovalRequest } from "@/components/channels/approval-request";
import type { BrowsingItem } from "@/components/channels/chat-messages";
import { ToolLine } from "@/components/channels/tool-line";
import { LiveRegion } from "@/components/layout/live-region";
import { SectionBoundary } from "@/components/layout/section-boundary";
import { Button } from "@/components/ui/button";
import {
  chatCard,
  chatCardMeta,
  chatCardTitle,
} from "@/components/ui/card-surface";
import {
  type ApprovalDecision,
  decisionOn,
  decisionPhrase,
  questionOn,
  watchQuestions,
} from "@/lib/approvals";
import {
  endingOf,
  pictureStepOf,
  sitesOf,
  stepLine,
} from "@/lib/computer/browsing";
import { framedCallsQueryOptions } from "@/lib/channels/queries";
import { useBrowsingNow } from "@/lib/computer/browsing-now";
import { frameAddress, useFrameVersion } from "@/lib/computer/last-frame";
import { setScreenOpen, useScreenPanel } from "@/lib/computer/screen-panel";
import {
  canRetry,
  type TaskState,
  taskStateLine,
} from "@/lib/computer/task-state";
import { useConversation } from "@/lib/copilot/conversation";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { FrameCanvas, useLiveFrame } from "./live-thumbnail";
import { plainLine, plainText, taskTitle } from "./task-title";

/**
 * ONE BROWSING TASK, AS ONE CARD: WHERE THE BOT WENT, WHAT IT DID, AND WHAT IT LAST SAW.
 *
 * It replaces a line per browser call and a live screen per page opened — four screens for a Bot
 * that checked the weather, each polling once a second. The card stays in the conversation after
 * the task, so scrolling back shows what was done, and its picture is the last thing the browser
 * showed (`last-frame.ts`) — which is also what a person has left when the Bot closes the page.
 *
 * 화면 보기 opens the live screen, and only the newest card offers it: the live screen shows the
 * Bot's browser as it is now, which is where the newest task left it and nowhere an older card was.
 * When the live screen has looked and found no page, the newest card says so instead.
 */
type BrowsingCardProps = {
  item: BrowsingItem;
  /** Where the kept picture is read from. Absent on a screen with no channel: no picture. */
  channelId: string | undefined;
  /** The task is still being done. */
  isOpen: boolean;
  /** The last task in the conversation: the one the live screen would show. */
  isNewest: boolean;
};

export function BrowsingCard(props: BrowsingCardProps) {
  return (
    <div className="flex flex-col gap-2">
      {/*
       * A question about any step of the task, above the card and not inside the folded list: a
       * person deciding whether to allow a click must not have to unfold anything to find the
       * buttons. Each renders nothing unless that exact call raised a question.
       *
       * And outside the card's seam below, so a card that failed to draw does not take with it the
       * one question the Bot is waiting on.
       */}
      {props.item.steps.map((step) => (
        <ApprovalRequest key={step.id} toolCallId={step.id} />
      ))}
      {/*
       * THE CARD FAILS ALONE. It draws from browser calls while they are still arriving, and with
       * no seam of its own a card that threw took the whole transcript with it. The seam adds no
       * element while the card is well, so the card and its steps stay children of this column.
       */}
      <SectionBoundary className={chatCard} section="computer">
        <TaskCard {...props} />
      </SectionBoundary>
    </div>
  );
}

function TaskCard({ item, channelId, isOpen, isNewest }: BrowsingCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const stepsId = useId();
  const botId = useDeclaredBotId();
  const now = useBrowsingNow();
  const conversation = useConversation();
  /*
   * A step of this task is waiting on the person — an approval above the card. Subscribed, so the
   * card says so the moment it is asked and stops the moment it is answered.
   */
  const isAsking = useSyncExternalStore(watchQuestions, () =>
    item.steps.some((step) => questionOn(step.id) !== undefined),
  );
  /*
   * ONE STATE, FROM FACTS (`task-state.ts`): the words the banner, 오늘 and the drawer use too. A
   * question open on a step is the owner's turn, whatever the steps say.
   */
  const state: TaskState = isAsking
    ? { kind: "yourTurn" }
    : endingOf(item.steps, isOpen);
  const pictureStep = isOpen ? null : pictureStepOf(item.steps);
  const version = useFrameVersion(pictureStep);
  const framed = useQuery({
    ...framedCallsQueryOptions(channelId ?? ""),
    enabled: channelId !== undefined && !isOpen,
  });
  /*
   * Asked for only where there is one: kept by this tab, or listed by the server. Every ended card
   * used to ask, and a task with no picture was a 404 in the console each time (0.5.4 QA).
   */
  const hasFrame =
    pictureStep !== null &&
    (version > 0 || framed.data?.has(pictureStep) === true);
  const isPageGone = botId !== undefined && now.pageGoneFor === botId;
  /*
   * NOT ON A FAILED TASK WITH NO PICTURE. Measured (UX review 0.5.4, item 3): a task that failed
   * because the browser was down offered 화면 보기, which opened on nothing and then said the picture
   * beside it was the last screen, beside an empty placeholder. There is nothing to show there.
   */
  const canView =
    isNewest &&
    botId !== undefined &&
    !isPageGone &&
    !(state.kind === "failed" && !hasFrame);
  const asked = item.asked;
  const canAskAgain =
    canRetry(state) && asked !== undefined && conversation !== null;
  const title = taskTitle(sitesOf(item.steps), item.asked);
  const latest = item.notes.at(-1);

  const picture = (
    <TaskPicture
      botId={botId}
      channelId={channelId}
      hasFrame={hasFrame}
      isOpen={isOpen}
      toolCallId={pictureStep}
      version={version}
    />
  );

  return (
    <>
      <div className={cn(chatCard, "flex gap-3 p-2.5")}>
        {canView ? (
          <button
            aria-label={t("View the Bot's screen")}
            className="shrink-0 cursor-zoom-in rounded-lg"
            onClick={() => setScreenOpen(true)}
            type="button"
          >
            {picture}
          </button>
        ) : (
          <div className="shrink-0">{picture}</div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Two lines, not one: at 375px one line held the site and three words of the task. */}
          <p className={cn(chatCardTitle, "line-clamp-2 break-words")}>
            {title ?? t("The Bot's browser")}
          </p>
          {/*
           * The newest thing the Bot said while doing this, one line: what it is up to, in its own
           * words. The rest of what it said is under 한 일, where it was said.
           */}
          {latest ? (
            <p className={cn(chatCardMeta, "truncate")}>
              {plainLine(latest.text)}
            </p>
          ) : null}
          {/*
           * No count of steps. "완료 · 3단계" asked somebody to care how many calls a task took, which
           * is the one number about it that means nothing to them.
           */}
          <p
            className={cn(
              "text-xs",
              state.kind === "yourTurn"
                ? "font-medium text-warning"
                : state.kind === "failed"
                  ? "text-warning"
                  : "text-muted-foreground",
            )}
          >
            {taskStateLine(state)}
          </p>
          <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
            {/*
             * 다시 해 보기: the owner's own words again, as if typed. Measured (UX review 0.5.4,
             * item 3): after a failed task the Bot said "다시 시도해 달라고 해 주시면", and the owner
             * had to type the whole request out a second time.
             */}
            {canAskAgain ? (
              <Button
                onClick={() => conversation.ask(asked)}
                size="xs"
                variant="secondary"
              >
                {t("Try it again")}
              </Button>
            ) : null}
            {canView ? (
              <Button
                onClick={() => setScreenOpen(true)}
                size="xs"
                variant="secondary"
              >
                {t("View screen")}
              </Button>
            ) : null}
            {/* Mounted with the card, so the page going away is heard when it is said. */}
            <LiveRegion as="span" className="text-muted-foreground text-xs">
              {!canView && isNewest && isPageGone && !isOpen
                ? hasFrame
                  ? t("No page is open now. The picture is the last one.")
                  : t("No page is open now.")
                : null}
            </LiveRegion>
            <Button
              aria-controls={stepsId}
              aria-expanded={isExpanded}
              onClick={() => setIsExpanded((was) => !was)}
              size="xs"
              variant="ghost"
            >
              {t("What it did")}
              <IconChevronDown
                aria-hidden="true"
                className={`transition-transform ${isExpanded ? "rotate-180" : ""}`}
              />
            </Button>
          </div>
        </div>
      </div>
      <div
        className="flex max-w-md flex-col pl-3"
        hidden={!isExpanded}
        id={stepsId}
      >
        {isExpanded
          ? item.steps.map((step, index) => {
              const line = stepLine(step);
              return (
                <Fragment key={step.id}>
                  {/* What the Bot said before this step, where it said it. */}
                  {item.notes
                    .filter((note) => note.after === index)
                    .map((note) => (
                      <p
                        className="my-1 whitespace-pre-wrap break-words border-l-2 pl-2 text-muted-foreground text-sm"
                        key={note.id}
                      >
                        {plainText(note.text)}
                      </p>
                    ))}
                  <ToolLine
                    detail={line.detail}
                    failed={line.failed}
                    kind="browser"
                    label={line.label}
                    refused={line.refused}
                    running={line.running}
                  />
                  <StepDecision toolCallId={step.id} />
                </Fragment>
              );
            })
          : null}
      </div>
    </>
  );
}

const DECIDED_ICONS: Record<ApprovalDecision["outcome"], typeof IconClockX> = {
  allowed: IconShieldCheck,
  declined: IconShieldX,
  unanswered: IconClockX,
};

/**
 * What the person answered about this step, in the list of what the Bot did, where it happened.
 *
 * The approval card above the card folds into this same line once it is answered (package C,
 * `approval-request.tsx`); a turn is one card now, and a person reading 한 일 back should see "거부함
 * · toss.im에서 ‘비즈니스’ 누르기" beside the click it was about, not only in a stack above the card.
 * The words are the approvals' own (`decisionPhrase`), so the two lines cannot say different things.
 */
function StepDecision({ toolCallId }: { toolCallId: string }) {
  const decision = useSyncExternalStore(watchQuestions, () =>
    decisionOn(toolCallId),
  );
  if (!decision) return null;
  const Icon = DECIDED_ICONS[decision.outcome];
  const said = decisionPhrase(decision);
  return (
    <p className="flex items-start gap-1.5 py-0.5 pl-5 text-muted-foreground text-xs">
      <Icon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 wrap-break-word">
        {t(said.key, said.params)}
      </span>
    </p>
  );
}

/**
 * The task's picture: the page as it is now while the task runs, its last picture once it ended, or
 * a quiet browser mark where there is none.
 *
 * None is normal for an ended task: one from before pictures were kept never had one, and one that
 * ended while a person held the wheel was deliberately not taken. Keyed by the version this tab
 * kept, so a card that asked a moment too early asks again once it is there.
 */
function TaskPicture({
  botId,
  channelId,
  hasFrame,
  toolCallId,
  isOpen,
  version,
}: {
  botId: string | undefined;
  channelId: string | undefined;
  hasFrame: boolean;
  toolCallId: string | null;
  isOpen: boolean;
  version: number;
}) {
  return (
    <span className="relative flex aspect-[16/10] w-28 items-center justify-center overflow-hidden rounded-lg bg-muted sm:w-36">
      <IconBrowser
        aria-hidden="true"
        className={`size-5 text-muted-foreground/60 ${isOpen ? "animate-pulse" : ""}`}
      />
      {isOpen ? (
        <RunningPicture botId={botId} />
      ) : channelId && toolCallId && hasFrame ? (
        <FrameImage
          key={version}
          src={`${frameAddress(channelId, toolCallId)}?v=${version}`}
        />
      ) : null}
    </span>
  );
}

/**
 * The page now, from the poll the banner reads (`live-thumbnail.tsx`), so the card of a task being
 * done shows what the banner above it shows instead of an empty frame. Paused with the banner's
 * while the live screen is open.
 */
function RunningPicture({ botId }: { botId: string | undefined }) {
  const { isOpen: isScreenOpen } = useScreenPanel();
  return <FrameCanvas frame={useLiveFrame(botId, isScreenOpen)} />;
}

function FrameImage({ src }: { src: string }) {
  const [hasFailed, setHasFailed] = useState(false);
  if (hasFailed) return null;
  return (
    <img
      alt={t("What the Bot's browser showed last")}
      className="absolute inset-0 h-full w-full object-cover object-top"
      decoding="async"
      loading="lazy"
      onError={() => setHasFailed(true)}
      src={src}
    />
  );
}
