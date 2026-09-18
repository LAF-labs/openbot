import type { Routine } from "./queries";

/**
 * Routines the server paused because their results piled up unread (`server/src/routines/unread.ts`).
 *
 * The server sends the fact — `pausedReason: "unread"` on the row, a `routine.paused` notice with
 * counts — and these are the words and the grouping the screen puts on it. A pause nobody can see
 * is a routine that silently stopped, so the page says it on each row and once per Bot, with the
 * two answers a person has: turn them back on, or turn them back on and never pause them this way.
 */

/**
 * What the banner, the row, the ⋯ menu and the notice say, as the English `t()` reads as a key.
 *
 * Read through `t(variable)`, which `i18n-coverage.test.ts` cannot see: `routine-unread-pause.test.tsx`
 * walks this table against the dictionary instead.
 */
export const UNREAD_PAUSE_SENTENCES = {
  title: "Paused {count} routines on {name}",
  body: "Their results had gone unread for a while, so they stopped rather than keep running for nobody.",
  turnBackOn: "Turn back on",
  keepRunning: "Keep running",
  keepRunningHint:
    "Keep running means they will not stop like this again, read or not.",
  row: "Paused — its results went unread for a while",
  menu: "Keep running even if unread",
  notice: "Paused {count} routines — their results went unread for a while.",
} as const;

/** Off because the rule paused it — not because its person switched it off. */
export function pausedForUnread(routine: Routine): boolean {
  return !routine.enabled && routine.pausedReason === "unread";
}

export type UnreadPauseGroup = { agentId: string; routines: Routine[] };

/**
 * One group per Bot, in the order the list already has them, holding its routines the rule paused.
 *
 * Per Bot because that is what the rule decides on — one Bot's conversation going unread — and
 * what one press answers: 다시 켜기 turns back on every routine of that Bot the rule paused.
 */
export function unreadPausesByBot(routines: Routine[]): UnreadPauseGroup[] {
  const groups = new Map<string, Routine[]>();
  for (const routine of routines) {
    if (!pausedForUnread(routine)) continue;
    groups.set(routine.agentId, [
      ...(groups.get(routine.agentId) ?? []),
      routine,
    ]);
  }
  return [...groups].map(([agentId, paused]) => ({
    agentId,
    routines: paused,
  }));
}

/** The pause's facts off a notification, as the server's `RoutinePauseFacts` carries them. */
export function pausedCountOf(pause: unknown): number | null {
  if (!pause || typeof pause !== "object") return null;
  const count = (pause as { count?: unknown }).count;
  return typeof count === "number" && Number.isInteger(count) && count > 0
    ? count
    : null;
}
