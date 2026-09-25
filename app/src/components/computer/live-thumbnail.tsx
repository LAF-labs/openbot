import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { hostOf } from "@/lib/computer/browsing";
import { isBlankAddress } from "@/lib/computer/last-frame";
import { decodeFrame, paintFrame } from "./frame-bitmap";

/** How often the picture is refreshed. A glance, not a stream: the live screen is that. */
const THUMBNAIL_EVERY_MS = 2_000;

/**
 * A small JPEG, not the viewport's PNG: the thumbnail is drawn a few hundred pixels wide, and the PNG
 * was 166–554 KB every 2 s (performance audit, 2026-09-25). 480 wide keeps it sharp at twice the
 * pixel density of the widest place it is drawn.
 */
const THUMBNAIL_QUERY = "format=jpeg&width=480&quality=60";

/**
 * THE BOT'S PAGE, SMALL, FOR EVERYTHING ON THE SCREEN THAT WANTS A GLANCE OF IT — FETCHED ONCE.
 *
 * MEASURED ON 2026-09-24 (UI/UX audit, item 13): the card of a task still being done was an empty
 * frame, while the banner above it, at the same moment, had the page. The card drew only the
 * picture kept when a task ENDS, and a running task has not ended. Now the running card shows what
 * the banner shows — and from the same request: both ask this one poll, which runs while anybody is
 * watching and stops when nobody is, so a second picture on the screen is not a second screenshot
 * of the Bot's browser every two seconds.
 *
 * Never a blank page: a browser sent nowhere keeps the last real picture.
 */
export type LiveFrame = {
  base64: string;
  /** What the bytes are: a JPEG from a computer that makes thumbnails, a PNG from an older one. */
  mime: string;
  /** The page it is of, without `www.`; null when it was not a web page. */
  site: string | null;
};

type Poll = {
  frame: LiveFrame | null;
  watchers: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const polls = new Map<string, Poll>();

function pollFor(botId: string): Poll {
  let poll = polls.get(botId);
  if (!poll) {
    poll = { frame: null, watchers: new Set(), timer: undefined };
    polls.set(botId, poll);
  }
  return poll;
}

async function tick(botId: string, poll: Poll): Promise<void> {
  const response = await fetch(
    `/api/computers/${encodeURIComponent(botId)}/screenshot?${THUMBNAIL_QUERY}`,
    { credentials: "include" },
  ).catch(() => null);
  const shot = response?.ok
    ? ((await response.json().catch(() => null)) as {
        base64?: string;
        mime?: string;
        url?: string;
      } | null)
    : null;
  if (
    shot?.base64 &&
    !isBlankAddress(shot.url) &&
    shot.base64 !== poll.frame?.base64
  ) {
    poll.frame = {
      base64: shot.base64,
      mime: shot.mime ?? "image/png",
      site: hostOf(shot.url),
    };
    for (const watcher of poll.watchers) watcher();
  }
  // Nobody left watching: the loop ends here rather than asking once more for nobody.
  if (poll.watchers.size > 0) {
    poll.timer = setTimeout(() => void tick(botId, poll), THUMBNAIL_EVERY_MS);
  } else {
    poll.timer = undefined;
  }
}

function watch(botId: string, onChange: () => void): () => void {
  const poll = pollFor(botId);
  poll.watchers.add(onChange);
  if (poll.watchers.size === 1 && poll.timer === undefined) {
    // Marked before the first answer, so a second watcher arriving meanwhile starts no second loop.
    poll.timer = setTimeout(() => void tick(botId, poll), 0);
  }
  return () => {
    poll.watchers.delete(onChange);
  };
}

const NO_WATCH = () => () => {};

/**
 * The newest picture of this Bot's page, polled while `isPaused` is false.
 *
 * Paused while the live screen is open — the same page is already on screen, moving — and the last
 * picture is kept meanwhile, so nothing goes blank while it is.
 */
export function useLiveFrame(
  botId: string | undefined,
  isPaused: boolean,
): LiveFrame | null {
  const subscribe =
    botId && !isPaused
      ? (onChange: () => void) => watch(botId, onChange)
      : NO_WATCH;
  return useSyncExternalStore(
    subscribe,
    () => (botId ? (polls.get(botId)?.frame ?? null) : null),
    () => null,
  );
}

/**
 * A frame, painted on a canvas that fills the box it is put in. Transparent until the first
 * picture arrives, so the mark underneath shows through.
 */
export function FrameCanvas({ frame }: { frame: LiveFrame | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hasPicture, setHasPicture] = useState(false);
  // The same page twice is the same string, and there is nothing to paint again.
  const base64 = frame?.base64;
  const mime = frame?.mime ?? "image/png";

  useEffect(() => {
    if (!base64) return;
    let isGone = false;
    void decodeFrame(base64, mime).then((bitmap) => {
      const canvas = canvasRef.current;
      if (bitmap && canvas && !isGone) {
        paintFrame(canvas, bitmap);
        setHasPicture(true);
      }
      bitmap?.close();
    });
    return () => {
      isGone = true;
    };
  }, [base64, mime]);

  return (
    <canvas
      className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity ${hasPicture ? "opacity-100" : "opacity-0"}`}
      ref={canvasRef}
    />
  );
}
