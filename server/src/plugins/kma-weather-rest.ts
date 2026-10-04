/**
 * The weather, from 기상청's own API hub (apihub.kma.go.kr), on the fleet's one key.
 *
 * WHY THIS EXISTS. Asked for the weather, a Bot opened its browser, searched 네이버 and read a page
 * — twenty seconds, a page drawn for the VM's address rather than the person's (2026-09-24: 제주시,
 * reported as "사장님 위치"), and a third party's rendering of numbers 기상청 publishes itself. The
 * owner's word on it: do not browse for the weather, and do not take it from a third-party site.
 * This is the same arrangement as `public-data-rest.ts` — public data, a key LAF holds for the whole
 * fleet (`KMA_APIHUB_AUTH_KEY`), nobody consents and nothing is written — so it is the same shape:
 * a transport whose one tool is this repository's own code, read-only, offered to every Bot.
 *
 * ONE TOOL, ONE CALL, ONE SMALL ANSWER. "지금 몇 도야", "오늘 비 와?", "내일 날씨", "주말 날씨" are
 * four questions and three of 기상청's operations: 초단기실황 (what was observed at the top of the
 * hour), 초단기예보 (the next six hours) and 단기예보 (hour by hour for three days and every three
 * hours after, to three or four days out, with each day's 최저 and 최고). A tool per operation would
 * have a model choose between them, call two, and carry both results in its context on every later
 * turn. So all three are fetched at once and summarised HERE: the model is handed about a kilobyte
 * — now, six hours, a row per day — and never a raw row. A 단기예보 answer is a thousand rows and
 * 130 KB.
 *
 * WHAT WAS MEASURED on the hub with the fleet's key, 2026-10-02 from 00:40 KST. The usual account
 * of this service is the public data portal's, and the hub does not behave the same:
 *
 *  - Three of the 동네예보 service's four operations are open on the key. The fourth and every
 *    other forecast API tried answer HTTP 403 with `{"result":{"status":403,"message":"활용신청이
 *    필요한 API 입니다. …"}}` — a different envelope from a good answer's `response.header`, and
 *    the reason `ask` reads both.
 *  - The hub files 초단기예보 under the HOUR. Its own page says the issuance is on the half hour
 *    ("06시30분 발표(30분 단위)") and that is the spelling sent, but 0000, 0010, 0030 and 0045 all
 *    answered the same rows under `baseTime: "0000"`. The time a person is told is the one echoed.
 *  - Publication was timed, not assumed: 초단기실황 first answered five minutes past the hour and
 *    초단기예보 fourteen past, twice each — not the ten past and quarter to that are usually quoted
 *    for them. And the 02:00 단기예보 was answering before one o'clock. `SCHEDULE` has the minutes.
 *  - An issuance that is not out yet is `resultCode 03 NO_DATA` with HTTP 200 — and so is a request
 *    with a parameter missing. 03 means "step back one issuance", once.
 *  - A cell outside the grid answers zeros as though they were weather (`kma-grid.ts`); a cell at
 *    sea answers -999, -998 and -998.9 for an observation nobody made. `measure` reads those as
 *    nothing, so an answer never says "-999도".
 *  - One page holds a whole 단기예보 only if it is asked for: 1,000 rows cut the 17:00 issuance
 *    (1,052 rows) short of its last day. 1,100 are asked for.
 *  - 단기예보 writes rainfall in words for the first two days ("강수없음", "1mm 미만") and as a bare
 *    number after ("0", "0.4", "2"), in one body. `amount` reads both.
 *
 * THE DAYS AFTER THOSE come through a second door. 단기예보 ends three or four days out; days five
 * to ten are 기상청's 중기예보, which the hub's key was never opened for and the public data portal's
 * is (`kma-mid-forecast.ts`, which says what was measured there). They are rows added to the same
 * answer by the same tool, on a deployment that also carries the portal's key — and a part like the
 * other three: when it cannot be had it is named in `unavailable` and the rest is answered.
 *
 * THE KEY RIDES ON THE QUERY STRING, so a redirect is never followed and every refusal's detail is
 * cut clean of it before it goes to the trail (`withoutCredential`).
 *
 * NO PLACE IS LOGGED OR PUT IN A REFUSAL. Where somebody is belongs on their own screen and nowhere
 * else (`account/whereabouts.ts`); a refusal's detail is an audit row. The cells being asked about
 * live in this process's memory and in the request to 기상청, which is told a five-kilometre square
 * and not who asked.
 */
import {
  NOTHING_FALLS,
  SKY_WORDS,
  TODAY,
  WEATHER_SHOWN,
} from "../../../shared/weather";
import { log } from "../log";
import type { DeploymentKeyService } from "./deployment-key-runtime";
import { type KmaCell, kmaCellOf } from "./kma-grid";
import {
  createKmaMidForecast,
  dateMs,
  dayAfter,
  type KmaMidAnswer,
  type KmaMidDay,
} from "./kma-mid-forecast";
import { KMA_MID_REGIONS, type KmaMidRegions } from "./kma-mid-regions";
import { KMA_PLACES, type KmaPlaces } from "./kma-places";
import { HOUR, KST_OFFSET_MS, kstIssuanceAt, kstStamp, MINUTE } from "./kst";
import { type McpCallResult, trimDetail, withoutCredential } from "./mcp";
import type { PartnerToolSpec } from "./partner-tools";
import { rowsOf, vendorHeaderOf } from "./public-data-rest";
import { asResult, stringArg } from "./rest-support";
import { PluginRefusedError } from "./store";
import { TIMEOUT_MS } from "./timeouts";
import type { DrawnOn, VendorTransport } from "./transport";

/** The catalogue entry this tool lives under. Prefixes its ref: `kma-weather/get_weather`. */
export const KMA_WEATHER_KEY = "kma-weather";

/** The one host. The entry pins it; the three paths under it are this file's reviewed word. */
export const KMA_HOST = "https://apihub.kma.go.kr";
const SERVICE = `${KMA_HOST}/api/typ02/openApi/VilageFcstInfoService_2.0`;

/**
 * The three operations, by what each one is to a person rather than by 기상청's name for it.
 *
 * These three and no fourth: `getFcstVersion`, the service's own "which issuance is newest", was
 * not applied for and answers 403. The schedule below does that job with no request.
 */
