/**
 * Days five to ten of the forecast: 기상청's 중기예보, through the public data portal (data.go.kr).
 *
 * WHY A SECOND DOOR. The 단기예보 the weather tool reads from 기상청's API hub ends three or four
 * days out, and the owner's card is a week (`weather-card.tsx`). The hub has 중기예보 too, but each
 * of its APIs is applied for one by one and that one answered 403 on the fleet's hub key. The same
 * data is on the public data portal as `MidFcstInfoService`, which the owner opened on 2026-10-04 —
 * so the days past the 단기예보 come from there, on the portal key the deployment already carries
 * for 나라장터 and 기업마당 (`DATA_GO_KR_SERVICE_KEY`). One tool still, and one answer: this file
 * only adds rows to it.
 *
 * IT IS NEVER THE ANSWER FAILING. A deployment without the portal key asks nothing here. One whose
 * key the service does not know — every VM planted before the key was replaced holds one that
 * answers 나라장터 and not this — gets its three or four days as before, with the days after named
 * as not had (`kma-weather-rest.ts`, `unavailable`), and is not asked again for ten minutes.
 *
 * WHAT WAS MEASURED on the portal with that key, 2026-10-04 between 22:00 and 24:00 KST:
 *
 *  - Two operations are read. `getMidTa` is each day's 최저 and 최고 for one 시·군 region
 *    (`regId=11B10101`), `getMidLandFcst` the sky and the chance of rain for one of ten broad
 *    regions (`regId=11B00000`). Which two regions a place is in is `kma-mid-regions.ts`'s. The
 *    third, `getMidFcst`, is a paragraph of prose for the whole country and is not read: the
 *    answer is facts.
 *  - One row each, the days as numbered fields: `taMin5`, `taMax5`, `wf5Am`, `wf5Pm`, `rnSt5Am`,
 *    `rnSt5Pm`, and from the eighth day one value a day (`wf8`, `rnSt8`). THE NUMBER IS DAYS AFTER
 *    THE ISSUANCE'S DATE, and where it starts depends on the issuance: the 06:00 body begins at 4
 *    and the 18:00 body at 5, with the same values under the same numbers. So the fields are read
 *    by whichever numbers are there, never by a fixed first day.
 *  - Issued at 06:00 and 18:00, asked for as `tmFc=YYYYMMDDHHmm`. An issuance not out yet answers
 *    `resultCode 03 NO_DATA` with HTTP 200 (tomorrow's 06:00 did), and so does one more than a day
 *    old (yesterday's 18:00 did at 23:53, while that morning's 06:00 still answered) and a region
 *    the service no longer issues. Two days back is `resultCode 99`. So 03 is "step back one
 *    issuance", once, as it is for the hub.
 *  - WHEN an issuance first answers was not measured: `ISSUED_AFTER_MS` is a margin that was
 *    chosen. Asked too early it is NO_DATA and the one before stands in, which is still the
 *    forecast for those days; nothing is said that was not issued.
 *  - A key the service does not know is HTTP 403 with the gateway's own envelope
 *    (`OpenAPI_ServiceResponse.cmmMsgHeader`, `returnReasonCode` 30), not the service's
 *    `response.header`.
 *
 * WHY THERE IS NO GAP between the two forecasts. From ten past six the 06:00 issuance starts four
 * days out and the 단기예보 of that morning reaches three. From ten past six in the evening the
 * 18:00 one starts five days out, and every 단기예보 from the 17:00 on reaches four. Past midnight
 * that same 18:00 issuance starts at what is now four days out. Where both have a day, 기상청's
 * finer forecast is the one said (`laterRows`).
 *
 * THE KEY GOES INTO THE QUERY STRING AS-IS, for `public-data-rest.ts`'s reason, so a redirect is
 * never followed — and nothing of the request or the answer is put in a failure: a failure here is
 * a code and nothing else, so there is no detail for a key to be quoted in.
 */
import { SKY_WORDS } from "../../../shared/weather";
import type { KmaMidRegion } from "./kma-mid-regions";
import { rowsOf, vendorHeaderOf } from "./public-data-rest";
import { TIMEOUT_MS } from "./timeouts";

