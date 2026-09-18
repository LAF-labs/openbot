import type { Routine } from "./queries";

/**
 * The routine form's state, and the two ways it meets a routine: filled in from one, and turned back
 * into what a save sends.
 *
 * Out of the component so both are plain functions a test can hold to a table — what the form
 * shows for a stored routine, and what saving sends — without mounting a form with four selects.
 */

/** 매일, 특정 요일, N분마다. The first two are both `daily` rows; the middle one carries days. */
export type Repeat = "daily" | "weekly" | "interval";

export type RoutineFormState = {
  agentId: string;
  name: string;
  instruction: string;
  repeat: Repeat;
  /** As typed, so a half-typed number is still the person's to finish. */
  minutes: string;
  hour: number;
  minute: number;
  /** The zone the hour and minute are read in. See `formOf` for which one that is. */
  timeZone: string;
  /** Sorted weekdays, 0 = Sunday. Empty means every day. */
  days: number[];
};

/** The schedule a save sends, in the shape `POST` and `PATCH /api/routines` both read. */
export type ScheduleBody =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; time: string; timeZone: string; days?: number[] };

/** What an edit sends: only the fields the person changed. Empty means there is nothing to save. */
export type RoutineChangeBody = {
  name?: string;
  instruction?: string;
  schedule?: ScheduleBody;
};

/** The form for a new routine: 07:30 every day, on the reader's own clock. */
export function blankForm(browserZone: string): RoutineFormState {
  return {
    agentId: "",
    name: "",
    instruction: "",
    repeat: "daily",
    minutes: "60",
    hour: 7,
    minute: 30,
    timeZone: browserZone,
    days: [],
  };
}

/**
 * The form filled in from a stored routine.
 *
 * THE ROUTINE'S ZONE, NOT THE READER'S. `dailyLocal` is a wall clock in `dailyTimeZone`, so the hour
 * the form shows is only true on that clock — re-reading 07:30 in the browser's zone would move a
 * routine made on another machine, or by a Bot on the deployment's clock, without anybody asking.
 * A row from before zones is UTC, which is what it runs on. An interval routine has no zone of its
 * own, so a switch to a daily time starts in the reader's.
 *
 * A minute off the five-minute grid — a Bot can set 07:32 — is kept as it is rather than rounded,
 * which would be a change nobody made.
 */
export function formOf(
  routine: Routine,
  browserZone: string,
): RoutineFormState {
  const [hour, minute] = (routine.dailyLocal ?? "").split(":").map(Number);
  const days = everyDayIsNone(routine.dailyDays);
  const daily = routine.scheduleKind === "daily";
  return {
    agentId: routine.agentId,
    name: routine.name,
    instruction: routine.instruction,
    repeat: daily ? (days.length > 0 ? "weekly" : "daily") : "interval",
    minutes: String(routine.intervalMinutes ?? 60),
    hour: Number.isInteger(hour) ? (hour as number) : 7,
    minute: Number.isInteger(minute) ? (minute as number) : 30,
    timeZone: daily ? (routine.dailyTimeZone ?? "UTC") : browserZone,
    days,
  };
}

/** "HH:MM" from the form's two selects. */
export function timeOf(state: Pick<RoutineFormState, "hour" | "minute">) {
  return `${String(state.hour).padStart(2, "0")}:${String(state.minute).padStart(2, "0")}`;
}

/**
 * The schedule the form describes.
 *
 * Every day is the ABSENCE of `days`, never an empty list: the server refuses an empty selection on
 * purpose, so "every day" cannot be something a person arrives at by unticking everything.
 */
export function scheduleFrom(state: RoutineFormState): ScheduleBody {
  if (state.repeat === "interval") {
    return { kind: "interval", minutes: Number(state.minutes) };
  }
  return {
    kind: "daily",
    time: timeOf(state),
    timeZone: state.timeZone,
    ...(state.repeat === "weekly" && state.days.length > 0
      ? { days: [...state.days].sort((a, b) => a - b) }
      : {}),
  };
}

/**
 * What saving an edit sends: each field the person actually changed, and nothing else.
 *
 * THE SCHEDULE ONLY WHEN IT MOVED. The server re-arms a routine's clock from the moment its
 * schedule changes; sending the unchanged schedule beside a new name would push an hourly
 * routine's next run an hour out for a typo fixed in its title. The server ignores an identical
 * schedule too — this is the first of two locks on the same door, and the one that saves a request.
 */
export function routineChange(
  routine: Routine,
  state: RoutineFormState,
): RoutineChangeBody {
  const name = state.name.trim();
  const instruction = state.instruction.trim();
  const schedule = scheduleFrom(state);
  return {
    ...(name === routine.name ? {} : { name }),
    ...(instruction === routine.instruction ? {} : { instruction }),
    ...(sameSchedule(schedule, storedSchedule(routine)) ? {} : { schedule }),
  };
}

/** The routine's own schedule, in the shape the form sends. */
function storedSchedule(routine: Routine): ScheduleBody {
  if (routine.scheduleKind !== "daily") {
    return { kind: "interval", minutes: routine.intervalMinutes ?? 60 };
  }
  const days = everyDayIsNone(routine.dailyDays);
  return {
    kind: "daily",
    time: routine.dailyLocal ?? "",
    timeZone: routine.dailyTimeZone ?? "UTC",
    ...(days.length > 0 ? { days } : {}),
  };
}

function sameSchedule(a: ScheduleBody, b: ScheduleBody): boolean {
  if (a.kind === "interval" || b.kind === "interval") {
    return (
      a.kind === "interval" && b.kind === "interval" && a.minutes === b.minutes
    );
  }
  return (
    a.time === b.time &&
    a.timeZone === b.timeZone &&
    (a.days ?? []).join(",") === (b.days ?? []).join(",")
  );
}

/**
 * A stored day list as the form holds it: sorted, and empty for every day — which is what an empty
 * list, a null and all seven days each mean. A value that is not a list reads as every day, the
 * degradation `scheduleLabel` already chose for a malformed row.
 */
function everyDayIsNone(stored: unknown): number[] {
  if (!Array.isArray(stored)) return [];
  const days = [...new Set(stored)]
    .filter(
      (day): day is number => Number.isInteger(day) && day >= 0 && day <= 6,
    )
    .sort((a, b) => a - b);
  return days.length === 7 ? [] : days;
}
