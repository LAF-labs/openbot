import type { RoutineNote } from "@shared/prompt/notepad.ko";
import { queryOptions } from "@tanstack/react-query";
import { activeLocale, t } from "@/lib/i18n";
import { RequestRefusedError } from "@/lib/refusals";

/** A standing instruction a Bot runs on a clock. */
export type Routine = {
  id: string;
  agentId: string;
  name: string;
  instruction: string;
  /**
   * What it does, in one line written for the person by the Bot that made it. Null on routines
   * written by hand, made before 2026-09-24, or reworded since; the screen then shows the
   * instruction, folded. Optional because an older server does not send it.
   */
  summary?: string | null;
  scheduleKind: "interval" | "daily";
  intervalMinutes: number | null;
  /** "HH:MM" in `dailyTimeZone`. Called `dailyUtc` until the column stopped claiming to be UTC. */
  dailyLocal: string | null;
  /** The IANA zone the daily time is written in. Null on rows that predate zones, meaning UTC. */
  dailyTimeZone: string | null;
  /** Weekdays it may run on, 0 = Sunday. Null or empty means every day. */
  dailyDays: number[] | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  /**
   * Why it is off when its person did not turn it off: `unread`, when its results piled up unread
   * for a week (`server/src/routines/unread.ts`). Null otherwise. See `lib/routines/unread.ts`.
   */
  pausedReason?: "unread" | null;
  pausedAt?: string | null;
  /** The person's 계속 돌리기: never paused for going unread. */
  keepRunning?: boolean;
};

export type RoutineRun = {
  id: string;
  startedAt: string;
  ok: boolean | null;
  answer: string | null;
  error: string | null;
  /** The turns the run took; null on runs recorded before the server kept them. */
  steps: Array<{
    ms: number;
    text: number;
    calls: Array<{ name: string; ok: boolean }>;
  }> | null;
};

/**
 * One line for what a run did: "3 turns · 2 tools · 41s". Nothing for a run that has no record of
 * its turns, rather than a row of zeros that reads as a Bot that did nothing.
 */
export function runShape(
  steps: RoutineRun["steps"],
  t: (text: string, params?: Record<string, string | number>) => string,
): string | null {
  if (!steps?.length) return null;
  const tools = steps.reduce((total, step) => total + step.calls.length, 0);
  const seconds = Math.round(
    steps.reduce((total, step) => total + step.ms, 0) / 1000,
  );
  // Whole sentences, not a number glued to a translated noun: Korean puts its counter after the
  // number and English pluralises the noun, and "3 턴" was neither.
  const parts = [
    steps.length === 1
      ? t("1 turn")
      : t("{count} turns", { count: steps.length }),
    tools === 1 ? t("1 tool") : t("{count} tools", { count: tools }),
    // Through `t()` like the counts: glued on as `${seconds}s`, a Korean screen read "21s".
    t("{seconds}s", { seconds }),
  ];
  return parts.join(" · ");
}

/** One entry of a routine's notepad, as the server keeps it: what the next run reads, and when. */
export type RoutineNotepadEntry = RoutineNote & { at: string };

/** Where a routine left off. Written by its own runs; a person reads it and may empty it. */
export type RoutineNotepad = {
  entries: RoutineNotepadEntry[];
  updatedAt: string | null;
};

/**
 * What one entry says, in the reader's words.
 *
 * A note is its value, as the Bot wrote it. A watermark is where the routine got to — the newest
 * thing its last run handled — and it reads as that rather than as `lastId`/`lastAt`, which are the
 * model's field names and nothing a shop owner has a use for.
 */
export function notepadEntryLabel(
  entry: RoutineNotepadEntry,
  now: Date = new Date(),
): string {
  if (entry.kind === "note") return entry.value;
  const when = entry.lastAt ? whenLabel(entry.lastAt, now) : "";
  if (entry.lastId && when) {
    return t("Up to {id}, {when}", { id: entry.lastId, when });
  }
  return t("Up to {where}", { where: entry.lastId ?? when });
}

export const routineKeys = {
  all: ["routines"] as const,
  runs: (routineId: string) => ["routine-runs", routineId] as const,
  notepad: (routineId: string) => ["routine-notepad", routineId] as const,
};

/**
 * The refusals the routines API names, translated here because the code is a fact and this surface
 * owns the words — the same arrangement as MODEL_FAILURES in lib/copilot/stopped-turn.ts.
 *
 * The screen renders these straight into the create and delete forms, and what it rendered before
 * was the server's own English sentence: "This account holds 20 routines already. Delete one to
 * make room." on a Korean page. `app/tests/routines-copy.test.ts` walks this table, because `t()`
 * called on a variable is invisible to the i18n coverage test.
 */