/** The portal's one host, the same one the public-data entry pins. */
export const KMA_MID_HOST = "https://apis.data.go.kr";
const SERVICE = `${KMA_MID_HOST}/1360000/MidFcstInfoService`;

/** The two operations, by what each one is to a person. */
export const KMA_MID_OPERATIONS = Object.freeze({
  /** 중기기온조회: each day's 최저 and 최고, for a 시·군 region. */
  temperature: `${SERVICE}/getMidTa`,
  /** 중기육상예보조회: the sky and the chance of rain, for one of ten broad regions. */
  land: `${SERVICE}/getMidLandFcst`,
});
export type KmaMidOperation = keyof typeof KMA_MID_OPERATIONS;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const KST_OFFSET_MS = 9 * HOUR;
/** Twice a day, from 06:00 in Korea. */
const EVERY_MS = 12 * HOUR;
const FIRST_MS = 6 * HOUR;
/** How long after its clock time an issuance is asked for. Chosen, not measured (see above). */
const ISSUED_AFTER_MS = 10 * MINUTE;
/** A good answer is one row of sixty short fields, under a kilobyte. */
const MID_RESPONSE_CAP_CHARS = 100_000;
/** How long a key the service refused is not tried again. */
const CLOSED_FOR_MS = 10 * MINUTE;
const NO_DATA = "03";
/** The numbers a day's fields can carry: the service has started at 3, 4 and 5 over the years. */
const DAY_NUMBERS = [3, 4, 5, 6, 7, 8, 9, 10] as const;

/**
 * A calendar date (`20261002`), some days on, as milliseconds — the date held as if it were UTC, so
 * the calendar does the months and the years.
 */
export const dateMs = (date: string, days = 0) =>
  Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)) + days,
  );

/** `20261002` plus a number of days. */
export const dayAfter = (date: string, days: number) =>
  new Date(dateMs(date, days)).toISOString().slice(0, 10).replaceAll("-", "");

/** One issuance: how to ask for it, the date its day numbers count from, and how long it is the newest. */
export type KmaMidIssuance = {
  /** `tmFc`, YYYYMMDDHHmm in KST. */
  tmFc: string;
  /** Its date, YYYYMMDD in KST. */
  date: string;
  /** The instant the next issuance is expected to answer. */
  supersededAt: number;
};

/** The newest issuance that should be answering at `at`, or the one `back` before it. */
export function midIssuanceAt(at: Date, back = 0): KmaMidIssuance {
  const wall = at.getTime() + KST_OFFSET_MS - ISSUED_AFTER_MS;
  const base =
    Math.floor((wall - FIRST_MS) / EVERY_MS) * EVERY_MS +
    FIRST_MS -
    back * EVERY_MS;
  // `base` is KST wall clock held as if it were UTC, so the ISO text is the Korean date and hour.
  const text = new Date(base).toISOString();
  const date = `${text.slice(0, 4)}${text.slice(5, 7)}${text.slice(8, 10)}`;
  return {
    tmFc: `${date}${text.slice(11, 13)}00`,
    date,
    supersededAt: base + EVERY_MS + ISSUED_AFTER_MS - KST_OFFSET_MS,
  };
}

/** One day past the 단기예보, as the answer's row is built from it. */
export type KmaMidDay = {
  /** `20261009`. */
  date: string;
  min: number | null;
  max: number | null;
  /** "맑음 10%": days four to seven have a morning and an afternoon. */
  am?: string;
  pm?: string;
  /** "구름많음 20%": from the eighth day there is one sky and one chance for the whole day. */
  allDay?: string;
  /** What falls and in which half, where something does: "비(오후)", "눈(오전·오후)", "비/눈". */
  precip?: string;
};

/** One operation's one row, with the date its day numbers count from. */
export type KmaMidIssued = {
  tmFc: string;
  date: string;
  row: Record<string, unknown>;
};

/**
 * 날씨, as the land forecast writes it — the sky, then what falls: 맑음, 구름많음, 흐림, 구름많고 비,
 * 흐리고 눈, 구름많고 비/눈, 흐리고 소나기. Only the first three were in a body measured (the week
 * was dry); the rest is the service's documentation. The sky is said in the words the 단기예보 rows
 * use, which are the ones the card reads (`shared/weather.ts`).
 */