export const KMA_OPERATIONS = Object.freeze({
  /** 초단기실황: what was observed at the top of the hour. */
  now: `${SERVICE}/getUltraSrtNcst`,
  /** 초단기예보: each of the next six hours. */
  hours: `${SERVICE}/getUltraSrtFcst`,
  /** 단기예보: hourly for three days and three-hourly after, with each day's TMN and TMX. */
  days: `${SERVICE}/getVilageFcst`,
});
export type KmaOperation = keyof typeof KMA_OPERATIONS;

/**
 * When each operation is issued, how long after that it answers, and how it wants to be asked.
 *
 * `delay` IS MEASURED, AND ONLY HAS TO BE NEARLY RIGHT. An issuance asked for before it is out
 * answers NO_DATA in a tenth of a second and `latest` steps back one; an issuance asked for late is
 * a person told an hour-old temperature. So the two hourly delays are the first whole minute by
 * which the hub had published, on both hours it was watched (2026-10-02, asked once a minute):
 *
 *   초단기실황  01:00 first answered between 01:04:40 and 01:05:41; 02:00 between 02:04:26 and 02:05:27
 *   초단기예보  the 01 hour between 01:12:45 and 01:13:46; the 02 hour between 02:13:32 and 02:14:33
 *
 * 단기예보 leans the other way. The hub was already answering the 02:00 issuance at 00:43, an hour
 * and a quarter before its own clock time, with the rows it still had at 02:15 — and "02:00 발표"
 * said at a quarter to one is not something to put in front of a person. So an issuance is used
 * from ten past its clock time: a margin that was chosen, not measured, since none was seen to
 * arrive late. If one does, NO_DATA and one step back cover it.
 *
 * `minutes` is the base_time's minute part as the hub's own page spells it for each operation. The
 * hub snaps 초단기예보 to the hour whatever is sent.
 */
const SCHEDULE: Record<
  KmaOperation,
  { every: number; first: number; delay: number; minutes: string; rows: number }
> = {
  now: { every: HOUR, first: 0, delay: 6 * MINUTE, minutes: "00", rows: 60 },
  hours: {
    every: HOUR,
    first: 0,
    delay: 15 * MINUTE,
    minutes: "30",
    rows: 100,
  },
  days: {
    every: 3 * HOUR,
    first: 2 * HOUR,
    delay: 10 * MINUTE,
    minutes: "00",
    rows: 1_100,
  },
};

/** One issuance: how to ask for it, and when the one after it is due to answer. */
export type KmaIssuance = {
  /** `base_date`, YYYYMMDD in KST. */
  date: string;
  /** `base_time`, HHmm in KST. */
  time: string;
  /** The instant the NEXT issuance is expected to answer — how long this one is the newest. */
  supersededAt: number;
};

/**
 * The newest issuance that should be answering at `at`, or the one `back` before it. The clock work
 * is `kstIssuanceAt`'s, which 중기예보 asks the same way (`kma-mid-forecast.ts`); what is this
 * operation's own is the minute part the hub wants to be asked with.
 */
export function issuanceAt(
  operation: KmaOperation,
  at: Date,
  back = 0,
): KmaIssuance {
  const schedule = SCHEDULE[operation];
  const { date, hour, supersededAt } = kstIssuanceAt(schedule, at, back);
  return { date, time: `${hour}${schedule.minutes}`, supersededAt };
}

/**
 * The raw cap: how much of one answer is read before refusing.
 *
 * The largest honest answer measured is 140 KB (the 17:00 단기예보), so a megabyte is a bound on
 * the hub misbehaving. Refused rather than truncated: half a JSON body parses as nothing.
 */
export const RAW_RESPONSE_CAP_CHARS = 1_000_000;
/** data.go.kr's code for "nothing there", which here is "not issued yet". */
const NO_DATA = "03";
/**
 * How many answers are kept. A deployment asks about a handful of cells, four entries each and two
 * more for 중기예보's regions; this is a bound on a Bot walking the map. A 단기예보 entry is its five hundred read values, some tens
 * of kilobytes, so a full table is a few megabytes.
 */
const MAX_KEPT = 64;
/** A fallback issuance is kept at least this long, so a late publication is not asked for per call. */
const KEEP_AT_LEAST_MS = 2 * MINUTE;
/**
 * The first rows of a day's 02:00 단기예보: its forecast times 03:00 to 16:00, which is as far as
 * that day's TMN (at 06:00) and TMX (at 15:00). 158 rows reach them; 22 KB instead of 126.
 */
const MORNING_ROWS = 170;

const TOOL = "get_weather";

/*
 * The description is Korean and short because it is prompt. It says "do not search or browse"
 * because that is the habit this tool replaces, and "한국 안만" because the grid ends at the sea.
 *
 * TWO WORDINGS, AND WHICH ONE IS OFFERED IS DECIDED BY THE TABLE. A place in words is looked up in
 * 기상청's own table of 시·군·구 and 읍·면·동 (`kma-places.ts`), which this repository ships
 * generated from 기상청's spreadsheet. The other wording is for a table with no rows — the state
 * this was first committed in, and the state a checkout is in if the generated module is ever
 * emptied: then there is no `place` argument and the description does not mention names. An
 * argument that can only ever answer "not found" is a control that does nothing, and a Bot offered
 * it would use it first every time.
 */
