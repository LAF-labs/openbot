import { IconBrowser, IconPlayerStopFilled, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { SectionBoundary } from "@/components/layout/section-boundary";
import { Button } from "@/components/ui/button";
import { hostOf } from "@/lib/computer/browsing";
import { dismissTask, useBrowsingNow } from "@/lib/computer/browsing-now";
import { isBlankAddress } from "@/lib/computer/last-frame";
import { setScreenOpen, useScreenPanel } from "@/lib/computer/screen-panel";
import { t } from "@/lib/i18n";
import { decodeFrame, paintFrame } from "./frame-bitmap";

/** How often the banner's picture is refreshed. A glance, not a stream: the live screen is that. */
const THUMBNAIL_EVERY_MS = 2_000;

/**
 * WHILE THE BOT WORKS IN ITS BROWSER: ONE SLIM LINE UNDER THE HEADER, AND NOTHING THAT OPENS ITSELF.
 *
 * A small live picture, the site, what it is doing in plain words, and a stop. Pressing the picture
 * or the words opens the live screen; the X puts the banner away for this task, and the next task
 * brings its own. This is what took the place of the screen opening by itself at every step.
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
};

function Banner({ botId, onStop, isStoppable }: BannerProps) {
  const now = useBrowsingNow();
  const task = now.task?.botId === botId ? now.task : null;
  const isShown = task !== null && !now.dismissed.has(task.taskId);
  const { isOpen: isScreenOpen } = useScreenPanel();
  /*
   * The page the picture is of, for a task that opened none of its own — one that carries on where
   * the last left off, after a person signed in, say. The calls name no site then, and the picture's
   * own address is the one fact there is.
   */
  const [pictureSite, setPictureSite] = useState<string | null>(null);

  if (!task || !isShown) return null;

  const where = task.sites.at(-1) ?? pictureSite;

  return (
    <div className="shrink-0 px-4 pt-1 pb-2">
      <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-xl border bg-background py-1.5 pr-1.5 pl-1.5 shadow-xs">
        <button
          aria-label={t("View the Bot's screen")}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left"
          onClick={() => setScreenOpen(true)}
          type="button"
        >
          <Thumbnail
            botId={botId}
            isPaused={isScreenOpen}
            onSite={setPictureSite}
          />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-sm">
              {where ?? t("The Bot's browser")}
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
  );
}

/**
 * The Bot's page, small, refreshed every couple of seconds while the banner is up.
 *
 * Paused while the live screen is open — the same page is already on screen, moving — and never a
 * blank page: a browser sent nowhere keeps the last real picture, or the browser mark.
 */
function Thumbnail({
  botId,
  isPaused,
  onSite,
}: {
  botId: string;
  isPaused: boolean;
  onSite: (site: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hasPicture, setHasPicture] = useState(false);

  useEffect(() => {
    if (isPaused) return;
    let isGone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const response = await fetch(
        `/api/computers/${encodeURIComponent(botId)}/screenshot`,
        { credentials: "include" },
      ).catch(() => null);
      const shot = response?.ok
        ? ((await response.json().catch(() => null)) as {
            base64?: string;
            url?: string;
          } | null)
        : null;
      if (shot?.base64 && !isBlankAddress(shot.url)) {
        const bitmap = await decodeFrame(shot.base64, "image/png");
        const canvas = canvasRef.current;
        if (bitmap && canvas && !isGone) {
          paintFrame(canvas, bitmap);
          setHasPicture(true);
          onSite(hostOf(shot.url));
        }
        bitmap?.close();
      }
      if (!isGone) timer = setTimeout(() => void tick(), THUMBNAIL_EVERY_MS);
    };
    void tick();
    return () => {
      isGone = true;
      clearTimeout(timer);
    };
  }, [botId, isPaused, onSite]);

  return (
    <span className="relative flex aspect-[16/10] w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
      <IconBrowser
        aria-hidden="true"
        className="size-4 text-muted-foreground/60"
      />
      <canvas
        className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity ${hasPicture ? "opacity-100" : "opacity-0"}`}
        ref={canvasRef}
      />
    </span>
  );
}
