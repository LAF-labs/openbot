import { SITE_REFUSED } from "@shared/task-ending";
import {
  IconBrowser,
  IconChevronDown,
  IconClockX,
  IconRefresh,
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
  chatCardChip,
  chatCardChipLive,
  chatCardChipQuiet,
  chatCardChipSignal,
  chatCardMeta,
  chatCardPadding,
  chatCardTitle,
} from "@/components/ui/card-surface";
import { focusRingInset } from "@/components/ui/focus";
import { touchTall } from "@/components/ui/touch";
import {
  type ApprovalDecision,
  decisionOn,
  decisionPhrase,
  questionOn,
  watchQuestions,
} from "@/lib/approvals";
import { framedCallsQueryOptions } from "@/lib/channels/queries";
import {
  type CutOff,
  endingOf,
  lookedUpOf,
  pictureStepOf,
  sitesOf,
  stepLine,
} from "@/lib/computer/browsing";
import { useBrowsingNow } from "@/lib/computer/browsing-now";
import { frameAddress, useFrameVersion } from "@/lib/computer/last-frame";
import { setScreenOpen, useScreenPanel } from "@/lib/computer/screen-panel";
import {
  canRetry,
  type TaskState,
  taskStateDetail,
  taskStateWord,
} from "@/lib/computer/task-state";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { useConversation } from "@/lib/copilot/conversation";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { FrameCanvas, useLiveFrame } from "./live-thumbnail";
import { plainLine, plainText, taskHeading } from "./task-title";

/**
 * ONE BROWSING TASK: A CARD WHILE IT IS HAPPENING, AND ONE ROW ONCE IT IS OVER.
 *
 * It replaces a line per browser call and a live screen per page opened — four screens for a Bot
 * that checked the weather, each polling once a second. The task stays in the conversation after
 * it is done, so scrolling back shows what was done, and its picture is the last thing the browser
 * showed (`last-frame.ts`) — which is also what a person has left when the Bot closes the page.
 *
 * OVER, IT IS A ROW: THE SITE, HOW IT ENDED, AND A WAY IN. The owner, 2026-10-04: "불필요한 정보도
 * 보여주고 아이콘으로도 되는 걸 항상 글자로 표시하는 게 문제". A task that had ended stayed a whole
 * card — a chip, a title, a sentence, a picture, up to three buttons — so a morning of looking
 * things up was a column of cards with the answers somewhere between them. What somebody scrolling
 * back wants first is where the Bot went and whether it worked; the rest is the same card, one
 * press away, in place (`isFolded` in `TaskCard` is the whole rule).
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
  /** Its turn ended right after it, with nothing said: how (`CutOff`). */
  cutOff?: CutOff;
  /**
   * The Bot stopped right after it to ask the person for a hand, and is still waiting
   * (`isHandedToThePerson`): over by its steps, and not over to the person looking at it.
   */
  isHandedOver?: boolean;
  /**
   * The person opened it once it was over. Theirs, and kept by whoever draws the conversation for
   * as long as that is mounted (`chat-transcript.tsx`) — not here, where a task whose first step
   * arrives with the page above is drawn anew and would forget it.
   */
  isUnfolded: boolean;
  /** The row was pressed, or the head of the card it opened to: open it, or fold it back. */
  onFold: (isUnfolded: boolean) => void;
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

