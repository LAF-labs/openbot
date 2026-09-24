import type { Message } from "@ag-ui/core";
import { useEffect, useLayoutEffect, useRef } from "react";
import {
  openBrowsingTask,
  toVisibleChatItems,
  type TranscriptItem,
  withBrowsingTasks,
} from "@/components/channels/chat-messages";
import { doingNow, pictureStepOf, sitesOf } from "@/lib/computer/browsing";
import { publishOpenTask } from "@/lib/computer/browsing-now";
import { keepLastFrame } from "@/lib/computer/last-frame";

/**
 * The conversation's browsing, told to the rest of the screen — and each task's last picture, kept.
 *
 * Called by the conversation that runs the Bot, with the same messages the transcript draws, so the
 * task the banner names is the task the card below it is. Two effects:
 *
 *  - The task the Bot is on is published (`browsing-now.ts`) for the banner and the header's mark.
 *  - When a task this tab SAW open ends, its last picture is taken and kept (`last-frame.ts`). Only
 *    one seen open: a reload reads every old task as ended, and taking a picture now for a task from
 *    this morning would keep whatever the browser shows now under this morning's card.
 */
export function useBrowsingTasks({
  channelId,
  botId,
  messages,
  busy,
}: {
  channelId: string;
  botId: string;
  messages: readonly Message[];
  busy: boolean;
}) {
  const items = withBrowsingTasks(toVisibleChatItems(messages));
  const open = openBrowsingTask(items, busy);
  const openId = open?.id ?? null;
  const doing = open ? doingNow(open.steps) : "";
  const sites = open ? sitesOf(open.steps) : [];
  const sitesKey = sites.join("\n");

  // Read by the effect below after a task closes; written after every commit, never during render.
  const itemsRef = useRef<readonly TranscriptItem[]>(items);
  useLayoutEffect(() => {
    itemsRef.current = items;
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `sitesKey` stands for `sites`, which is a new array every render.
  useEffect(() => {
    publishOpenTask(openId ? { botId, taskId: openId, sites, doing } : null);
  }, [openId, doing, sitesKey, botId]);

  // Leaving the conversation leaves nothing claiming the browser is in use.
  useEffect(() => () => publishOpenTask(null), []);

  const watched = useRef<string | null>(null);
  useEffect(() => {
    const previous = watched.current;
    watched.current = openId;
    if (!previous || previous === openId) return;
    const ended = itemsRef.current.find(
      (item) => item.kind === "browse" && item.id === previous,
    );
    const toolCallId =
      ended?.kind === "browse" ? pictureStepOf(ended.steps) : null;
    if (toolCallId) void keepLastFrame({ channelId, botId, toolCallId });
  }, [openId, channelId, botId]);

  return open;
}
