import { useSyncExternalStore } from "react";
import { decodeFrame } from "@/components/computer/frame-bitmap";
import { readControl } from "@/components/computer/take-the-wheel";

/**
 * THE LAST PICTURE OF A BROWSING TASK: TAKEN ONCE, WHEN THE TASK ENDS, AND KEPT WITH ITS RESULT.
 *
 * A task card shows what the browser looked like when the Bot finished with it, so scrolling back
 * shows what was done — and a Bot that has since closed the page has not closed it out of sight.
 *
 * THE CHEAPEST HONEST WAY FOUND:
 *  - one screenshot, the same route the old side pane polled once a second, taken once per task;
 *  - shrunk here to a 400px JPEG (measured 12–30 kB), because the browser already decodes these and
 *    the server has no image library;
 *  - kept on the row of the task's last result (`server/src/channels/frames.ts`), a column of the
 *    message table rather than a table of its own.
 *
 * NOT TAKEN while a person holds the wheel or the Bot is waiting for a secret: what is on the page
 * then is theirs, and possibly what they are typing. The card simply has no picture.
 */

/** Wide enough to read at twice the card's size on a high-density screen; no wider. */
const FRAME_WIDTH = 400;
const FRAME_QUALITY = 0.7;

/** The result reaches the thread with the next run's input, a moment after the task ends. */
const KEEP_ATTEMPTS = 5;
const KEEP_RETRY_MS = 1_500;

export function frameAddress(channelId: string, toolCallId: string): string {
  return `/api/channels/${encodeURIComponent(channelId)}/frames/${encodeURIComponent(toolCallId)}`;
}

/** A browser that has been sent nowhere, whose picture is a white rectangle. */
export function isBlankAddress(address: unknown): boolean {
  if (typeof address !== "string") return false;
  const trimmed = address.trim();
  return trimmed === "" || trimmed === "about:blank";
}

async function shrink(pngBase64: string): Promise<string | null> {
  const bitmap = await decodeFrame(pngBase64, "image/png");
  if (!bitmap) return null;
  const scale = Math.min(1, FRAME_WIDTH / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const url = canvas.toDataURL("image/jpeg", FRAME_QUALITY);
  const comma = url.indexOf(",");
  return comma > 0 ? url.slice(comma + 1) : null;
}

/** Kept pictures, by call id, so a card that asked too early asks again. */
const versions = new Map<string, number>();
const watchers = new Set<() => void>();

function kept(toolCallId: string): void {
  versions.set(toolCallId, (versions.get(toolCallId) ?? 0) + 1);
  for (const watcher of watchers) watcher();
}

function subscribe(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => {
    watchers.delete(onChange);
  };
}

/** How many times this tab has kept this call's picture: a key for the `<img>` that shows it. */
export function useFrameVersion(toolCallId: string | null): number {
  return useSyncExternalStore(
    subscribe,
    () => (toolCallId ? (versions.get(toolCallId) ?? 0) : 0),
    () => 0,
  );
}

/** Take the picture and keep it. Quietly false for every reason there is none. */
export async function keepLastFrame({
  channelId,
  botId,
  toolCallId,
}: {
  channelId: string;
  botId: string;
  toolCallId: string;
}): Promise<boolean> {
  const { state } = await readControl(botId).catch(() => ({ state: null }));
  if (state?.holder === "human" || state?.secretWanted) return false;

  // Asked for at the size it is kept at: the computer scales and encodes it, and this tab decodes
  // nothing. An older computer answers with the full PNG, which is shrunk here as it always was.
  const response = await fetch(
    `/api/computers/${encodeURIComponent(botId)}/screenshot?format=jpeg&width=${FRAME_WIDTH}&quality=${Math.round(FRAME_QUALITY * 100)}`,
    { credentials: "include" },
  ).catch(() => null);
  if (!response?.ok) return false;
  const shot = (await response.json().catch(() => null)) as {
    base64?: string;
    mime?: string;
    url?: string;
  } | null;
  if (!shot?.base64 || isBlankAddress(shot.url)) return false;
  const jpeg =
    shot.mime === "image/jpeg" ? shot.base64 : await shrink(shot.base64);
  if (!jpeg) return false;

  for (let attempt = 0; attempt < KEEP_ATTEMPTS; attempt += 1) {
    const put = await fetch(frameAddress(channelId, toolCallId), {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jpeg }),
    }).catch(() => null);
    if (put?.ok) {
      kept(toolCallId);
      return true;
    }
    // Anything but "not there yet" will not change by asking again.
    if (put && put.status !== 404) return false;
    await new Promise((resolve) => setTimeout(resolve, KEEP_RETRY_MS));
  }
  return false;
}
