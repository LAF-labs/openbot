import { IconBrowser, IconChevronDown } from "@tabler/icons-react";
import { Fragment, useId, useState, useSyncExternalStore } from "react";
import { ApprovalRequest } from "@/components/channels/approval-request";
import type { BrowsingItem } from "@/components/channels/chat-messages";
import { ToolLine } from "@/components/channels/tool-line";
import { LiveRegion } from "@/components/layout/live-region";
import { SectionBoundary } from "@/components/layout/section-boundary";
import { Button } from "@/components/ui/button";
import { questionOn, watchQuestions } from "@/lib/approvals";
import {
  endingOf,
  pictureStepOf,
  sitesOf,
  stepLine,
  type TaskEnding,
} from "@/lib/computer/browsing";
import { useBrowsingNow } from "@/lib/computer/browsing-now";
import { frameAddress, useFrameVersion } from "@/lib/computer/last-frame";
import { setScreenOpen, useScreenPanel } from "@/lib/computer/screen-panel";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { t } from "@/lib/i18n";
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
      <SectionBoundary
        className="max-w-md rounded-2xl border"
        section="computer"
      >
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
  const ending = endingOf(item.steps, isOpen);
  /*
   * A step of this task is waiting on the person — an approval above the card. Subscribed, so the
   * card says so the moment it is asked and stops the moment it is answered.
   */
  const isAsking = useSyncExternalStore(watchQuestions, () =>
    item.steps.some((step) => questionOn(step.id) !== undefined),
  );
  const pictureStep = isOpen ? null : pictureStepOf(item.steps);
  const isPageGone = botId !== undefined && now.pageGoneFor === botId;
  const canView = isNewest && botId !== undefined && !isPageGone;
  const title = taskTitle(sitesOf(item.steps), item.asked);
  const latest = item.notes.at(-1);

  const picture = (
    <TaskPicture
      botId={botId}
      channelId={channelId}
      isOpen={isOpen}
      toolCallId={pictureStep}
    />
  );

  return (
    <>
      <div className="flex max-w-md gap-3 rounded-2xl border p-2.5">
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
          <p className="line-clamp-2 break-words font-medium text-sm">
            {title ?? t("The Bot's browser")}
          </p>
          {/*
           * The newest thing the Bot said while doing this, one line: what it is up to, in its own
           * words. The rest of what it said is under 한 일, where it was said.
           */}
          {latest ? (
            <p className="truncate text-muted-foreground text-xs">
              {plainLine(latest.text)}
            </p>
          ) : null}
          {/*
           * No count of steps. "완료 · 3단계" asked somebody to care how many calls a task took, which
           * is the one number about it that means nothing to them.
           */}
          <p
            className={`text-xs ${isAsking ? "font-medium text-foreground" : ending === "blocked" ? "text-warning" : "text-muted-foreground"}`}
          >
            {isAsking ? t("Your turn") : endingText(ending)}
          </p>
          <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
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
                ? t("No page is open now. The picture is the last one.")
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
                </Fragment>
              );
            })
          : null}
      </div>
    </>
  );
}

/**
 * How the task stands, in three words a person uses — 끝남, 멈춤 — plus 하는 중 while it runs.
 * 사장님 차례 is decided above, from a question on one of its steps.
 */
function endingText(ending: TaskEnding): string {
  switch (ending) {
    case "running":
      return t("Working on it");
    case "done":
      return t("Finished");
    case "stopped":
    case "blocked":
      return t("Halted");
  }
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
  toolCallId,
  isOpen,
}: {
  botId: string | undefined;
  channelId: string | undefined;
  toolCallId: string | null;
  isOpen: boolean;
}) {
  const version = useFrameVersion(toolCallId);
  return (
    <span className="relative flex aspect-[16/10] w-28 items-center justify-center overflow-hidden rounded-lg bg-muted sm:w-36">
      <IconBrowser
        aria-hidden="true"
        className={`size-5 text-muted-foreground/60 ${isOpen ? "animate-pulse" : ""}`}
      />
      {isOpen ? (
        <RunningPicture botId={botId} />
      ) : channelId && toolCallId ? (
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