const SKY_OF: Readonly<Record<string, string>> = {
  맑음: SKY_WORDS.clear,
  구름많음: SKY_WORDS.cloudy,
  구름많고: SKY_WORDS.cloudy,
  흐림: SKY_WORDS.overcast,
  흐리고: SKY_WORDS.overcast,
};

function conditionOf(said: unknown): {
  sky: string | null;
  falls: string | null;
} {
  if (typeof said !== "string" || said.trim() === "") {
    return { sky: null, falls: null };
  }
  const [first = "", ...rest] = said.trim().split(/\s+/);
  const sky = SKY_OF[first];
  // A wording with no sky this table knows is passed on whole, as what falls: it is 기상청's word.
  if (!sky) return { sky: null, falls: said.trim() };
  return { sky, falls: rest.join(" ") || null };
}

/** A number the service sent, as a number or as text; anything else is not one. */
function numberOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** "맑음 10%", or either half of it, or nothing. */
function saidOf(sky: string | null, chance: number | null): string | undefined {
  const said = [sky, chance === null ? null : `${chance}%`].filter(Boolean);
  return said.length > 0 ? said.join(" ") : undefined;
}

/**
 * The days two rows hold, by date, in order.
 *
 * Either row may be missing — the two are separate requests — and they may be of different
 * issuances, when one was out and the other was not. So each is read against its own date and the
 * two are joined by the day they are about. A day with neither a temperature nor a sky is not a day.
 */
export function midDaysOf(
  temperature: KmaMidIssued | null,
  land: KmaMidIssued | null,
): KmaMidDay[] {
  const days = new Map<string, KmaMidDay>();
  const dayOf = (date: string) => {
    const day = days.get(date) ?? { date, min: null, max: null };
    days.set(date, day);
    return day;
  };
  for (const number of DAY_NUMBERS) {
    if (temperature) {
      const min = numberOf(temperature.row[`taMin${number}`]);
      const max = numberOf(temperature.row[`taMax${number}`]);
      if (min !== null || max !== null) {
        const day = dayOf(dayAfter(temperature.date, number));
        day.min = min;
        day.max = max;
      }
    }
    if (!land) continue;
    const half = (suffix: "Am" | "Pm" | "") => ({
      ...conditionOf(land.row[`wf${number}${suffix}`]),
      chance: numberOf(land.row[`rnSt${number}${suffix}`]),
    });
    const [am, pm, whole] = [half("Am"), half("Pm"), half("")];
    const date = dayAfter(land.date, number);
    if (am.sky || pm.sky || am.falls || pm.falls) {
      const day = dayOf(date);
      const morning = saidOf(am.sky, am.chance);
      const afternoon = saidOf(pm.sky, pm.chance);
      if (morning) day.am = morning;
      if (afternoon) day.pm = afternoon;
      const kinds = [...new Set([am.falls, pm.falls].filter(Boolean))];
      if (kinds.length > 0) {
        const when =
          am.falls && pm.falls ? "오전·오후" : am.falls ? "오전" : "오후";
        day.precip = `${kinds.join("·")}(${when})`;
      }
    } else if (whole.sky || whole.falls) {
      const day = dayOf(date);
      const said = saidOf(whole.sky, whole.chance);
      if (said) day.allDay = said;
      if (whole.falls) day.precip = whole.falls;
    }
  }
  return [...days.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
}

/** Why a request here came to nothing. A code and nothing else: see the file comment. */
export class KmaMidUnavailable extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "KmaMidUnavailable";
  }
}

/** What the weather tool is handed: the days, the issuance they are from, and what went wrong just now. */
export type KmaMidAnswer = {
  days: KmaMidDay[];
  /** `tmFc` of the temperatures' issuance, or the land forecast's when there are no temperatures. */
  issued: string | null;
  /** The codes of this call's own failures, for the operator's log. Empty while a refused key rests. */
  failed: string[];
};

