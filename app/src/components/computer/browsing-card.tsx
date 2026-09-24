import { IconBrowser, IconChevronDown } from "@tabler/icons-react";
import { useId, useState } from "react";
import { ApprovalRequest } from "@/components/channels/approval-request";
import type { BrowsingItem } from "@/components/channels/chat-messages";
import { ToolLine } from "@/components/channels/tool-line";
import { Button } from "@/components/ui/button";
import {
  endingOf,
  pictureStepOf,
  sitesOf,
  stepLine,
  type TaskEnding,
} from "@/lib/computer/browsing";
import { useBrowsingNow } from "@/lib/computer/browsing-now";
import { frameAddress, useFrameVersion } from "@/lib/computer/last-frame";
import { setScreenOpen } from "@/lib/computer/screen-panel";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { t } from "@/lib/i18n";

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
export function BrowsingCard({
  item,
  channelId,
  isOpen,
  isNewest,
}: {
  item: BrowsingItem;
  /** Where the kept picture is read from. Absent on a screen with no channel: no picture. */
  channelId: string | undefined;
  /** The task is still being done. */
  isOpen: boolean;
  /** The last task in the conversation: the one the live screen would show. */
  isNewest: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const stepsId = useId();
  const botId = useDeclaredBotId();
  const now = useBrowsingNow();
  const sites = sitesOf(item.steps);
  const ending = endingOf(item.steps, isOpen);
  const pictureStep = isOpen ? null : pictureStepOf(item.steps);
  const isPageGone = botId !== undefined && now.pageGoneFor === botId;
  const canView = isNewest && botId !== undefined && !isPageGone;
  const count = item.steps.length;

  const picture = (
    <TaskPicture
      channelId={channelId}
      isOpen={isOpen}
      toolCallId={pictureStep}
    />
  );

  return (
    <div className="flex flex-col gap-2">
      {/*
       * A question about any step of the task, above the card and not inside the folded list: a
       * person deciding whether to allow a click must not have to unfold anything to find the
       * buttons. Each renders nothing unless that exact call raised a question.
       */}
      {item.steps.map((step) => (
        <ApprovalRequest key={step.id} toolCallId={step.id} />
      ))}
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
          <p className="truncate font-medium text-sm">
            {sites.length > 0 ? sites.join(" · ") : t("The Bot's browser")}
          </p>
          <p
            className={`text-xs ${ending === "running" ? "text-muted-foreground" : ending === "blocked" ? "text-warning" : "text-muted-foreground"}`}
          >
            {endingText(ending)}
            {" · "}
            {count === 1 ? t("1 step") : t("{count} steps", { count })}
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
            ) : isNewest && isPageGone && !isOpen ? (
              <span className="text-muted-foreground text-xs">
                {t("No page is open now. The picture is the last one.")}
              </span>
            ) : null}
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
          ? item.steps.map((step) => {
              const line = stepLine(step);
              return (
                <ToolLine
                  detail={line.detail}
                  failed={line.failed}
                  key={step.id}
                  kind="browser"
                  label={line.label}
                  refused={line.refused}
                  running={line.running}
                />
              );
            })
          : null}
      </div>
    </div>
  );
}

function endingText(ending: TaskEnding): string {
  switch (ending) {
    case "running":
      return t("Working on it");
    case "done":
      return t("Done");
    case "stopped":
      return t("Stopped");
    case "blocked":
      return t("Got stuck");
  }
}

/**
 * The task's last picture, or a quiet browser mark where there is none.
 *
 * None is normal: a task still running has not ended, a task from before pictures were kept never
 * had one, and one that ended while a person held the wheel was deliberately not taken. Keyed by the
 * version this tab kept, so a card that asked a moment too early asks again once it is there.
 */
function TaskPicture({
  channelId,
  toolCallId,
  isOpen,
}: {
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
      {channelId && toolCallId ? (
        <FrameImage
          key={version}
          src={`${frameAddress(channelId, toolCallId)}?v=${version}`}
        />
      ) : null}
    </span>
  );
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
