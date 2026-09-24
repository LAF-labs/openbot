import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";

/**
 * `모두 멈추기`, as the window that shows it reads the server and adds up what happened.
 *
 * Two doors (`server/src/runner/stop-all-routes.ts`): what is going on for this person, and stop it
 * all. The server answers in counts by kind and names the conversations by thread, because this
 * window stops the conversation it holds itself (`lib/copilot/held-chats.ts`) and the same
 * conversation must be read once, not once from each side.
 */

/** Two since 2026-09-24, when rooms and one Bot answering another were removed. */
export type WorkKind = "chat" | "routine";

/**
 * The fact a stopped run is recorded under — a routine's receipt carries it where a failure's
 * reason would be (`server/src/runner/unattended.ts`, `RUN_STOPPED`). A code, so the words are ours.
 */
export const RUN_STOPPED = "laf:run_stopped";

/** The kinds in the order the dialog lists them. The server's `WORK_KINDS`, as the surface sees it. */
export const WORK_KINDS: readonly WorkKind[] = ["chat", "routine"];

export type WorkCounts = Record<WorkKind, number>;

export type RunningNow = { running: WorkCounts; chats: string[] };

export type StopAllResult = {
  stopped: WorkCounts;
  notStopped: WorkCounts;
  chats: { stopped: string[]; notStopped: string[] };
};

/** What one press came to, the window's own stops folded in. */
export type StopAllOutcome = { stopped: WorkCounts; notStopped: WorkCounts };

/**
 * One line per kind, as the English `t()` reads as a key.
 *
 * Read through `t(variable)`, which `i18n-coverage.test.ts` cannot see: `stop-all.test.ts` walks
 * this table instead.
 */
export const WORK_LINES: Record<WorkKind, string> = {
  chat: "Conversations: {count}",
  routine: "Routines: {count}",
};

const none = (): WorkCounts => ({ chat: 0, routine: 0 });

/** A count off the wire: a whole number or nothing, so a malformed answer never reads as work. */
function countsOf(value: unknown): WorkCounts {
  const counts = none();
  if (!value || typeof value !== "object") return counts;
  for (const kind of WORK_KINDS) {
    const count = (value as Record<string, unknown>)[kind];
    if (typeof count === "number" && Number.isInteger(count) && count > 0) {
      counts[kind] = count;
    }
  }
  return counts;
}

function threadsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((thread): thread is string => typeof thread === "string")
    : [];
}

export function parseRunning(value: unknown): RunningNow {
  const body = (value ?? {}) as Record<string, unknown>;
  return { running: countsOf(body.running), chats: threadsOf(body.chats) };
}

export function parseStopAll(value: unknown): StopAllResult {
  const body = (value ?? {}) as Record<string, unknown>;
  const chats = (body.chats ?? {}) as Record<string, unknown>;
  return {
    stopped: countsOf(body.stopped),
    notStopped: countsOf(body.notStopped),
    chats: {
      stopped: threadsOf(chats.stopped),
      notStopped: threadsOf(chats.notStopped),
    },
  };
}

export const stopAllKeys = {
  running: ["work", "running"] as const,
};

/**
 * What is going on right now, asked fresh every time the dialog opens — a count from a minute ago
 * is the wrong number to confirm a stop against.
 */
export function runningQueryOptions() {
  return queryOptions({
    queryKey: stopAllKeys.running,
    queryFn: async (): Promise<RunningNow> => {
      const response = await fetch("/api/me/running", {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(`/api/me/running answered ${response.status}`);
      }
      return parseRunning(await response.json());
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** Stop everything the server can reach. Throws when it did not answer, so the caller can say so. */
export async function stopEverything(): Promise<StopAllResult> {
  const response = await fetch("/api/me/stop-all", {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`/api/me/stop-all answered ${response.status}`);
  }
  return parseStopAll(await response.json());
}

export function totalOf(counts: WorkCounts): number {
  return WORK_KINDS.reduce((total, kind) => total + counts[kind], 0);
}

/** What is running, with a conversation only this window knows about counted, and none twice. */
export function runningWithHeld(
  server: RunningNow,
  held: readonly string[],
): WorkCounts {
  const onlyHere = held.filter((thread) => !server.chats.includes(thread));
  return { ...server.running, chat: server.running.chat + onlyHere.length };
}

/**
 * What one press came to: the server's answer, with the conversations this window stopped — or
 * failed to — folded in, each conversation counted once.
 *
 * `result` is null when the server did not answer at all; what this window did is still true, and
 * still said.
 */
export function outcomeWithHeld(
  result: StopAllResult | null,
  here: { stopped: readonly string[]; notStopped: readonly string[] },
): StopAllOutcome {
  const serverStopped = new Set(result?.chats.stopped ?? []);
  const serverStuck = result?.chats.notStopped ?? [];
  // Stopped by either side is stopped.
  const stoppedChats = new Set([...serverStopped, ...here.stopped]);
  // Stuck on both sides is stuck: the server's stuck ones this window stopped are not.
  const stuckChats = new Set(
    [...serverStuck, ...here.notStopped].filter(
      (thread) => !stoppedChats.has(thread),
    ),
  );
  const server = result ?? { stopped: none(), notStopped: none() };
  const serverStuckOnly = serverStuck.length;
  return {
    stopped: {
      ...server.stopped,
      chat: server.stopped.chat - serverStopped.size + stoppedChats.size,
    },
    notStopped: {
      ...server.notStopped,
      chat: server.notStopped.chat - serverStuckOnly + stuckChats.size,
    },
  };
}

/** What a press came to. `reached` false is a server that did not answer at all. */
export type Pressed = { reached: boolean; outcome: StopAllOutcome };

/**
 * One press of 모두 멈추기: this window's conversations first, then the server.
 *
 * THIS WINDOW FIRST, and it was measured the other way round: the server's stop closed the stream
 * while this window was still waiting for the reply, and the conversation drew "답을 받지
 * 못했습니다." in red under a turn the person had stopped. A conversation's own Stop marks the reply
 * as no longer expected before it reaches the server; stopping it here first keeps that order. Then
 * the server stops everything else — other windows' conversations and the routines.
 *
 * A server that does not answer is reported as such, with whatever this window stopped still said.
 */
export async function pressStopAll(doors: {
  stopHere: () => { stopped: string[]; notStopped: string[] };
  stopServer: () => Promise<StopAllResult>;
}): Promise<Pressed> {
  const here = doors.stopHere();
  const server = await doors.stopServer().catch(() => null);
  return { reached: server !== null, outcome: outcomeWithHeld(server, here) };
}

/** The lines to show for some counts: only the kinds there were, in the dialog's order. */
export function workBreakdown(counts: WorkCounts): string[] {
  return WORK_KINDS.filter((kind) => counts[kind] > 0).map(
    (kind) => WORK_LINES[kind],
  );
}

/** The same, said: "대화 1개 · 루틴 2개". */
export function describeWork(counts: WorkCounts): string {
  return WORK_KINDS.filter((kind) => counts[kind] > 0)
    .map((kind) => t(WORK_LINES[kind], { count: counts[kind] }))
    .join(" · ");
}