function TaskCard({
  item,
  channelId,
  isOpen,
  isNewest,
  cutOff = null,
  isHandedOver = false,
  isUnfolded,
  onFold,
}: BrowsingCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const stepsId = useId();
  const botId = useDeclaredBotId();
  const now = useBrowsingNow();
  const conversation = useConversation();
  const { isOpen: isScreenOpen } = useScreenPanel();
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
    : endingOf(item.steps, isOpen, cutOff);
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
  /** 다시 해 보기, where it is offered: the person's own words again, as if typed. */
  const askAgain =
    canRetry(state) && asked !== undefined && conversation !== null
      ? () => conversation.ask(asked)
      : null;
  const heading = taskHeading(sitesOf(item.steps), lookedUpOf(item.steps));
  const detail = taskStateDetail(state);
  const latest = item.notes.at(-1);
  /*
   * A PICTURE WHERE THERE IS ONE, AND NO BOX WHERE THERE IS NOT. The frame used to be drawn always,
   * so a task with no picture kept an empty grey rectangle a third of the card wide. While the task
   * runs the page is on its way, and the box holds its place.
   */
  const hasPicture = isOpen || hasFrame;
  /*
   * A CARD FOR AS LONG AS IT IS THE THING BEING WATCHED OR ANSWERED, whatever anybody pressed:
   *  - the Bot is doing it, or a step of it is waiting on the person's answer — the two states the
   *    chip marks with a dot, because they are happening now;
   *  - the Bot stopped right after it to ask for a hand, and the page it is stuck on is this
   *    card's picture;
   *  - it is the one the live screen is showing, or just looked for: "지금 열린 페이지가 없어요" is
   *    said on this card, to the person whose screen closed itself a moment ago.
   * Such a card is today's card and has nothing to fold with — its head is not a button.
   */
  const isHeld =
    state.kind === "running" ||
    state.kind === "yourTurn" ||
    isHandedOver ||
    (isNewest && (isScreenOpen || isPageGone));
  /*
   * ANY OTHER TASK IS OVER, AND IS ONE ROW UNTIL THE PERSON OPENS IT. An open list of what it did
   * counts as opened: somebody reading 한 일 while the Bot worked would have had the list folded
   * away under them the moment the task ended.
   */
  const isFolded = !isHeld && !isUnfolded && !isExpanded;
  const handleFold = () => {
    // Folded by its head, the list goes with it — an open list is one of the things holding it open.
    if (!isFolded) setIsExpanded(false);
    onFold(isFolded);
  };

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
      <div
        className={cn(
          chatCard,
          "flex flex-col gap-2.5",
          isFolded ? null : chatCardPadding,
        )}
      >
        <div className={cn("flex", isFolded ? "items-center" : "gap-3")}>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {isHeld ? (
              /*
               * WHERE, AND HOW IT STANDS, on one small line; then what, as the title. The site used
               * to lead the title and the state trailed in the smallest text on the card
               * (`taskHeading`, `taskStateDetail`).
               */
              <div className="flex min-h-5 items-center justify-between gap-2">
                {heading.site ? (
                  <span className={cn(chatCardMeta, "min-w-0 truncate")}>
                    {heading.site}
                  </span>
                ) : null}
                <TaskStateChip state={state} />
              </div>
            ) : (
              /*
               * THE SAME LINE AS A BUTTON, ONCE THE TASK IS OVER: the whole row while it is folded,
               * the card's first line once it is open. One element in one place for both, so the
               * keyboard is still on it after it is pressed and the next press folds it back.
               *
               * A REAL BUTTON THAT SAYS WHETHER IT IS OPEN, and nothing else that can be pressed
               * inside it: 다시 해 보기 is its neighbour, not its child.
               *
               * Folded, a row a finger can hit (44px). Open, it takes the place the line has on a
               * card that cannot fold and no more — its box reaches past that place by its own
               * padding, further under a finger, and the card is not a pixel taller for it.
               */
              <button
                aria-expanded={!isFolded}
                className={cn(
                  "flex items-center gap-2 text-left transition-colors",
                  focusRingInset,
                  isFolded
                    ? "h-11 rounded-2xl px-3 hover:bg-muted/50"
                    : "-mx-1.5 -my-1 min-h-7 rounded-lg px-1.5 py-1 hover:bg-muted/60 pointer-coarse:-my-2 pointer-coarse:min-h-9",
                )}
                onClick={handleFold}
                type="button"
              >
                {isFolded ? (
                  <>
                    <IconBrowser
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    {/*
                     * The site as people call it, then what was looked up there — one run of text
                     * cut at its end, so on a narrow row it is the looked-up half that gives way
                     * and the site is the last thing to go.
                     */}
                    <span className="min-w-0 flex-1 truncate text-sm">
                      <span className="font-medium">
                        {heading.site ??
                          heading.title ??
                          t("The Bot's browser")}
                      </span>
                      {heading.site && heading.title ? (
                        <span className="text-muted-foreground">
                          {` · ${heading.title}`}
                        </span>
                      ) : null}
                    </span>
                  </>
                ) : heading.site ? (
                  <span className={cn(chatCardMeta, "min-w-0 flex-1 truncate")}>
                    {heading.site}
                  </span>
                ) : null}
                {/*
                 * THE CARD'S OWN CHIP, so a row cannot say how a task ended in other words or
                 * another colour than its card does: amber where it did not finish.
                 */}
                <TaskStateChip state={state} />
                <IconChevronDown
                  aria-hidden="true"
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform",
                    isFolded ? null : "ms-auto rotate-180",
                  )}
                />
              </button>
            )}
            {isFolded ? null : (
              <>
                {/* Two lines, not one: at 375px one line held three words of the task. */}
                <p
                  className={cn(
                    chatCardTitle,
                    "line-clamp-2 text-balance break-words",
                  )}
                >
                  {heading.title ?? t("The Bot's browser")}
                </p>
                {detail ? (
                  <p className="break-words text-sm">{detail}</p>
                ) : latest ? (
                  /*
                   * The newest thing the Bot said while doing this, one line: what it is up to, in
                   * its own words. The rest of what it said is under 한 일, where it was said.
                   */
                  <p className={cn(chatCardMeta, "truncate")}>
                    {plainLine(latest.text)}
                  </p>
                ) : null}
              </>
            )}
          </div>
          {isFolded ? (
            /*
             * 다시 해 보기 STAYS ONE PRESS AWAY ON A ROW THAT FAILED, as an icon beside the row's own
             * button. Behind the fold it would be two, for the one thing there is to do about a
             * task that did not finish — and a row is where the words went that an icon can stand
             * for. Named for a screen reader and on hover; drawn only where the card offers it.
             */
            askAgain ? (
              <Button
                aria-label={t("Try it again")}
                className="me-1"
                onClick={askAgain}
                size="icon-lg"
                title={t("Try it again")}
                variant="ghost"
              >
                <IconRefresh aria-hidden="true" />
              </Button>
            ) : null
          ) : hasPicture ? (
            canView ? (
              <button
                aria-label={t("View the Bot's screen")}
                className="shrink-0 cursor-zoom-in self-start rounded-lg"
                onClick={() => setScreenOpen(true)}
                type="button"
              >
                {picture}
              </button>
            ) : (
              <div className="shrink-0 self-start">{picture}</div>
            )
          ) : null}
        </div>
        {/*
         * No count of steps. "완료 · 3단계" asked somebody to care how many calls a task took, which
         * is the one number about it that means nothing to them.
         */}
        {isFolded ? null : (
          <div className="flex flex-wrap items-center gap-1.5">
            {/*
             * 다시 해 보기: the owner's own words again, as if typed. Measured (UX review 0.5.4, item
             * 3): after a failed task the Bot said "다시 시도해 달라고 해 주시면", and the owner had to
             * type the whole request out a second time.
             *
             * THE ONE FILLED BUTTON, where pressing it is what there is to do. Not after a site
             * turned the Bot away: asking again is most often turned away again, and the page it
             * showed is the other thing worth pressing — so there the two sit side by side.
             */}
            {askAgain ? (
              <Button
                className={touchTall}
                onClick={askAgain}
                size="sm"
                variant={
                  state.kind === "failed" && state.code === SITE_REFUSED
                    ? "secondary"
                    : "default"
                }
              >
                {t("Try it again")}
              </Button>
            ) : null}
            {canView ? (
              <Button
                className={touchTall}
                onClick={() => setScreenOpen(true)}
                size="sm"
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
              className={cn("ms-auto", touchTall)}
              onClick={() => setIsExpanded((was) => !was)}
              size="sm"
              variant="ghost"
            >
              {t("What it did")}
              <IconChevronDown
                aria-hidden="true"
                className={`transition-transform ${isExpanded ? "rotate-180" : ""}`}
              />
            </Button>
          </div>
        )}
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

/**
 * How the task stands, as the chip on the card's first line: the same five words everything else
 * says it with (`taskStateWord`), toned by the kind of news each is.
 *
 * A dot before the two that are happening now — the Bot at work, the person awaited — so they are
 * told apart from the three that are over by more than a colour.
 */
function TaskStateChip({ state }: { state: TaskState }) {
  const isNow = state.kind === "running" || state.kind === "yourTurn";
  return (
    <span
      className={cn(
        chatCardChip,
        "gap-1.5",
        state.kind === "running"
          ? chatCardChipLive
          : state.kind === "yourTurn" || state.kind === "failed"
            ? chatCardChipSignal
            : chatCardChipQuiet,
      )}
    >
      {isNow ? (
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            state.kind === "running" ? "bg-mark" : "bg-warning",
          )}
        />
      ) : null}
      {taskStateWord(state)}
    </span>
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
    <span className="relative flex aspect-[16/10] w-24 items-center justify-center overflow-hidden rounded-lg bg-muted">
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
