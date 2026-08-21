/**
 * Wall-clock arithmetic in a named zone, with no dependency.
 *
 * A routine's time is a promise about a clock on a wall: "every weekday at 9". Stored as UTC it is
 * a promise about an instant, which is a different and worse promise — it drifts by an hour twice
 * a year anywhere daylight saving exists, and it forces the person who wrote it to do the
 * conversion in their head. So the zone is stored and the arithmetic happens here.
 *
 * `Intl.DateTimeFormat` is the only correct source of zone rules available without shipping a
 * database of them, and it answers the easy direction: given an instant, what does the clock read
 * there. The hard direction — given a clock reading, which instant — is inverted below by
 * measuring the offset and correcting, twice, which is exact everywhere except inside the repeated
 * hour of a fall-back transition. Korea, the first market, has no daylight saving at all.
 */

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday, matching `Date.prototype.getDay`. */
  weekday: number;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatterFor(timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
}

/** What the clock in `timeZone` reads at this instant. */
export function wallClockAt(at: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(at);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const weekdayName =
    parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    // `hour12: false` renders midnight as 24 in some engines; 24:00 is the same day's 00:00.
    hour: value("hour") % 24,
    minute: value("minute"),
    weekday: Math.max(0, WEEKDAYS.indexOf(weekdayName)),
  };
}

/** The same reading expressed as if it were UTC, which makes offsets subtractable. */
function asUtcMillis(clock: WallClock): number {
  return Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
  );
}

/**
 * The instant at which the clock in `timeZone` reads this calendar day at `hour:minute`.
 *
 * Two correction passes, not one: the first uses the offset in force at the guessed instant, and
 * if that guess landed on the far side of a transition the offset it used was the wrong one. The
 * second pass measures again from the corrected instant and converges.
 */
export function instantOf(
  day: { year: number; month: number; day: number },
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const target = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  let instant = new Date(target);
  for (let pass = 0; pass < 2; pass += 1) {
    const drift = asUtcMillis(wallClockAt(instant, timeZone)) - instant.getTime();
    instant = new Date(target - drift);
  }
  return instant;
}

/** The calendar day `offset` days after the one this instant falls on, in `timeZone`. */
export function dayAfter(
  at: Date,
  offset: number,
  timeZone: string,
): { year: number; month: number; day: number } {
  const clock = wallClockAt(at, timeZone);
  // Stepped as UTC and read back as UTC: this is calendar arithmetic on the local date, not on the
  // instant, so it cannot be knocked sideways by a transition in between.
  const stepped = new Date(
    Date.UTC(clock.year, clock.month - 1, clock.day) + offset * 86_400_000,
  );
  return {
    year: stepped.getUTCFullYear(),
    month: stepped.getUTCMonth() + 1,
    day: stepped.getUTCDate(),
  };
}

/** Whether a zone name is one this runtime actually knows. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}
