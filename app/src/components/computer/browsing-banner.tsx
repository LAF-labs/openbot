import { IconBrowser, IconPlayerStopFilled, IconX } from "@tabler/icons-react";
import { LiveRegion } from "@/components/layout/live-region";
import { SectionBoundary } from "@/components/layout/section-boundary";
import { Button } from "@/components/ui/button";
import { dismissTask, useBrowsingNow } from "@/lib/computer/browsing-now";
import { setScreenOpen, useScreenPanel } from "@/lib/computer/screen-panel";
import { t } from "@/lib/i18n";
import { FrameCanvas, useLiveFrame } from "./live-thumbnail";
import { taskTitle } from "./task-title";

/**
 * WHILE THE BOT WORKS IN ITS BROWSER: ONE SLIM LINE UNDER THE HEADER, AND NOTHING THAT OPENS ITSELF.
 *
 * A small live picture, the site and the task, what it is doing in plain words, and a stop. Pressing
 * the picture or the words opens the live screen; the X puts the banner away for this task, and the
 * next task brings its own. This is what took the place of the screen opening by itself at every
 * step.
 *
 * IT FAILS ALONE, AS A LINE. It sits inside the conversation's seam, above the transcript's, so a
 * banner that threw took the transcript and the composer — and whatever was half typed in it —
 * with it, over a strip that only says what the Bot is doing.
 */
export function BrowsingBanner(props: BannerProps) {
  return (
    <SectionBoundary className="shrink-0" layout="line" section="computer">
      <Banner {...props} />
    </SectionBoundary>
  );
}

type BannerProps = {
  botId: string;
  onStop: () => void;
  isStoppable: boolean;
  /** The person's words that started the task, for its title (`task-title.ts`). */
  asked?: string | undefined;
};

function Banner({ botId, onStop, isStoppable, asked }: BannerProps) {
  const now = useBrowsingNow();
  const task = now.task?.botId === botId ? now.task : null;
  const isShown = task !== null && !now.dismissed.has(task.taskId);
  const { isOpen: isScreenOpen } = useScreenPanel();
  /*
   * Polled only while the banner is up; the running card below reads the same poll, so the two
   * pictures are one request (`live-thumbnail.tsx`).
   */
  const frame = useLiveFrame(isShown ? botId : undefined, isScreenOpen);
  /*
   * The page the picture is of, for a task that opened none of its own — one that carries on where
   * the last left off, after a person signed in, say. The calls name no site then, and the picture's
   * own address is the one fact there is.
   */
  const pictureSite = frame?.site ?? null;

  /*
   * WHAT THE BOT IS DOING IS HEARD, NOT ONLY SEEN. The banner arrives with the task and its line
   * changes at every step, and neither was a live region, so somebody who cannot see the strip was
   * never told the Bot had gone to a site at all. The region is mounted before the banner is and
   * outlives it, so the first step is heard as well as the rest; put away with X, it falls quiet.
   */
  const announcement = (
    <LiveRegion className="sr-only">
      {task && isShown ? task.doing : null}
    </LiveRegion>
  );

  // One shape whether or not there is a banner: a region re-created with its words is not heard.
  if (!task || !isShown) return <>{announcement}</>;

  const where = task.sites.at(-1) ?? pictureSite;
  /*
   * "예스24 · 소년이 온다 가격" rather than `yes24.com` or "봇의 브라우저": the same title the card below
   * it carries, so the line and the card read as one task.
   */
  const title = taskTitle(where ? [where] : [], asked);

  return (
    <>
      {announcement}
      <div className="shrink-0 px-4 pt-1 pb-2">
        <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-xl border bg-background py-1.5 pr-1.5 pl-1.5 shadow-xs">
          <button
            aria-label={t("View the Bot's screen")}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left"
            onClick={() => setScreenOpen(true)}
            type="button"
          >
            <span className="relative flex aspect-[16/10] w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
              <IconBrowser
                aria-hidden="true"
                className="size-4 text-muted-foreground/60"
              />
              <FrameCanvas frame={frame} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium text-sm">
                {title ?? t("The Bot's browser")}
              </span>
              <span className="truncate text-muted-foreground text-xs">
                {task.doing}
              </span>
            </span>
          </button>
          {isStoppable ? (
            <Button
              aria-label={t("Stop the Bot")}
              onClick={onStop}
              size="icon-sm"
              variant="destructive"
            >
              <IconPlayerStopFilled />
            </Button>
          ) : null}
          <Button
            aria-label={t("Hide this for this task")}
            onClick={() => dismissTask(task.taskId)}
            size="icon-sm"
            variant="ghost"
          >
            <IconX />
          </Button>
        </div>
      </div>
    </>
  );
}
