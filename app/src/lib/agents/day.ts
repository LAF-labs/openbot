import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { taskStateLine, taskStateWord } from "@/lib/computer/task-state";
import { clockLabel } from "@/lib/routines/queries";
import { useNow } from "@/lib/use-now";
import { workingQueryOptions } from "./working";

/**
 * 오늘: WHAT THE BOT DID TODAY, AS THE SERVER READ IT (`GET /api/agents/:agentId/day`).
 *
 * Facts only — a status, the person's own words, ids to jump to — so every word on the screen is
 * this module's or the component's (`bot-day.tsx`), in Korean through `t()`.
 *
 * NO POLL OF ITS OWN. A hidden window turns a one-second poll into one frame a minute, and the
 * things that change this list already arrive on the socket: a Bot speaking, a notification, a
 * reconnect (`use-channel-events.ts` invalidates `dayKeys.all` on each). The one thing that never
 * reaches the socket is a routine that answered `[SILENT]` — it says nothing, by design — so the
 * working poll that already exists is watched instead: a run of this Bot's ending is a moment the
 * day changed (`useDayFollowsWork`). And the window coming forward refetches, as every query does.
 */

/** `waiting`: the turn's step is with a window — the owner's answer, most often. */
export type DayRunStatus =
  | "done"
  | "error"
  | "stopped"
  | "unknown"
  | "running"
  | "waiting";

export type BotDayItem =
  | {
      kind: "chat";
      runId: string;
      at: string;
      status: DayRunStatus;
      /** Why it did not finish, as a code, when its browsing says (`server/src/agents/day.ts`). */
      reason?: string | null;
      /** Facts remembered during the turn. Absent from a server before 2026-09-25. */
      learned?: number;
      label: string | null;
      channelId: string | null;
      messageId: string | null;
      frameToolCallId: string | null;
    }
  | {
      kind: "routine";
      runId: string;
      routineId: string | null;
      at: string;
      status: DayRunStatus;
      name: string;
      silent: boolean;
      channelId: string | null;
      messageId: string | null;
      learned?: number;
    }
  | { kind: "learned"; memoryId: string; at: string; head: string }
  /** The memory's background work that changed something (`server/src/agents/day.ts`). */
  | {
      kind: "tidied";
      receiptId: string;
      at: string;
      job: "curation" | "dream";
      count: number;
    };

export type BotDay = {
  day: string;
  zone: string;
  items: BotDayItem[];
  more: boolean;
};

export const dayKeys = {
  all: ["agents", "day"] as const,
  of: (botId: string, date: string) => ["agents", "day", botId, date] as const,
};

/**
 * The device's calendar date, which is what turns the list over at midnight.
 *
 * The server counts the day in the person's home zone, which is the zone this device reports
 * (`PUT /api/me/device`), so the date here moving is the day there moving. It is in the query's key:
 * at 00:00 the key changes and the new day is asked for — no timer, `useNow` already ticks.
 */
export function deviceDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function dayQueryOptions(botId: string, date: string) {
  return queryOptions({
    queryKey: dayKeys.of(botId, date),
    queryFn: async (): Promise<BotDay> => {
      const response = await fetch(
        `/api/agents/${encodeURIComponent(botId)}/day`,
        { credentials: "include" },
      );
      if (!response.ok) {
        throw new Error(`/api/agents/:id/day answered ${response.status}`);
      }
      return (await response.json()) as BotDay;
    },
    staleTime: 5_000,
    // The PC shell's window coming forward is the moment somebody looks.
    refetchOnWindowFocus: true,
  });
}

/** This Bot's day, refetched when anything it does ends. */
export function useBotDay(botId: string) {
  const now = useNow();
  useDayFollowsWork(botId);
  return useQuery(dayQueryOptions(botId, deviceDate(now)));
}

/**
 * A run of this Bot's ending, seen by the working poll that is already running — the only sign a
 * silent routine ever gives. Held in state rather than a ref so the compiler can see it.
 */
function useDayFollowsWork(botId: string): void {
  const queryClient = useQueryClient();
  const working = useQuery(workingQueryOptions());
  const busy = (working.data ?? [])
    .filter((run) => run.agentId === botId)
    .map((run) => run.startedAt)
    .sort()
    .join(",");
  const [seen, setSeen] = useState(busy);
  useEffect(() => {
    if (busy === seen) return;
    setSeen(busy);
    void queryClient.invalidateQueries({ queryKey: dayKeys.all });
  }, [busy, seen, queryClient]);
}

/** "오전 7:30", on the day's own clock. */
export function dayClock(iso: string, zone: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(when);
  } catch {
    // A zone this browser does not know: the device's own clock is the next best.
    parts = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(when);
  }
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return clockLabel(`${hour}:${minute}`);
}

/** Before six in the morning on the owner's clock: work done while they slept ("밤사이"). */
export function isOvernight(iso: string, zone: string): boolean {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return false;
  try {
    const hour = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(when)
      .find((part) => part.type === "hour")?.value;
    return Number(hour) < 6;
  } catch {
    return when.getHours() < 6;
  }
}

export type DayMark = { text: string; tone: "active" | "failed" | "quiet" };

/**
 * What a row is marked with, when it is anything but finished well — in the card's own words
 * (`lib/computer/task-state.ts`), so a task that is 못 끝냄 on its card is 못 끝냄 here too. It was
 * 끝내지 못함 here, 멈춤 on the card and 중단됨 on a step's line for the one stop.
 *
 * 멈춤 is quiet, not red: it is the owner's own Stop, not something that went wrong.
 */
export function dayMark(
  status: DayRunStatus,
  reason?: string | null,
  /** A question is open for the owner — an approval or a request for help at the computer. */
  isAsking = true,
): DayMark | null {
  if (status === "error" || status === "unknown") {
    return {
      text: taskStateLine({ kind: "failed", code: reason ?? null }),
      tone: "failed",
    };
  }
  if (status === "stopped") {
    return { text: taskStateWord({ kind: "stopped" }), tone: "quiet" };
  }
  if (status === "running") {
    return { text: taskStateWord({ kind: "running" }), tone: "active" };
  }
  // Its step is waiting on a window: the owner's answer, or a window that has not come back yet.
  // Not finished, which is what it read as when the ledger wrote it `done` (UX review 0.5.4, #1).
  /*
   * Only while a question is open, though. With none, the step is a window's to make — or a
   * window's that crashed, which the server lists for ten minutes — and 사장님 차례 told the owner
   * to look for a question that was not there (0.5.4 final QA). It is still going on, as far as
   * anything here can know; the conversation says the rest ("다른 창에서 진행 중이었어요").
   */
  if (status === "waiting") {
    return {
      text: taskStateWord({ kind: isAsking ? "yourTurn" : "running" }),
      tone: "active",
    };
  }
  return null;
}
