/**
 * 시간대 — 이름이 쓸 수 있는 것인지, 그리고 날짜를 어떻게 적는지.
 *
 * 프롬프트(`./index.ts`)와 `now` 툴(`shared/tools/now.ts`)이 같이 읽는다. 따로 떼어 둔 것은 툴이
 * 프롬프트의 글 전부를 끌고 오지 않게 하려는 것이다.
 */

/** 봇에게 날짜를 말할 때 쓰는 시계. 한국이 첫 시장이므로 기본은 서울이다. */
export const DEFAULT_TIME_ZONE = "Asia/Seoul";

/**
 * IANA 이름 옆에 붙이는, 사람이 쓰는 약자. Intl은 한국 시간대에 "GMT+9"밖에 주지 않는다(측정함).
 *
 * 모르는 시간대는 약자 없이 IANA 이름만 나간다. 틀린 약자를 지어내느니 긴 이름이 낫다.
 */
export const ZONE_LABELS: Record<string, string> = {
  "Asia/Seoul": "KST",
  "Asia/Tokyo": "JST",
  UTC: "UTC",
};

/** 이 런타임이 실제로 아는 시간대인가. 모르는 이름으로 Intl을 부르면 던진다. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** 설정된 이름이 쓸 수 있으면 그것, 아니면 서울. 배포가 오타를 냈다고 봇이 죽지는 않는다. */
export function resolveTimeZone(name?: string | null): string {
  const named = name?.trim();
  return named && isKnownTimeZone(named) ? named : DEFAULT_TIME_ZONE;
}

const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"] as const;
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 그 시간대의 날짜와 시각, 조각으로. */
export function zonedParts(
  now: Date,
  timeZone: string,
): { date: string; weekday: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimeZone(timeZone),
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const at = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  // `h23`도 자정을 24로 그리는 엔진이 있다. 24:00은 같은 날의 00:00이다.
  const hour = String(Number(at("hour")) % 24).padStart(2, "0");
  return {
    date: `${at("year")}-${at("month")}-${at("day")}`,
    weekday: WEEKDAYS_KO[WEEKDAYS_EN.indexOf(at("weekday"))] ?? "",
    time: `${hour}:${at("minute")}`,
  };
}

/** "2026-09-25 (금)" — 그 시간대의 오늘. 날짜가 바뀌었는지는 이 글자가 바뀌었는지로 본다. */
export function dayLabel(now: Date, timeZone: string): string {
  const { date, weekday } = zonedParts(now, timeZone);
  return `${date} (${weekday})`;
}

/** "Asia/Seoul(KST)", 약자를 모르면 이름만. */
export function zoneLabel(timeZone: string): string {
  const zone = resolveTimeZone(timeZone);
  const short = ZONE_LABELS[zone];
  return short && short !== zone ? `${zone}(${short})` : zone;
}