export const ROUTINE_REFUSALS: Record<string, string> = {
  "laf:routine_cap_reached":
    "This account already holds as many routines as it can. Delete one to make room.",
  "laf:routine_not_found": "That routine is no longer there.",
  "laf:routine_incomplete": "Pick a Bot first.",
  /*
   * The three a Bot can provoke, because a Bot creates routines too now (`manage_routine`).
   *
   * They reach this screen as well: the same route answers both callers, and a refusal that had
   * words only for the Bot would fall through to the server's English sentence here — the exact
   * failure this table was written to end.
   */
  "laf:routine_needs_name": "Give the routine a name.",
  "laf:routine_needs_instruction": "Say what the routine should do each time.",
  "laf:routine_needs_schedule": "Say when it should run.",
  /*
   * The schedule refusals, which used to reach this form as the service's own English — "The daily
   * time must be HH:MM.", "Pick at least one day." (audit A1-3).
   */
  "laf:routine_time_invalid": "Give a time as HH:MM.",
  "laf:routine_zone_unknown": "That time zone is not one this server knows.",
  "laf:routine_days_invalid": "Choose days from Sunday to Saturday.",
  "laf:routine_days_empty": "Pick at least one day.",
  "laf:routine_interval_too_short": "Choose a longer gap between runs.",
  "laf:routine_schedule_invalid": "Choose how often it should run.",
  "laf:routine_schedule_unreachable": "That schedule never comes round.",
  "laf:routine_not_created": "The routine could not be made. Try again.",
  // An edit that named nothing to change. The form closes without a request when nothing changed,
  // so this screen should never meet it — but the route can send it, and a code with no words here
  // would print the generic failure for what is not a failure.
  "laf:routine_nothing_to_change": "Nothing was changed.",
  "laf:routine_trigger_token_missing": "That link is missing its key.",
  /*
   * "Run now" on a routine an account this place no longer admits wrote — one left from before a
   * place had exactly one account. It does not run by any door, and the button says why rather than
   * answering as if it had.
   */
  "laf:routine_author_not_admitted":
    "This routine was made by an account that can no longer use this place, so it does not run. Make it again yourself if you still need it.",
};

export async function routineRequest(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    credentials: "include",
    headers: init?.body ? { "content-type": "application/json" } : {},
    ...init,
  });
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    const code = typeof body?.code === "string" ? body.code : null;
    const known = code ? ROUTINE_REFUSALS[code] : undefined;
    // The code, and never the server's `error`, which is the code itself now — read as a fallback
    // it would print `laf:…`. `statusText` is "Internal Server Error", which says nothing either.
    // The code also travels on the error, for a read that has to tell "not here" from "not now".
    throw new RequestRefusedError(
      known ? t(known) : t("That did not go through. Try again."),
      response.status,
      code,
    );
  }
  return body;
}

/**
 * Every routine this person owns.
 *
 * One list rather than a per-Bot endpoint: a roster is a handful of Bots with a few routines each,
 * so the whole set is smaller than the round trip, and both readers — the Routines page and the
 * panel beside a conversation — then share one cache entry and one invalidation.
 */
export function routineListQueryOptions() {
  return queryOptions({
    queryKey: routineKeys.all,
    queryFn: async () =>
      (await routineRequest("/api/routines"))?.routines as Routine[],
  });
}

/**
 * The weekday names, indexed 0 = Sunday to match the stored values.
 *
 * `activeLocale` rather than `undefined`: the schedule line said "월, 화" beside "Weekdays at" or
 * "Mon, Tue" in the middle of a Korean sentence, depending on the browser rather than on the
 * language the person chose.
 */
export function weekdayNames(): string[] {
  const format = new Intl.DateTimeFormat(activeLocale, { weekday: "short" });
  // 2026-08-23 is a Sunday, so seven steps from it name the week in order.
  return Array.from({ length: 7 }, (_, index) =>
    format.format(new Date(Date.UTC(2026, 7, 23 + index))),
  );
}

/**
 * A wall-clock "HH:MM" as the reader's own language writes a time.
 *
 * ONE FORMAT, AND THERE WERE THREE. Measured on the routines screen: the form's own summary said
 * 매일 07:30, the saved row said 평일 09:00, and the panel beside a conversation said 오전 1:15 —
 * two of them a 24-hour clock a Korean sentence does not use, and all three in one product. The
 * hour is a number the app writes down, so the app writes it one way: `Intl` with `activeLocale`,
 * which gives 오전 7:30 in Korean and 7:30 AM in English.
 *
 * The stored value never changes. This is presentation only, and it is deliberately tolerant — a
 * row with a malformed time is still listed, still switchable, still deletable, for the reason
 * `scheduleLabel` records below.
 */