export function kmaWeatherTools(
  withPlaceNames: boolean,
  /**
   * Whether this deployment carries the key the days past the 단기예보 are asked with. A Bot told
   * "열흘" on a deployment with no such key would promise a week it can never have, so without the
   * key it is told three or four days. Carrying the key is all that can be known at boot: whether
   * the service accepts it is known when it is asked, and a key it refuses is an answer that names
   * the days it lacks (`unavailable`) — which is how a VM planted before the key was replaced reads.
   */
  withLaterDays = false,
): readonly PartnerToolSpec[] {
  const reach = withLaterDays ? "최대 열흘 뒤까지" : "3~4일 뒤까지";
  const what = `기상청 날씨. 지금 기온·습도·강수와 앞으로 6시간, 오늘부터 ${reach} 날짜별 예보(최저·최고, 오전·오후 하늘과 강수확률, 비·눈)를 한 번에 준다. 날씨는 검색하거나 브라우저로 찾지 말고 이것으로 답한다. 한국 안만. 결과에 shown이 있으면 예보가 이미 화면에 날씨 카드로 표시된 것이니, 답에서는 예보와 출처를 다시 적지 말고 물은 것에만 한 문장으로 답한다.`;
  const coordinates = {
    latitude: {
      type: "number",
      description: withPlaceNames
        ? "위도. 지명 대신 좌표로 물을 때만, longitude와 함께"
        : "위도. longitude와 함께 준다. 예: 서울 37.57",
    },
    longitude: {
      type: "number",
      description: withPlaceNames ? "경도" : "경도. 예: 서울 126.98",
    },
  };
  return Object.freeze([
    {
      name: TOOL,
      description: withPlaceNames
        ? `${what} 인자 없이 부르면 이 사람의 저장된 위치 기준이고, 다른 곳은 place에 지명을 적는다.`
        : `${what} 인자 없이 부르면 이 사람 기기에서 받은 위치 기준이고, 그 값이 없거나 다른 곳을 물으면 위도·경도를 준다.`,
      inputSchema: {
        type: "object",
        properties: withPlaceNames
          ? {
              place: {
                type: "string",
                description:
                  "지명. 시·군·구나 읍·면·동 이름만. 예: 서울 종로구, 춘천, 해운대. 같은 이름이 여러 곳이면 시·도를 붙인다(강원 고성, 부산 중구)",
              },
              ...coordinates,
            }
          : coordinates,
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
  ]);
}

/** What this deployment offers: with place names exactly when the shipped table has rows. */
export const KMA_WEATHER_TOOLS: readonly PartnerToolSpec[] = kmaWeatherTools(
  KMA_PLACES.size > 0,
);

/** A refusal a Bot reads as Korean, with the detail kept for the trail. */
function refuseWith(code: string, detail?: string): never {
  throw new PluginRefusedError(
    detail ? `${code}: ${detail}` : code,
    null,
    code,
  );
}

/* ── reading 기상청's values ─────────────────────────────────────────────────────────────────── */

/** One value of one answer: 실황 rows carry no forecast time, so theirs are empty. */
type Reading = { category: string; date: string; time: string; value: string };
/** One operation's answer, cut down to what is read, under the issuance the hub echoed. */
type Issued = { base: string; readings: Reading[] };
/** The values of one forecast time, by category. */
type Slot = Record<string, string | undefined>;

/** The categories each operation is read for. The other half of a 단기예보 body is wind and waves. */
const READ: Record<KmaOperation, ReadonlySet<string>> = {
  now: new Set(["T1H", "REH", "PTY", "RN1", "WSD"]),
  hours: new Set(["T1H", "SKY", "PTY", "RN1"]),
  days: new Set(["TMP", "SKY", "PTY", "POP", "PCP", "SNO", "TMN", "TMX"]),
};

/**
 * 하늘상태. The codes are 1, 3 and 4 — the three every measured body used; there is no 2. The
 * words are the ones the app's card reads the sky back from (`shared/weather.ts`).
 */
const SKY: Readonly<Record<string, string>> = {
  "1": SKY_WORDS.clear,
  "3": SKY_WORDS.cloudy,
  "4": SKY_WORDS.overcast,
};
/**
 * 강수형태, as the service is documented to use it: 0–4 in 단기예보, with 5–7 for the two 초단기
 * operations. Only 0 and 1 were in any body measured — the country was dry — so the rest of this
 * table is the documentation's word, and a code outside it is still said as precipitation.
 */
const FALLING: Readonly<Record<string, string>> = {
  "1": "비",
  "2": "비/눈",
  "3": "눈",
  "4": "소나기",
  "5": "빗방울",
  "6": "빗방울눈날림",
  "7": "눈날림",
};
const NONE = NOTHING_FALLS;
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;
const DAYS_AHEAD = [TODAY, "내일", "모레", "글피", "그글피"] as const;

/**
 * A number 기상청 sent as text, or null for one that is not a measurement.
 *
 * ±900 and beyond is the service's own "missing" (-999, -998, -998.9 were all seen in one sea
 * cell's observation). Null rather than zero: zero degrees is a temperature.
 */
function measure(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) < 900 ? number : null;
}

/**
 * An amount of rain or snow as a person reads it, or null for none.
 *
 * 기상청 writes one category three ways: "강수없음" / "적설없음"; a range in words that is already
 * plain Korean ("1mm 미만" was measured; "30.0~50.0mm" and "50.0mm 이상" are documented), which is
 * passed on as written; and, past the second day, a bare number with the unit left off.
 */
function amount(value: string | undefined, unit: "mm" | "cm"): string | null {
  const said = (value ?? "").trim();
  if (said === "" || said.endsWith("없음")) return null;
  const number = Number(said);
  if (!Number.isFinite(number)) return said;
  return number > 0 && number < 900 ? `${number}${unit}` : null;
}

/** What is falling and how much: "없음", "비", "비 1mm 미만", "눈날림". */
function falling(code: string | undefined, much: string | null): string {
  const kind = fallingKind(code);
  if (!kind && !much) return NONE;
  return [kind ?? "강수", much].filter(Boolean).join(" ");
}

function fallingKind(code: string | undefined): string | null {
  const number = measure(code);
  if (number === null || number <= 0) return null;
  // A code this file has no word for is still precipitation, and is said as that.
  return FALLING[String(number)] ?? "강수";
}

/** The forecast times of an answer, in order, each with its values. */
function slotsOf(issued: Issued): [string, Slot][] {
  const slots = new Map<string, Slot>();
  for (const reading of issued.readings) {
    const key = `${reading.date}${reading.time}`;
    const slot = slots.get(key) ?? {};
    slot[reading.category] = reading.value;
    slots.set(key, slot);
  }
  return [...slots.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// `dateMs` and `dayAfter` — a calendar date held as if it were UTC, which is how every date in
// this file is worked — are `kma-mid-forecast.ts`'s, which counts its days the same way.

const weekdayOf = (date: string) =>
  WEEKDAYS[new Date(dateMs(date)).getUTCDay()];

/** `202610012300` as a person reads an issuance: `10-01 23:00`. */
const stampOf = (base: string) =>
  `${base.slice(4, 6)}-${base.slice(6, 8)} ${base.slice(8, 10)}:${base.slice(10, 12)}`;

/** The observation: 기온, 습도, what is falling, 풍속 — or null where nothing was observed. */
function nowOf(issued: Issued) {
  const [, slot] = slotsOf(issued)[0] ?? [];
  if (!slot) return null;
  const temp = measure(slot.T1H);
  const humidity = measure(slot.REH);
  if (temp === null && humidity === null) return null;
  return {
    temp,
    humidity,
    precip: falling(slot.PTY, amount(slot.RN1, "mm")),
    wind: measure(slot.WSD),
  };
}

/**
 * An hour as it is said: "23시", and past midnight "내일 0시" — six hours from ten at night cross
 * into tomorrow, and "0시" alone reads as the midnight already gone.
 */
function hourSaid(key: string, today: string): string {
  const date = key.slice(0, 8);
  const hour = `${Number(key.slice(8, 10))}시`;
  if (date === today) return hour;
  if (date === dayAfter(today, 1)) return `내일 ${hour}`;
  return `${Number(date.slice(4, 6))}/${Number(date.slice(6, 8))} ${hour}`;
}

/** The hours still ahead, six at most, each said by its hour. */
function hoursOf(issued: Issued, at: Date) {
  const thisHour = `${kstStamp(at).slice(0, 10)}00`;
  const today = thisHour.slice(0, 8);
  return slotsOf(issued)
    .filter(([key]) => key >= thisHour)
    .slice(0, 6)
    .map(([key, slot]) => ({
      at: hourSaid(key, today),
      temp: measure(slot.T1H),
      sky: SKY[slot.SKY ?? ""],
      precip: falling(slot.PTY, amount(slot.RN1, "mm")),
    }));
}

/** Up to three different things, in the order they first appeared. */
const firstThree = (values: (string | null)[]) =>
  [...new Set(values.filter((value): value is string => value !== null))].slice(
    0,
    3,
  );

/**
 * What falls on one day: the kinds, the hours it spans, and the amounts as 기상청 wrote them.
 *
 * THE AMOUNTS ARE LISTED, NOT ADDED UP. Half of them are words ("1mm 미만"), and on an issuance's
 * last day a row stands for three hours without the body saying whether its number is for one of
 * them or all three. A total would be arithmetic on things that are not numbers.
 */
function fallingOver(slots: [string, Slot][]): {
  precip: string;
  snow?: string;
} {
  const hourOf = (key: string) => Number(key.slice(8, 10));
  const wet = slots
    .map(([key, slot], index) => ({ key, slot, index }))
    .filter(
      ({ slot }) =>
        fallingKind(slot.PTY) !== null ||
        amount(slot.PCP, "mm") !== null ||
        amount(slot.SNO, "cm") !== null,
    );
  const [first] = wet;
  const last = wet[wet.length - 1];
  if (!first || !last) return { precip: NONE };

  // How long the last wet time stands for: to the next time in the body, or as long as the one before.
  const next = slots[last.index + 1];
  const previous = slots[last.index - 1];
  const step = next
    ? hourOf(next[0]) - hourOf(last.key)
    : previous
      ? hourOf(last.key) - hourOf(previous[0])
      : 1;
  const until = Math.min(24, hourOf(last.key) + Math.max(1, step));
  const kinds = firstThree(wet.map(({ slot }) => fallingKind(slot.PTY)));
  const much = firstThree(wet.map(({ slot }) => amount(slot.PCP, "mm")));
  const snow = firstThree(wet.map(({ slot }) => amount(slot.SNO, "cm")));
  return {
    precip: `${kinds.length > 0 ? kinds.join("·") : "강수"} ${hourOf(first.key)}~${until}시${much.length > 0 ? `(${much.join("·")})` : ""}`,
    ...(snow.length > 0 ? { snow: snow.join("·") } : {}),
  };
}

/** One half of a day: the sky it mostly is, and the highest chance of rain in it. */
function halfOf(
  slots: [string, Slot][],
  from: number,
  to: number,
): string | undefined {
  const part = slots.filter(([key]) => {
    const hour = Number(key.slice(8, 10));
    return hour >= from && hour < to;
  });
  const counts = new Map<string, number>();
  for (const [, slot] of part) {
    if (slot.SKY) counts.set(slot.SKY, (counts.get(slot.SKY) ?? 0) + 1);
  }
  // The commonest sky; on a tie the cloudier one, which is the one a person plans around.
  const [sky] = [...counts.entries()].sort(
    ([a, countA], [b, countB]) => countB - countA || Number(b) - Number(a),
  )[0] ?? [undefined];
  const chances = part
    .map(([, slot]) => measure(slot.POP))
    .filter((chance): chance is number => chance !== null);
  const said = [
    sky ? SKY[sky] : undefined,
    chances.length > 0 ? `${Math.max(...chances)}%` : undefined,
  ].filter(Boolean);
  return said.length > 0 ? said.join(" ") : undefined;
}

/**
 * A row per day, today first.
 *
 * WHAT IS LEFT OF TODAY, NOT TODAY. The hours already gone are not in an issuance and are not what
 * "오늘 비 와?" asks, so today's 오전, 오후 and rain are read from this hour on — and left out, not
 * said as "없음", once there is nothing left to read. 최저 and 최고 are the whole day's: they come
 * from TMN (filed at 06:00) and TMX (at 15:00). The newest issuance's are used when it has them —
 * 기상청 revises them through the day (the 1st's 최고 was 22 at 02:00 and 20 at 05:00) — and
 * `morning`, that day's 02:00 issuance, stands in for the one it has dropped (`morningOf`).
 *
 * A day counts only if it has a 최저 or a 최고. The last forecast time of every issuance is midnight
 * of the day after its last full day, and one row at 00:00 is not a day.
 */
function daysOf(issued: Issued, morning: Issued | null, at: Date) {
  const stamp = kstStamp(at);
  const today = stamp.slice(0, 8);
  const thisHour = `${stamp.slice(0, 10)}00`;
  const all = slotsOf(issued);
  const early = morning ? slotsOf(morning) : [];
  const extreme = (slots: [string, Slot][], category: "TMN" | "TMX") => {
    for (const [, slot] of slots) {
      const value = measure(slot[category]);
      if (value !== null) return value;
    }
    return null;
  };

  const rows: DayRow[] = [];
  for (let ahead = 0; ahead < DAYS_AHEAD.length; ahead++) {
    const date = dayAfter(today, ahead);
    const ofDate = (slots: [string, Slot][]) =>
      slots.filter(([key]) => key.startsWith(date));
    const whole = ofDate(all);
    const min =
      extreme(whole, "TMN") ??
      (ahead === 0 ? extreme(ofDate(early), "TMN") : null);
    const max =
      extreme(whole, "TMX") ??
      (ahead === 0 ? extreme(ofDate(early), "TMX") : null);
    const left = ahead === 0 ? whole.filter(([key]) => key >= thisHour) : whole;
    if (min === null && max === null && (ahead > 0 || left.length === 0)) {
      continue;
    }
    rows.push({
      date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
      day: weekdayOf(date),
      when: DAYS_AHEAD[ahead],
      min,
      max,
      ...(left.length > 0
        ? {
            am: halfOf(left, 0, 12),
            pm: halfOf(left, 12, 24),
            ...fallingOver(left),
          }
        : {}),
    });
  }
  return rows;
}

/** A row of the answer's `days`: 단기예보's, and after them 중기예보's. */
type DayRow = {
  date: string;
  day: string | undefined;
  when: string | undefined;
  min: number | null;
  max: number | null;
  am?: string;
  pm?: string;
  /** One sky and one chance for the whole day: 중기예보 from its eighth day. */
  allDay?: string;
  precip?: string;
  snow?: string;
};

/**
 * The days past the 단기예보's, as rows of the same shape.
 *
 * ONLY THE DAYS AFTER ITS LAST ONE. Where both forecasts have a day — the fourth, most evenings —
 * the 단기예보's is the one said: it is for the five-kilometre cell and by the hour, and 중기예보's
 * is for the 시·군 and the half day. And never today or before: an issuance that is still the newest
 * past midnight has not got older, but its first days may have become days the answer already has.
 */
function laterRows(later: KmaMidDay[], short: DayRow[], at: Date): DayRow[] {
  const today = kstStamp(at).slice(0, 8);
  const last = short[short.length - 1]?.date.replaceAll("-", "") ?? today;
  return later
    .filter((day) => day.date > last)
    .map((day) => ({
      date: `${day.date.slice(0, 4)}-${day.date.slice(4, 6)}-${day.date.slice(6, 8)}`,
      day: weekdayOf(day.date),
      // 그글피 is as far as the words go; after it a day is its date and its weekday.
      when: DAYS_AHEAD[
        Math.round((dateMs(day.date) - dateMs(today)) / (24 * HOUR))
      ],
      min: day.min,
      max: day.max,
      ...(day.am ? { am: day.am } : {}),
      ...(day.pm ? { pm: day.pm } : {}),
      ...(day.allDay ? { allDay: day.allDay } : {}),
      ...(day.precip ? { precip: day.precip } : {}),
    }));
}

/**
 * The days neither forecast has, between the last of one and the first of the other, each named.
 *
 * THE TWO NORMALLY MEET (`kma-mid-forecast.ts` says why). They do not when the evening's 단기예보 is
 * more than an hour late: the answer then holds the afternoon's, which ends a day sooner, beside an
 * evening 중기예보 that begins a day later. A day left out between two rows reads as a week with no
 * hole in it, so it is said: "10월 8일 예보".
 */
function daysBetween(short: DayRow[], beyond: DayRow[]): string[] {
  const last = short[short.length - 1]?.date.replaceAll("-", "");
  const first = beyond[0]?.date.replaceAll("-", "");
  if (!last || !first) return [];
  const missing: string[] = [];
  for (let date = dayAfter(last, 1); date < first; date = dayAfter(date, 1)) {
    missing.push(
      `${Number(date.slice(4, 6))}월 ${Number(date.slice(6, 8))}일 예보`,
    );
  }
  return missing;
}

/** What each part of the answer is called when it could not be had. */
const PART_NAMES: Record<KmaOperation | "later", string> = {
  now: "현재 관측",
  hours: "시간별 예보",
  days: "날짜별 예보",
  later: "5~10일 뒤 예보",
};

/**
 * The answer a model reads.
 *
 * A part that could not be had is NAMED in `unavailable` rather than left out quietly: a Bot that
 * finds no `now` and no word about it fills the gap, and a temperature nobody measured is the one
 * thing this tool exists not to say.
 */
function summariseWeather(input: {
  at: Date;
  place: string;
  /** Whether the place is the person's saved one rather than one the call named. */
  saved: boolean;
  /**
   * The place as FACTS beside its words: the name alone, and the coordinates alone. The surface
   * draws these (review, round 9: the card drew "위도 37.57, 경도 126.98" — the server's own Korean —
   * where the surface owns the words), and the model reads `place`.
   */
  placeName?: string | undefined;
  coordinates?: { latitude: number; longitude: number } | undefined;
  /** Where the answer will be drawn (`DrawnOn`, `transport.ts`): a card in a conversation, or nowhere. */
  drawnOn: DrawnOn;
  now: Issued | null;
  hours: Issued | null;
  days: Issued | null;
  morning: Issued | null;
  /**
   * 중기예보's days, or null on a deployment that does not ask for them. An answer that asked and
   * got none still has the field, empty: that is a part that could not be had, and is named.
   */
  later: KmaMidAnswer | null;
}): string {
  const now = input.now ? nowOf(input.now) : null;
  const hours = input.hours ? hoursOf(input.hours, input.at) : [];
  const short = input.days ? daysOf(input.days, input.morning, input.at) : [];
  const beyond = input.later
    ? laterRows(input.later.days, short, input.at)
    : [];
  const days = [...short, ...beyond];
  const unavailable = [
    ...(now ? [] : [PART_NAMES.now]),
    ...(hours.length > 0 ? [] : [PART_NAMES.hours]),
    ...(short.length > 0 ? [] : [PART_NAMES.days]),
    ...(input.later && beyond.length === 0 ? [PART_NAMES.later] : []),
    ...daysBetween(short, beyond),
  ];
  return JSON.stringify({
    source: "기상청",
    place: input.place,
    ...(input.placeName ? { placeName: input.placeName } : {}),
    ...(input.coordinates ? { coordinates: input.coordinates } : {}),
    ...(input.saved ? { basis: "저장된 위치" } : {}),
    issued: {
      ...(input.now && now ? { now: stampOf(input.now.base) } : {}),
      ...(input.hours && hours.length > 0
        ? { hours: stampOf(input.hours.base) }
        : {}),
      ...(input.days && short.length > 0
        ? { days: stampOf(input.days.base) }
        : {}),
      ...(input.later?.issued && beyond.length > 0
        ? { later: stampOf(input.later.issued) }
        : {}),
    },
    units: "기온 ℃, 습도·강수확률 %, 바람 m/s",
    ...(now ? { now } : {}),
    ...(hours.length > 0 ? { hours } : {}),
    ...(days.length > 0 ? { days } : {}),
    ...(unavailable.length > 0 ? { unavailable } : {}),
    /*
     * The last thing the model reads before it answers: a fact (`WEATHER_SHOWN`) — and only where
     * it is one. The card draws a temperature now or a day; an answer with neither has no card,
     * and is not told it has. And a card is drawn only where the call's row is drawn — in a
     * conversation: a routine's answer reaches the person as the Bot's words alone, with no card
     * under them, so a routine's forecast is written out as it was before there were cards
     * (review, round 7: told the forecast was shown, the morning routine would have said one vague
     * sentence about it).
     */
    ...(input.drawnOn === "conversation" &&
    ((now && now.temp !== null) || days.length > 0)
      ? { shown: WEATHER_SHOWN }
      : {}),
  });
}

/* ── the transport ───────────────────────────────────────────────────────────────────────────── */

/** A latitude or longitude the model sent: a number, a number written as text, or not one. */
function degreesArg(
  args: Record<string, unknown>,
  key: string,
): number | null | "bad" {
  const value = args[key];
  if (value === undefined || value === null) return null;
  // Blank is "not given", and must be caught before `Number`, which reads "" as zero.
  if (typeof value === "string" && value.trim() === "") return null;
  const number = typeof value === "string" ? Number(value.trim()) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : "bad";
}

/** Which refusal to give when every part failed: the one that says the most about what to fix. */
const REFUSAL_ORDER = [
  "laf:weather_not_open",
  "laf:weather_refused",
  "laf:weather_unreachable",
  "laf:weather_unreadable",
  "laf:weather_too_large",
  "laf:weather_no_data",
];

export function createKmaWeatherTransport(input: {
  /** The fleet's API hub key, as the environment carries it. Sent as `authKey`. */
  authKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** The person's saved coordinates — their device's, already coarse — or null. */
  coordinatesOf?: (
    actorId: string,
  ) => Promise<{ latitude: number; longitude: number } | null>;
  /** The person's saved place in their own words ("서울 강남구"), or null. Read through the table. */
  placeOf?: (actorId: string) => Promise<string | null>;
  /** The table names are looked up in. The one this repository ships unless a test hands another. */
  places?: KmaPlaces;
  /**
   * The public data portal's key, where the deployment carries one: the days past the 단기예보 are
   * asked for with it (`kma-mid-forecast.ts`). Without it nothing is asked there and the answer is
   * the three or four days it always was.
   */
  serviceKey?: string;
  /** Which 중기예보 regions a cell is in. The shipped table's unless a test hands another. */
  midRegions?: KmaMidRegions;
}): VendorTransport {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const places = input.places ?? KMA_PLACES;
  const midRegions = input.midRegions ?? KMA_MID_REGIONS;
  const tools = kmaWeatherTools(places.size > 0, Boolean(input.serviceKey));

  /*
   * The key in every spelling an error could quote it in: as held, as the query string carries it
   * (which is what a runtime's "failed to fetch <url>" repeats) and as a vendor would re-encode it.
   * Today's key is twenty-two letters and digits and all three are one string; the next one need
   * not be. A refusal's detail is the `mcp.call_failed` row that goes to the admin page and the
   * person's export.
   */
  const spellings = [
    input.authKey,
    new URLSearchParams({ k: input.authKey }).toString().slice(2),
    encodeURIComponent(input.authKey),
  ];
  // A declaration rather than an arrow, so a call to it narrows like the `never` it returns.
  // Cut first and shortened second: a cap applied first can leave half a key standing.
  function refuse(code: string, detail: string): never {
    return refuseWith(
      code,
      trimDetail(withoutCredential(detail, ...spellings)),
    );
  }

  /**
   * One request to the hub: the rows this file reads, or null for "not issued yet".
   *
   * Every way the hub says no becomes a code. Its gateway answers in a different envelope from the
   * service behind it — `{"result":{"status","message"}}` with a real HTTP status — so that is read
   * first, and the 403 that means "nobody applied for this operation" gets its own code: it is the
   * one refusal an operator fixes on a web page rather than waits out.
   */
  async function ask(
    operation: KmaOperation,
    issuance: { date: string; time: string },
    cell: KmaCell,
    rows: number,
  ): Promise<Issued | null> {
    const query = new URLSearchParams({
      pageNo: "1",
      numOfRows: String(rows),
      dataType: "JSON",
      base_date: issuance.date,
      base_time: issuance.time,
      nx: String(cell.nx),
      ny: String(cell.ny),
      authKey: input.authKey,
    });

    let response: Response;
    try {
      response = await fetchImpl(`${KMA_OPERATIONS[operation]}?${query}`, {
        method: "GET",
        headers: { accept: "application/json" },
        // The key rides on the query string, so a redirect would carry it wherever the answer said.
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS.rest),
      });
    } catch (error) {
      refuse(
        "laf:weather_unreachable",
        error instanceof Error ? error.message : String(error),
      );
    }

    const raw = await response.text().catch(() => "");
    if (raw.length > RAW_RESPONSE_CAP_CHARS) {
      refuse("laf:weather_too_large", `${raw.length} characters`);
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Left null: an HTTP failure is still worth its status, and a 200 that is not JSON is below.
    }

    const gateway = (parsed as { result?: { message?: unknown } } | null)
      ?.result;
    if (!response.ok || gateway) {
      const said =
        typeof gateway?.message === "string" ? gateway.message.trim() : "";
      const detail = `HTTP ${response.status}${said ? ` ${said}` : ""}`;
      if (response.status === 403 && said.includes("활용신청")) {
        refuse("laf:weather_not_open", detail);
      }
      refuse("laf:weather_refused", detail);
    }
    if (parsed === null) {
      // The head of it is enough to tell a maintenance page from a proxy's error — and the key is
      // cut out before the head is taken, for the reason `refuse` gives.
      refuse(
        "laf:weather_unreadable",
        withoutCredential(raw, ...spellings).slice(0, 120),
      );
    }

    const header = vendorHeaderOf(parsed);
    if (!header) refuse("laf:weather_unreadable", "no header");
    const resultCode = String(header.resultCode);
    if (resultCode === NO_DATA) return null;
    if (resultCode !== "00") {
      refuse(
        "laf:weather_refused",
        `${resultCode} ${String(header.resultMsg ?? "")}`.trim(),
      );
    }

    const wanted = READ[operation];
    const readings: Reading[] = [];
    let base = `${issuance.date}${issuance.time}`;
    const body = (
      parsed as { response?: { body?: Parameters<typeof rowsOf>[0] } }
    ).response?.body;
    for (const row of rowsOf(body)) {
      const text = (key: string) =>
        typeof row[key] === "string" || typeof row[key] === "number"
          ? String(row[key])
          : "";
      // The issuance as the hub names it, which for 초단기예보 is not the one that was asked for.
      if (text("baseDate") && text("baseTime")) {
        base = `${text("baseDate")}${text("baseTime")}`;
      }
      const category = text("category");
      if (!wanted.has(category)) continue;
      readings.push({
        category,
        date: text("fcstDate"),
        time: text("fcstTime"),
        value: text("fcstValue") || text("obsrValue"),
      });
    }
    // A good header over no rows is the same fact as NO_DATA, whatever the code said.
    return readings.length > 0 ? { base, readings } : null;
  }

  /*
   * WHAT IS KEPT, AND FOR HOW LONG. One key serves every VM in the fleet, and the same cell is
   * asked about again and again — a morning routine, then the person, then a follow-up. An issuance
   * does not change once it is out (the 23:00 and 02:00 단기예보 bodies were row for row the same
   * when fetched again an hour and more later), so its rows are kept until the next one is due to
   * answer, in this process's memory (which is the right place: `docs/laf/deployment-model.md`).
   * The rows are kept, not the summary — what "the next six hours" and "today" mean moves with the
   * clock.
   *
   * The PROMISE is what is stored, so two questions arriving together make one request. A NO_DATA
   * and a failure are never kept: the first is "ask again in a minute", the second is nobody's
   * answer.
   */
  const kept = new Map<string, { until: number; answer: Promise<unknown> }>();
  /** `T` is whatever the key was first kept as: a key names one operation's one issuance. */
  function keeping<T>(
    key: string,
    until: number,
    fetchIt: () => Promise<T | null>,
  ): Promise<T | null> {
    const at = now().getTime();
    const held = kept.get(key);
    if (held && held.until > at) return held.answer as Promise<T | null>;
    for (const [other, entry] of kept) {
      if (entry.until <= at) kept.delete(other);
    }
    while (kept.size >= MAX_KEPT) {
      const [oldest] = kept.keys();
      if (oldest === undefined) break;
      kept.delete(oldest);
    }
    const entry = {
      // While the request is out, the entry stands; what it is worth is decided when it lands.
      until: Number.POSITIVE_INFINITY,
      answer: fetchIt(),
    };
    kept.set(key, entry);
    const forget = () => {
      if (kept.get(key) === entry) kept.delete(key);
    };
    entry.answer.then((issued) => {
      if (issued === null) forget();
      else entry.until = Math.max(until, now().getTime() + KEEP_AT_LEAST_MS);
    }, forget);
    return entry.answer;
  }

  /** 중기예보, on a deployment that carries the portal's key. Its answers are kept in the same table. */
  const mid = input.serviceKey
    ? createKmaMidForecast({
        serviceKey: input.serviceKey,
        fetchImpl,
        now,
        keeping,
      })
    : null;

  /** The newest issuance of one operation for one cell, stepping back once if it is not out. */
  async function latest(
    operation: KmaOperation,
    cell: KmaCell,
    at: Date,
  ): Promise<Issued> {
    for (const back of [0, 1]) {
      const issuance = issuanceAt(operation, at, back);
      const issued = await keeping(
        `${operation}|${issuance.date}${issuance.time}|${cell.nx},${cell.ny}`,
        issuance.supersededAt,
        () => ask(operation, issuance, cell, SCHEDULE[operation].rows),
      );
      if (issued) return issued;
    }
    return refuse("laf:weather_no_data", operation);
  }

  /**
   * Today's 02:00 issuance, when the newest one is a later one of today's.
   *
   * ONLY TWO ISSUANCES CARRY THE WHOLE DAY: last night's 23:00 and this morning's 02:00. Measured:
   * the 05:00 body's first forecast time is 06:00 and it has no TMN there — the row is not issued
   * for the hour an issuance starts at — and the 14:00 body, starting at 15:00, has no TMX. The
   * first draft of this asked for the morning only from 08:00, on the reasoning that 06:00 had not
   * passed until then; it would have answered a null 최저 between ten past five and ten past eight,
   * which is when people ask what to wear. A real 05:00 body is what showed it.
   *
   * Null when it is not needed, and null — not a refusal — when it cannot be had: a forecast
   * without today's 최저 is still a forecast.
   */
  async function morningOf(cell: KmaCell, at: Date): Promise<Issued | null> {
    const today = kstStamp(at).slice(0, 8);
    const newest = issuanceAt("days", at);
    if (newest.date !== today || newest.time < "0500") return null;
    // It never changes; it stops mattering when the day does, at the next midnight in Korea.
    const midnight = dateMs(today, 1) - KST_OFFSET_MS;
    return keeping(`morning|${today}|${cell.nx},${cell.ny}`, midnight, () =>
      ask("days", { date: today, time: "0200" }, cell, MORNING_ROWS),
    ).catch(() => null);
  }

  /** Where the question is about: what the call named, or else where the person is. */
  async function whereOf(
    actorId: string | undefined,
    args: Record<string, unknown>,
  ): Promise<{
    cell: KmaCell;
    /** The place in words for the model: a name, or coordinates written out, or both. */
    place: string;
    /** The name alone, where the table has one — what a screen draws. */
    placeName?: string;
    /** The coordinates alone, where the place was asked by them — a screen writes them in its own words. */
    coordinates?: { latitude: number; longitude: number };
    /** The names the place was found by, the 시·도 first — which 시·군 was meant (`kma-mid-regions.ts`). */
    levels?: readonly string[];
    saved: boolean;
  }> {
    /*
     * Coordinates are answered with the name of what is there, when the table has one. A device's
     * are true and a model's may be invented; either way the Bot is told which 시·군·구 the numbers
     * turned out to be, which is the only way it can notice they are not the place it meant.
     */
    const located = (latitude: number, longitude: number) => {
      const cell = kmaCellOf(latitude, longitude);
      if (!cell) return null;
      const near = places.nameOf(cell);
      const said = `위도 ${latitude.toFixed(2)}, 경도 ${longitude.toFixed(2)}`;
      return {
        cell,
        place: near ? `${near} (${said})` : said,
        ...(near ? { placeName: near } : {}),
        coordinates: {
          latitude: Number(latitude.toFixed(2)),
          longitude: Number(longitude.toFixed(2)),
        },
      };
    };
    const named = (words: string) => {
      const found = places.find(words);
      if (found.kind === "ambiguous") {
        // How many, never which: the names are somebody's whereabouts.
        refuse(
          "laf:weather_place_ambiguous",
          `${found.candidates.length} candidates`,
        );
      }
      return found.kind === "found"
        ? {
            cell: found.cell,
            place: found.name,
            placeName: found.name,
            levels: found.levels,
          }
        : null;
    };

    const latitude = degreesArg(args, "latitude");
    const longitude = degreesArg(args, "longitude");
    if (latitude !== null || longitude !== null) {
      if (typeof latitude !== "number" || typeof longitude !== "number") {
        refuse("laf:weather_coordinates_invalid", "one without the other");
      }
      const there = located(latitude, longitude);
      if (!there) refuse("laf:weather_place_outside", "argument");
      return { ...there, saved: false };
    }

    const asked = stringArg(args, "place");
    if (asked) {
      const there = named(asked);
      if (!there) refuse("laf:weather_place_not_found", "argument");
      return { ...there, saved: false };
    }

    /*
     * Nothing named: the person's own place. Their device's coordinates first, then the words they
     * or their Bot saved — both are one answer, kept together (`account/whereabouts.ts`). A run
     * with nobody attributed has no place to read, and is the same refusal as a person with none.
     */
    if (!actorId) refuse("laf:weather_place_unknown", "no actor");
    const coordinates = (await input.coordinatesOf?.(actorId)) ?? null;
    const byDevice = coordinates
      ? located(coordinates.latitude, coordinates.longitude)
      : null;
    if (byDevice) return { ...byDevice, saved: true };
    const words = (await input.placeOf?.(actorId)) ?? null;
    const byWords = words ? named(words) : null;
    if (byWords) return { ...byWords, saved: true };
    if (coordinates) refuse("laf:weather_place_outside", "saved");
    if (words) refuse("laf:weather_place_not_found", "saved");
    return refuse("laf:weather_place_unknown", "nothing saved");
  }

  async function weather(
    actorId: string | undefined,
    drawnOn: DrawnOn,
    args: Record<string, unknown>,
  ): Promise<string> {
    const at = now();
    const where = await whereOf(actorId, args);
    const operations = ["now", "hours", "days"] as const;
    // A place with no 중기예보 region — a cell out at sea — is asked nothing, and the part is named.
    const region = mid ? midRegions.of(where.cell, where.levels) : null;
    const nothingLater: KmaMidAnswer = { days: [], issued: null, failed: [] };
    const [answers, morning, later] = await Promise.all([
      Promise.allSettled(
        operations.map((operation) => latest(operation, where.cell, at)),
      ),
      morningOf(where.cell, at),
      mid ? (region ? mid.daysFor(region, at) : nothingLater) : null,
    ]);

    /*
     * ONE PART FAILING IS NOT THE ANSWER FAILING. The three are separate products on separate
     * clocks: an observation that is late, or a cell at sea where nothing is observed, should not
     * cost somebody tomorrow's forecast. So a part that could not be had is left out and named, and
     * the call is refused only when there is nothing at all — with the refusal that says most.
     */
    const failures = answers
      .map((answer, index) => ({ answer, operation: operations[index] }))
      .filter(({ answer }) => answer.status === "rejected")
      .map(({ answer, operation }) => ({
        operation,
        reason: (answer as PromiseRejectedResult).reason as unknown,
      }));
    if (failures.length === operations.length) {
      const refusals = failures
        .map(({ reason }) => reason)
        .filter(
          (reason): reason is PluginRefusedError =>
            reason instanceof PluginRefusedError,
        );
      const worst = REFUSAL_ORDER.map((code) =>
        refusals.find((refusal) => refusal.code === code),
      ).find((refusal) => refusal !== undefined);
      throw worst ?? failures[0]?.reason;
    }
    for (const { operation, reason } of failures) {
      // The part and the code, and nothing of where: an operator needs to know it is happening.
      log.warn("weather_part_unavailable", {
        part: operation,
        code: reason instanceof PluginRefusedError ? reason.code : "error",
      });
    }

    for (const code of later?.failed ?? []) {
      log.warn("weather_part_unavailable", { part: "later", code });
    }

    const had = (index: number) => {
      const answer = answers[index];
      return answer?.status === "fulfilled" ? answer.value : null;
    };
    return summariseWeather({
      at,
      place: where.place,
      placeName: where.placeName,
      coordinates: where.coordinates,
      saved: where.saved,
      drawnOn,
      now: had(0),
      hours: had(1),
      days: had(2),
      morning,
      later,
    });
  }

  return {
    listNeedsCredential: false,
    listTools: async () =>
      tools.map((tool) => ({ ...tool, annotations: { ...tool.annotations } })),
    callTool: async (connection, toolName, args): Promise<McpCallResult> => {
      if (toolName !== TOOL) {
        return refuseWith("laf:weather_unknown_tool", toolName);
      }
      return asResult(
        await weather(
          connection.actorId,
          connection.drawnOn ?? "nowhere",
          args,
        ),
      );
    },
  };
}

/**
 * This entry, as the deployment-key runtime takes it (`deployment-key-runtime.ts`).
 *
 * The person's place is read through the one reader the runtime hands over, once per call that
 * names no place: their device's coordinates first, then the words they saved. Both come from one
 * row, so a place cleared between the two reads is two honest answers and not a torn one.
 */
export const KMA_WEATHER_SERVICE: DeploymentKeyService = {
  key: KMA_WEATHER_KEY,
  family: "kma-apihub",
  tools: KMA_WEATHER_TOOLS,
  transport: ({ key, keys, fetchImpl, now, whereaboutsOf }) =>
    createKmaWeatherTransport({
      authKey: key,
      // The portal's key, when this deployment carries it too: days five to ten are asked with it.
      ...(keys?.["data-go-kr"] ? { serviceKey: keys["data-go-kr"] } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(now ? { now } : {}),
      ...(whereaboutsOf
        ? {
            coordinatesOf: async (actorId) =>
              (await whereaboutsOf(actorId)).coordinates,
            placeOf: async (actorId) => (await whereaboutsOf(actorId)).place,
          }
        : {}),
    }),
};
