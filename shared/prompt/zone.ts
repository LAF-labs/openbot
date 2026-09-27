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

/**
 * 앞으로 7일, "내일 9/28(월) · 모레 9/29(화) · 글피 9/30(수) · 10/1(목) · …" — `dayLabel`의 날짜에서
 * 달력으로 센다. 이미 사장님의 날짜이므로 시간대를 다시 볼 일이 없다.
 *
 * 봇이 셈을 틀린 것이 이유다. 2026-09-27(일) 네이버 날씨를 읽고 "비는 모레(9/30 수)"라고 했다 —
 * 모레는 9/29(화)다. 페이지의 시간별 예보가 "모레 …" 뒤에 "09.30."을 잇고 기상청 요약이 "모레 …
 * 비"라고 쓴 것을 한데 엮은 것이다. 같은 페이지로 마흔 번 물으면 세 번 그랬고, 곧장 "모레 며칠이야"
 * 라고 물으면 스물네 번 다 맞혔다 — 틀리는 곳은 셈이 아니라 페이지 위에서 날짜를 짝짓는 자리다
 * (`evals/grounded.ts`). 이 줄만 더했을 때는 열 번에 두 번 여전히 틀렸다: 정적 프롬프트의 한 문장
 * (`CONTEXT_RULES_KO`)이 내일·모레·글피를 이 줄에서만 옮겨 쓰게 하고 나서야 스무 번 다 맞혔다.
 */
export function weekAheadLabel(day: string): string {
  const [year, month, date] = day.slice(0, 10).split("-").map(Number);
  if (!year || !month || !date) return "";
  const names = ["내일", "모레", "글피"];
  const days = Array.from({ length: 7 }, (_, index) => {
    const at = new Date(Date.UTC(year, month - 1, date + index + 1));
    const label = `${at.getUTCMonth() + 1}/${at.getUTCDate()}(${WEEKDAYS_KO[at.getUTCDay()]})`;
    const name = names[index];
    return name ? `${name} ${label}` : label;
  });
  return days.join(" · ");
}

/** "Asia/Seoul(KST)", 약자를 모르면 이름만. */
export function zoneLabel(timeZone: string): string {
  const zone = resolveTimeZone(timeZone);
  const short = ZONE_LABELS[zone];
  return short && short !== zone ? `${zone}(${short})` : zone;
}