export function createKmaMidForecast(input: {
  /** The portal key, in the spelling the environment carries. Sent as `serviceKey`, as-is. */
  serviceKey: string;
  fetchImpl: typeof fetch;
  now: () => Date;
  /** The weather transport's own table of kept answers: one promise per issuance and region. */
  keeping: <T>(
    key: string,
    until: number,
    fetchIt: () => Promise<T | null>,
  ) => Promise<T | null>;
}) {
  /** Until when the service is not asked: it refused the key, and will the next time too. */
  let closedUntil = 0;

  /** One request: the one row of a region's issuance, or null for "not issued". */
  async function ask(
    operation: KmaMidOperation,
    regId: string,
    issuance: KmaMidIssuance,
  ): Promise<KmaMidIssued | null> {
    const query = new URLSearchParams({
      pageNo: "1",
      numOfRows: "10",
      dataType: "JSON",
      regId,
      tmFc: issuance.tmFc,
    });
    let response: Response;
    try {
      response = await input.fetchImpl(
        `${KMA_MID_OPERATIONS[operation]}?serviceKey=${input.serviceKey}&${query}`,
        {
          method: "GET",
          headers: { accept: "application/json" },
          // The key rides on the query string, so a redirect would carry it wherever the answer said.
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS.addition),
        },
      );
    } catch {
      throw new KmaMidUnavailable("laf:weather_unreachable");
    }
    const raw = await response.text().catch(() => "");
    if (raw.length > MID_RESPONSE_CAP_CHARS) {
      throw new KmaMidUnavailable("laf:weather_too_large");
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Left null: the gateway also answers XML, and its refusals are told apart below.
    }
    const header = vendorHeaderOf(parsed);
    if (!response.ok || !header) {
      /*
       * The gateway, in JSON or in XML: a key it does not know, or one not approved for this
       * service. That is the one refusal an operator fixes on a web page, and the one that will be
       * the same on the next call.
       */
      if (
        /SERVICE_KEY_IS_NOT_REGISTERED|SERVICE[ _]ACCESS[ _]DENIED/.test(raw)
      ) {
        closedUntil = input.now().getTime() + CLOSED_FOR_MS;
        throw new KmaMidUnavailable("laf:weather_not_open");
      }
      throw new KmaMidUnavailable(
        response.ok ? "laf:weather_unreadable" : "laf:weather_refused",
      );
    }
    const resultCode = String(header.resultCode);
    if (resultCode === NO_DATA) return null;
    if (resultCode !== "00") throw new KmaMidUnavailable("laf:weather_refused");
    const body = (
      parsed as { response?: { body?: Parameters<typeof rowsOf>[0] } }
    ).response?.body;
    const [row] = rowsOf(body);
    return row ? { tmFc: issuance.tmFc, date: issuance.date, row } : null;
  }

  /** The newest issuance of one operation for one region, stepping back once if it is not out. */
  async function latest(
    operation: KmaMidOperation,
    regId: string,
    at: Date,
  ): Promise<KmaMidIssued | null> {
    for (const back of [0, 1]) {
      const issuance = midIssuanceAt(at, back);
      const issued = await input.keeping(
        `mid-${operation}|${issuance.tmFc}|${regId}`,
        issuance.supersededAt,
        () => ask(operation, regId, issuance),
      );
      if (issued) return issued;
    }
    return null;
  }

  return {
    /** The days past the 단기예보 for one place's two regions. Never throws. */
    async daysFor(region: KmaMidRegion, at: Date): Promise<KmaMidAnswer> {
      if (input.now().getTime() < closedUntil) {
        return { days: [], issued: null, failed: [] };
      }
      const [temperature, land] = await Promise.allSettled([
        latest("temperature", region.temperature, at),
        latest("land", region.land, at),
      ]);
      const failed = [temperature, land].flatMap((answer) =>
        answer.status === "rejected"
          ? [
              answer.reason instanceof KmaMidUnavailable
                ? answer.reason.code
                : "error",
            ]
          : [],
      );
      const had = (answer: PromiseSettledResult<KmaMidIssued | null>) =>
        answer.status === "fulfilled" ? answer.value : null;
      const days = midDaysOf(had(temperature), had(land));
      return {
        days,
        issued:
          days.length > 0
            ? (had(temperature)?.tmFc ?? had(land)?.tmFc ?? null)
            : null,
        // Both requests failing one way is one thing to tell an operator.
        failed: [...new Set(failed)],
      };
    },
  };
}