export function clockLabel(hhmm: string): string {
  const [hours, minutes] = hhmm.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return hhmm;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return hhmm;
  return new Intl.DateTimeFormat(activeLocale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(2026, 0, 1, hours, minutes));
}

/** Just the hour, for the hour picker: 오전 7시 in Korean, 7 AM in English. */
export function hourLabel(hour: number): string {
  return new Intl.DateTimeFormat(activeLocale, { hour: "numeric" }).format(
    new Date(2026, 0, 1, hour),
  );
}

/**
 * An instant, said the way somebody talks about a schedule: 오늘 오전 9:00, 내일 오전 9:00, 9월 8일 …
 *
 * A bare `toLocaleString` is right and unreadable — "2026. 9. 7. 오전 9:00" beside four other rows
 * of it is a wall of digits, and the question a person is asking of this line ("has it run? when is
 * it next?") is answered by the day, not by the year. Anything beyond tomorrow keeps its date,
 * because "in 8 days" is not a thing anybody can act on either.
 *
 * `now` is what "today" is measured from. A screen passes the one `useNow` keeps, so the label
 * turns over at midnight rather than whenever the row happens to be drawn again.
 */
export function whenLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";

  const midnight = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round(
    (midnight(when) - midnight(now)) / 86_400_000, // ms in a day
  );
  const time = clockLabel(
    `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`,
  );

  if (days === 0) return `${t("Today")} ${time}`;
  if (days === 1) return `${t("Tomorrow")} ${time}`;
  if (days === -1) return `${t("Yesterday")} ${time}`;
  const day = new Intl.DateTimeFormat(activeLocale, {
    day: "numeric",
    month: "short",
  }).format(when);
  return `${day} ${time}`;
}

/**
 * How a routine's schedule reads to a person.
 *
 * It used to read "Daily at 22:30 UTC", which asks a shop owner in Seoul to do arithmetic to find
 * out that their routine runs at half past seven in the morning. The zone is named only when it is
 * not the one the reader is in — telling somebody the time is in their own zone is noise.
 */
export function scheduleLabel(routine: Routine): string {
  if (routine.scheduleKind !== "daily") {
    return t("Every {minutes} minutes", {
      minutes: String(routine.intervalMinutes ?? 60),
    });
  }

  const time = clockLabel(routine.dailyLocal ?? "");
  const zone = routine.dailyTimeZone ?? "UTC";
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const suffix = zone === here ? "" : ` ${zone}`;
  /*
   * ONE BAD ROW MUST NOT TAKE THE WHOLE ROUTINES SCREEN DOWN, AND ONE DID.
   *
   * Measured on a development database: a routine stored `daily_days` as `{}` rather than as an
   * array — an empty jsonb object, which `?? []` waves straight through because it is not null.
   * `{}.length` is undefined, so both early returns miss, and the spread below threw "days is not
   * iterable" out of a LABEL. The error boundary caught it at the page, so every routine somebody
   * had disappeared behind "문제가 생겼습니다" because one of them had a shape nobody expected.
   * (It was not what was stored: the list was sending the driver's `Int32Array`, which JSON writes
   * as an object — `{}` when empty, `{"0":1,…}` otherwise, so every weekday routine also read as
   * 매일. The server normalises the list since 2026-09-18; see `published` in `routines/store.ts`.)
   *
   * A label is the last place that should be able to fail. An unreadable day list reads as "every
   * day", which is what an empty one already means and is the honest degradation: the routine is
   * still listed, still switchable, still deletable.
   */
  const days = Array.isArray(routine.dailyDays) ? routine.dailyDays : [];

  if (days.length === 0 || days.length === 7) {
    return `${t("Daily at {time}", { time })}${suffix}`;
  }
  const names = weekdayNames();
  const isWeekdays =
    days.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day));
  if (isWeekdays) {
    return `${t("Weekdays at {time}", { time })}${suffix}`;
  }
  /*
   * "매주 월 오전 9:00", not "월 오전 9:00": a bare weekday beside a time reads as one day — this
   * Monday — and the question a person has of the line is whether it comes round again (UI/UX audit
   * 0.5.3, item 8).
   */
  return `${t("Every {days} at {time}", {
    days: [...days]
      .sort((a, b) => a - b)
      .map((day) => names[day])
      .join(", "),
    time,
  })}${suffix}`;
}
