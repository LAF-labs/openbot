import { describe, expect, test } from "bun:test";
import {
  createKmaPlaces,
  KMA_PLACES,
  parseKmaPlaces,
} from "../src/plugins/kma-places";
import {
  createKmaWeatherTransport,
  issuanceAt,
  KMA_HOST,
  KMA_OPERATIONS,
  KMA_WEATHER_KEY,
  KMA_WEATHER_TOOLS,
  type KmaOperation,
  kmaWeatherTools,
  RAW_RESPONSE_CAP_CHARS,
} from "../src/plugins/kma-weather-rest";
import { PluginRefusedError } from "../src/plugins/store";
import { stubFetch } from "./support/fetch";
import {
  BAD_KEY_BODY,
  NO_DATA_BODY,
  NOT_ALLOWED_BODY,
  NOT_APPLIED_BODY,
  OPEN_SEA,
  SEOUL_AFTERNOON,
  SEOUL_DAWN,
  SEOUL_EVENING,
  SEOUL_MIDNIGHT,
  SEOUL_SMALL_HOURS,
  shortForecast,
  TOO_OLD_BODY,
  veryShortForecast,
} from "./support/kma-fixtures";

/**
 * The weather tool, against what 기상청's API hub actually answers.
 *
 * NO LIVE HUB HERE, for public-data's reasons: a key is a quota, and a suite that needs the
 * weather to be reachable fails on the day the hub is slow. What IS live is in the fixtures — every
 * body in `support/kma-fixtures.ts` came back from apihub.kma.go.kr on 2026-10-01 and 2026-10-02 —
 * so the summary is held to 기상청's own rows, the refusals to its own envelopes, and the base
 * times to the issuances that were really being served at those minutes.
 *
 * The fake hub below answers a body only for the issuance that body is, and NO_DATA for any other,
 * which is what the real one does. So a test that passes has asked for the right base time.
 *
 * Where a test needs weather that did not happen on those two days — snow, a shower, the
 * "30.0~50.0mm" wording — the rows are written by hand, in the vendor's shape, and the test says so.
 */

/** A key with characters a query string must encode, so both spellings exist to be looked for. */
const KEY = "Canary+Key/0123456789==";
const KEY_AS_SENT = new URLSearchParams({ k: KEY }).toString().slice(2);

const SEOUL = { latitude: 37.5665, longitude: 126.978 };
const BUSAN = { latitude: 35.1796, longitude: 129.0756 };

/** A KST wall-clock time as the instant it is. */
const kst = (text: string) => new Date(`${text}+09:00`);

type Asked = {
  operation: KmaOperation;
  issuance: string;
  rows: number;
  cell: string;
  url: string;
  init: RequestInit | undefined;
};

function operationOf(url: string): KmaOperation {
  for (const [operation, address] of Object.entries(KMA_OPERATIONS)) {
    if (url.startsWith(`${address}?`)) return operation as KmaOperation;
  }
  throw new Error(`not one of the three operations: ${url.split("?")[0]}`);
}

/** Bodies by the issuance each one is: `"now 20261002/0000"`. Anything else is not issued yet. */
type Served = Record<string, string>;

const noData = () => new Response(NO_DATA_BODY, { status: 200 });

/** No rows: what a transport has before the table is generated, and what most tests here want. */
const NO_PLACES = createKmaPlaces([]);

/**
 * A transport over a fake hub, the clock it reads, and what the hub was asked.
 *
 * WITH NO TABLE OF NAMES unless a test hands one in. The table this repository ships has four
 * thousand rows and names every cell it is asked about, and a test about the forecast should not
 * change when 기상청 re-issues its spreadsheet. The tests about names say which table they mean.
 */
function hub(
  reply: Served | ((asked: Asked) => Response | Promise<Response>),
  options: Partial<Parameters<typeof createKmaWeatherTransport>[0]> & {
    at?: Date;
  } = {},
) {
  const asked: Asked[] = [];
  const clock = { at: options.at ?? kst("2026-10-02T00:45:00") };
  const { at: _at, ...rest } = options;
  const transport = createKmaWeatherTransport({
    authKey: KEY,
    places: NO_PLACES,
    now: () => clock.at,
    fetchImpl: stubFetch(async (address, init) => {
      const url = new URL(String(address));
      const record: Asked = {
        operation: operationOf(url.href),
        issuance: `${url.searchParams.get("base_date")}/${url.searchParams.get("base_time")}`,
        rows: Number(url.searchParams.get("numOfRows")),
        cell: `${url.searchParams.get("nx")},${url.searchParams.get("ny")}`,
        url: url.href,
        init,
      };
      asked.push(record);
      if (typeof reply === "function") return await reply(record);
      const body = reply[`${record.operation} ${record.issuance}`];
      return body === undefined
        ? noData()
        : new Response(body, { status: 200 });
    }),
    ...rest,
  });
  return { transport, asked, clock };
}

const MIDNIGHT: Served = {
  "now 20261002/0000": SEOUL_MIDNIGHT.now,
  "hours 20261002/0030": SEOUL_MIDNIGHT.hours,
  "days 20261001/2300": SEOUL_MIDNIGHT.days,
};
const AFTERNOON: Served = {
  "now 20261001/1400": SEOUL_AFTERNOON.now,
  "hours 20261001/1430": SEOUL_AFTERNOON.hours,
  "days 20261001/1400": SEOUL_AFTERNOON.days,
  "days 20261001/0200": SEOUL_AFTERNOON.morning,
};
const DAWN: Served = {
  "now 20261001/0500": SEOUL_DAWN.now,
  "hours 20261001/0530": SEOUL_DAWN.hours,
  "days 20261001/0500": SEOUL_DAWN.days,
  "days 20261001/0200": SEOUL_AFTERNOON.morning,
};
const EVENING: Served = {
  "now 20261001/1700": SEOUL_EVENING.now,
  "hours 20261001/1730": SEOUL_EVENING.hours,
  "days 20261001/1700": SEOUL_EVENING.days,
  "days 20261001/0200": SEOUL_AFTERNOON.morning,
};
const SMALL_HOURS: Served = {
  "now 20261002/0200": SEOUL_SMALL_HOURS.now,
  "hours 20261002/0230": SEOUL_SMALL_HOURS.hours,
  "days 20261002/0200": SEOUL_SMALL_HOURS.days,
};
const SEA: Served = {
  "now 20261002/0100": OPEN_SEA.now,
  "hours 20261002/0030": OPEN_SEA.hours,
  "days 20261001/2300": OPEN_SEA.days,
};

const connection = { url: KMA_HOST, actorId: "person-1", botId: "bot-1" };

type Facts = {
  source: string;
  place: string;
  basis?: string;
  issued: { now?: string; hours?: string; days?: string };
  units: string;
  now?: { temp: number; humidity: number; precip: string; wind: number };
  hours?: { at: string; temp: number; sky?: string; precip: string }[];
  days?: {
    date: string;
    day: string;
    when: string;
    min: number | null;
    max: number | null;
    am?: string;
    pm?: string;
    precip?: string;
    snow?: string;
  }[];
  unavailable?: string[];
};

async function weatherOf(
  made: ReturnType<typeof hub>,
  args: Record<string, unknown> = SEOUL,
): Promise<{ facts: Facts; text: string }> {
  const result = await made.transport.callTool(connection, "get_weather", args);
  expect(result.isError).toBe(false);
  expect(result.truncated).toBe(false);
  return { facts: JSON.parse(result.text) as Facts, text: result.text };
}

async function refusalOf(
  run: () => Promise<unknown>,
): Promise<PluginRefusedError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PluginRefusedError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** An observation body in the vendor's shape, for values no real body carried. Hand-written. */
function observation(
  stamp: { baseDate: string; baseTime: string },
  values: Record<string, string>,
): string {
  const rows = Object.entries(values).map(([category, obsrValue]) => ({
    ...stamp,
    category,
    nx: 60,
    ny: 127,
    obsrValue,
  }));
  return JSON.stringify({
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL_SERVICE" },
      body: {
        dataType: "JSON",
        items: { item: rows },
        pageNo: 1,
        numOfRows: 60,
        totalCount: rows.length,
      },
    },
  });
}

/** The names of the arguments a tool's schema declares, in the order it declares them. */
function argumentsOf(
  tool: { inputSchema: Record<string, unknown> } | undefined,
): string[] {
  if (!tool) throw new Error("the tool is not declared");
  return Object.keys(
    (tool.inputSchema as { properties: Record<string, unknown> }).properties,
  );
}

/* ── the tool ────────────────────────────────────────────────────────────────────────────────── */

describe("the weather tool", () => {
  test("is one read-only tool, listed without anybody's credential", async () => {
    const { transport } = hub(MIDNIGHT);
    expect(transport.listNeedsCredential).toBe(false);
    const tools = await transport.listTools(connection);
    expect(tools.map((tool) => tool.name)).toEqual(["get_weather"]);
    expect(tools[0]?.annotations).toEqual({ readOnlyHint: true });
    expect(KMA_WEATHER_KEY).toBe("kma-weather");
    // Every operation it calls is on the one host a catalogue entry would pin.
    for (const address of Object.values(KMA_OPERATIONS)) {
      expect(new URL(address).origin).toBe(KMA_HOST);
    }
  });

  test("says in Korean that weather is asked here and not searched for", () => {
    const [tool] = kmaWeatherTools(false);
    expect(tool?.description).toContain("기상청 날씨");
    expect(tool?.description).toContain(
      "검색하거나 브라우저로 찾지 말고 이것으로 답한다",
    );
    expect(tool?.description).toContain("한국 안만");
    // The source line the law asks for since 2026-09-18, in the wording 기상청's own guide gives:
    // said where only the model reads it, so its words carry the line where no transcript draws it.
    expect(tool?.description).toContain("'출처: 기상청'을 한 번 적는다");
  });

  test("offers a place in words exactly when there is a table to look it up in", () => {
    const [without] = kmaWeatherTools(false);
    const [withNames] = kmaWeatherTools(true);
    const properties = argumentsOf;
    // No table: no `place`, and not a word about names — an argument that can only answer "not
    // found" is one a Bot would reach for first, every time.
    expect(properties(without)).toEqual(["latitude", "longitude"]);
    expect(without?.description).not.toContain("place");
    expect(without?.description).not.toContain("지명");
    expect(without?.description).toContain("위도·경도를 준다");
    expect(properties(withNames)).toEqual(["place", "latitude", "longitude"]);
    expect(withNames?.description).toContain("place에 지명을 적는다");
    // And what the deployment offers follows the table it shipped with, not a flag.
    expect(KMA_WEATHER_TOOLS).toEqual(kmaWeatherTools(KMA_PLACES.size > 0));
  });

  test("a transport handed a table lists the tool that takes names", async () => {
    const { transport } = hub(MIDNIGHT, { places: FIXTURE_PLACES });
    const [tool] = await transport.listTools(connection);
    expect(argumentsOf(tool)).toContain("place");
  });
});

/* ── which issuance ──────────────────────────────────────────────────────────────────────────── */

describe("the issuance to ask for", () => {
  const base = (operation: KmaOperation, at: string, back = 0) => {
    const issuance = issuanceAt(operation, kst(at), back);
    return `${issuance.date}/${issuance.time}`;
  };

  test("five past midnight is still yesterday's, for all three", () => {
    expect(base("now", "2026-10-02T00:05:00")).toBe("20261001/2300");
    expect(base("hours", "2026-10-02T00:05:00")).toBe("20261001/2330");
    expect(base("days", "2026-10-02T00:05:00")).toBe("20261001/2300");
  });

  test("a quarter to one has this hour's observation and forecast, and last night's 단기예보", () => {
    expect(base("now", "2026-10-02T00:45:00")).toBe("20261002/0000");
    expect(base("hours", "2026-10-02T00:45:00")).toBe("20261002/0030");
    expect(base("days", "2026-10-02T00:45:00")).toBe("20261001/2300");
  });

  test("단기예보 turns over at ten past its hour, eight times a day", () => {
    expect(base("days", "2026-10-02T02:09:59")).toBe("20261001/2300");
    expect(base("days", "2026-10-02T02:10:00")).toBe("20261002/0200");
    expect(base("days", "2026-10-02T05:09:00")).toBe("20261002/0200");
    expect(
      [
        "05:10",
        "08:10",
        "11:10",
        "14:10",
        "17:10",
        "20:10",
        "23:10",
        "23:59",
      ].map((time) => base("days", `2026-10-02T${time}:00`).slice(9)),
    ).toEqual(["0500", "0800", "1100", "1400", "1700", "2000", "2300", "2300"]);
  });

  test("the two hourly ones turn over when the hub was measured to publish them", () => {
    // 초단기실황, 2026-10-02: 01:00 first answered between 01:04:40 and 01:05:41, 02:00 between
    // 02:04:26 and 02:05:27.
    expect(base("now", "2026-10-02T01:05:59")).toBe("20261002/0000");
    expect(base("now", "2026-10-02T01:06:00")).toBe("20261002/0100");
    // 초단기예보: the 01 hour between 01:12:45 and 01:13:46, the 02 hour between 02:13:32 and
    // 02:14:33 — half an hour before the quarter to that is usually quoted for it.
    expect(base("hours", "2026-10-02T01:14:59")).toBe("20261002/0030");
    expect(base("hours", "2026-10-02T01:15:00")).toBe("20261002/0130");
  });

  test("the first minutes of a year ask for the last hour of the one before", () => {
    expect(base("now", "2027-01-01T00:05:00")).toBe("20261231/2300");
    expect(base("hours", "2027-01-01T00:05:00")).toBe("20261231/2330");
    expect(base("days", "2027-01-01T00:05:00")).toBe("20261231/2300");
    expect(base("days", "2027-01-01T02:10:00")).toBe("20270101/0200");
    // And a leap day is a day.
    expect(base("days", "2028-03-01T01:00:00")).toBe("20280229/2300");
  });

  test("stepping back is one whole issuance, across midnight too", () => {
    expect(base("now", "2026-10-02T00:45:00", 1)).toBe("20261001/2300");
    expect(base("hours", "2026-10-02T00:45:00", 1)).toBe("20261001/2330");
    expect(base("days", "2026-10-02T02:10:00", 1)).toBe("20261001/2300");
    expect(base("days", "2026-10-02T00:45:00", 1)).toBe("20261001/2000");
  });

  test("the same wherever the process's own clock is set", () => {
    // 15:45 UTC on the 1st is 00:45 on the 2nd in Korea, whatever TZ the server runs in.
    const issuance = issuanceAt("now", new Date("2026-10-01T15:45:00Z"));
    expect(`${issuance.date}/${issuance.time}`).toBe("20261002/0000");
  });

  test("an issuance is the newest until the next one is due to answer", () => {
    expect(
      new Date(
        issuanceAt("now", kst("2026-10-02T00:45:00")).supersededAt,
      ).toISOString(),
    ).toBe(kst("2026-10-02T01:06:00").toISOString());
    expect(
      new Date(
        issuanceAt("hours", kst("2026-10-02T00:45:00")).supersededAt,
      ).toISOString(),
    ).toBe(kst("2026-10-02T01:15:00").toISOString());
    expect(
      new Date(
        issuanceAt("days", kst("2026-10-02T00:45:00")).supersededAt,
      ).toISOString(),
    ).toBe(kst("2026-10-02T02:10:00").toISOString());
  });
});

/* ── what goes out ───────────────────────────────────────────────────────────────────────────── */

describe("what the hub is asked", () => {
  test("three operations for one cell, as JSON, each with a page that holds its whole answer", async () => {
    const made = hub(MIDNIGHT);
    await weatherOf(made);

    expect(
      made.asked.map((call) => `${call.operation} ${call.issuance}`).sort(),
    ).toEqual([
      "days 20261001/2300",
      "hours 20261002/0030",
      "now 20261002/0000",
    ]);
    for (const call of made.asked) {
      const url = new URL(call.url);
      expect(call.cell).toBe("60,127");
      expect(url.searchParams.get("dataType")).toBe("JSON");
      expect(url.searchParams.get("pageNo")).toBe("1");
      expect(url.searchParams.get("authKey")).toBe(KEY);
      expect(call.init?.method).toBe("GET");
      // The key rides on the query string, so a redirect must not be followed.
      expect(call.init?.redirect).toBe("manual");
    }
    const rows = Object.fromEntries(
      made.asked.map((call) => [call.operation, call.rows]),
    );
    // Measured: 1,000 rows cut the 17:00 단기예보 (1,052 rows) short of its last day, and 60 cut
    // 초단기예보 (66 rows) short of its last category.
    expect(rows.days).toBeGreaterThanOrEqual(1_100);
    expect(rows.hours).toBeGreaterThanOrEqual(66);
    expect(rows.now).toBeGreaterThanOrEqual(8);
  });

  test("all three are out at once", async () => {
    let open = 0;
    let most = 0;
    const made = hub(async (asked) => {
      open++;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open--;
      const body = MIDNIGHT[`${asked.operation} ${asked.issuance}`];
      return body ? new Response(body, { status: 200 }) : noData();
    });
    await weatherOf(made);
    expect(most).toBe(3);
  });

  test("never a cell the grid does not have", async () => {
    // The hub answers cell (150, 254) with zeros and resultCode 00. So it is never asked.
    const made = hub(MIDNIGHT);
    const tokyo = await refusalOf(() =>
      made.transport.callTool(connection, "get_weather", {
        latitude: 35.6762,
        longitude: 139.6503,
      }),
    );
    expect(tokyo.code).toBe("laf:weather_place_outside");
    expect(made.asked).toEqual([]);
  });
});

/* ── the answer ──────────────────────────────────────────────────────────────────────────────── */

describe("what a Bot is handed", () => {
  test("서울 at a quarter to one: now, six hours and four days, in about a kilobyte", async () => {
    const { facts, text } = await weatherOf(hub(MIDNIGHT));

    expect(facts).toEqual({
      source: "기상청",
      place: "위도 37.57, 경도 126.98",
      issued: { now: "10-02 00:00", hours: "10-02 00:00", days: "10-01 23:00" },
      units: "기온 ℃, 습도·강수확률 %, 바람 m/s",
      now: { temp: 15.2, humidity: 37, precip: "없음", wind: 3.7 },
      hours: [
        { at: "1시", temp: 15, sky: "맑음", precip: "없음" },
        { at: "2시", temp: 14, sky: "맑음", precip: "없음" },
        { at: "3시", temp: 13, sky: "맑음", precip: "없음" },
        { at: "4시", temp: 12, sky: "맑음", precip: "없음" },
        { at: "5시", temp: 12, sky: "맑음", precip: "없음" },
        { at: "6시", temp: 12, sky: "맑음", precip: "없음" },
      ],
      days: [
        {
          date: "2026-10-02",
          day: "금",
          when: "오늘",
          min: 12,
          max: 21,
          am: "맑음 0%",
          pm: "맑음 0%",
          precip: "없음",
        },
        {
          date: "2026-10-03",
          day: "토",
          when: "내일",
          min: 11,
          max: 22,
          am: "맑음 30%",
          pm: "흐림 30%",
          precip: "없음",
        },
        {
          date: "2026-10-04",
          day: "일",
          when: "모레",
          min: 14,
          max: 23,
          am: "맑음 30%",
          pm: "흐림 30%",
          precip: "없음",
        },
        {
          // The last day is three-hourly and its rain is a bare number: "0.4" and "2", at 00 and 03.
          date: "2026-10-05",
          day: "월",
          when: "글피",
          min: 15,
          max: 21,
          am: "흐림 70%",
          pm: "맑음 30%",
          precip: "비 0~6시(0.4mm·2mm)",
        },
      ],
    });
    // It rides in the model's context on every later turn. The three raw answers were 140 KB.
    expect(Buffer.byteLength(text)).toBeLessThan(1_500);
  });

  test("no raw row and no code reaches the model", async () => {
    const { text } = await weatherOf(hub(MIDNIGHT));
    for (const vendorWord of [
      "fcstValue",
      "obsrValue",
      "category",
      "baseDate",
      "T1H",
      "PTY",
      "SKY",
      "POP",
      "TMN",
      "강수없음",
      "적설없음",
    ]) {
      expect(text).not.toContain(vendorWord);
    }
  });

  test("서울 at ten to three: the 02:00 issuance, and 기상청's own words for a trace of rain", async () => {
    const made = hub(SMALL_HOURS, { at: kst("2026-10-02T02:50:00") });
    const { facts } = await weatherOf(made);

    expect(
      made.asked.map((call) => `${call.operation} ${call.issuance}`).sort(),
    ).toEqual([
      "days 20261002/0200",
      "hours 20261002/0230",
      "now 20261002/0200",
    ]);
    expect(facts.issued).toEqual({
      now: "10-02 02:00",
      hours: "10-02 02:00",
      days: "10-02 02:00",
    });
    // The 2nd is still today; the hours before three are simply not in this issuance.
    expect(facts.days?.[0]).toEqual({
      date: "2026-10-02",
      day: "금",
      when: "오늘",
      min: 12,
      max: 21,
      am: "맑음 0%",
      pm: "맑음 0%",
      precip: "없음",
    });
    // "1mm 미만" is 기상청's wording and already plain Korean; the "2" beside it had no unit.
    expect(facts.days?.[3]?.precip).toBe("비 0~6시(1mm 미만·2mm)");
  });

  test("an afternoon issuance has lost the morning, so today's 최저 comes from the 02:00 one", async () => {
    const made = hub(AFTERNOON, { at: kst("2026-10-01T14:50:00") });
    const { facts } = await weatherOf(made);

    // The fourth request: the same day's 02:00 issuance, and only its first 170 rows.
    const morning = made.asked.find(
      (call) => call.issuance === "20261001/0200",
    );
    expect(morning?.operation).toBe("days");
    expect(morning?.rows).toBe(170);
    expect(made.asked).toHaveLength(4);

    expect(facts.days?.[0]).toEqual({
      date: "2026-10-01",
      day: "목",
      when: "오늘",
      // TMN 13.0 is in the 02:00 body at 06:00; the 14:00 body starts at 15:00 and has no TMN for the 1st.
      min: 13,
      max: 22,
      // No `am`: it is ten to three, and the morning is not said as "없음" — it is not said.
      pm: "맑음 0%",
      precip: "없음",
    });
    expect(facts.days?.map((day) => day.when)).toEqual([
      "오늘",
      "내일",
      "모레",
      "글피",
    ]);
    expect(facts.hours?.map((hour) => hour.at)).toEqual([
      "15시",
      "16시",
      "17시",
      "18시",
      "19시",
      "20시",
    ]);
    expect(facts.now).toEqual({
      temp: 21.4,
      humidity: 24,
      precip: "없음",
      wind: 3.6,
    });
  });

  test("without the 02:00 issuance, today's 최저 and 최고 are unknown — not the extremes of the hours left", async () => {
    // The 14:00 body carries neither for the 1st: its TMN and TMX rows begin on the 2nd.
    const { "days 20261001/0200": _morning, ...rest } = AFTERNOON;
    const { facts } = await weatherOf(
      hub(rest, { at: kst("2026-10-01T14:50:00") }),
    );
    expect(facts.days?.[0]).toEqual({
      date: "2026-10-01",
      day: "목",
      when: "오늘",
      // What is left is an afternoon and an evening. Their warmest and coolest hours, said as the
      // day's 최고 and 최저, would be a lie with a label on it.
      min: null,
      max: null,
      pm: "맑음 0%",
      precip: "없음",
    });
    // And it is not a failure of the forecast: nothing is reported missing.
    expect(facts.unavailable).toBeUndefined();
  });

  test("half past five in the evening: the 17:00 issuance reaches a fifth day, three-hourly", async () => {
    const made = hub(EVENING, { at: kst("2026-10-01T17:30:00") });
    const { facts, text } = await weatherOf(made);

    expect(facts.days).toEqual([
      // Neither 최저 nor 최고 is in a 17:00 body for its own day; both are the 02:00 issuance's.
      {
        date: "2026-10-01",
        day: "목",
        when: "오늘",
        min: 13,
        max: 22,
        pm: "맑음 0%",
        precip: "없음",
      },
      {
        date: "2026-10-02",
        day: "금",
        when: "내일",
        min: 12,
        max: 21,
        am: "맑음 0%",
        pm: "맑음 0%",
        precip: "없음",
      },
      {
        date: "2026-10-03",
        day: "토",
        when: "모레",
        min: 11,
        max: 22,
        am: "맑음 30%",
        pm: "흐림 30%",
        precip: "없음",
      },
      {
        date: "2026-10-04",
        day: "일",
        when: "글피",
        min: 14,
        max: 23,
        am: "맑음 30%",
        pm: "흐림 30%",
        precip: "없음",
      },
      {
        // The day a 1,000-row page cut off at noon: its TMX is row 1,016 of the body's 1,052.
        date: "2026-10-05",
        day: "월",
        when: "그글피",
        min: 15,
        max: 21,
        am: "흐림 70%",
        pm: "맑음 30%",
        precip: "비 0~6시(0.4mm·2mm)",
      },
    ]);
    expect(facts.hours?.map((hour) => hour.at)).toEqual([
      "18시",
      "19시",
      "20시",
      "21시",
      "22시",
      "23시",
    ]);
    // Five days is the most there ever is, and it still fits.
    expect(Buffer.byteLength(text)).toBeLessThan(1_500);
  });

  test("half past five: the 05:00 issuance starts at six with no 최저 there, and its own 최고 wins", async () => {
    const made = hub(DAWN, { at: kst("2026-10-01T05:30:00") });
    const { facts } = await weatherOf(made);

    expect(
      made.asked.map((call) => `${call.operation} ${call.issuance}`).sort(),
    ).toEqual([
      "days 20261001/0200",
      "days 20261001/0500",
      "hours 20261001/0530",
      "now 20261001/0500",
    ]);
    expect(facts.days?.[0]).toEqual({
      date: "2026-10-01",
      day: "목",
      when: "오늘",
      // From the 02:00 body: the 05:00 one has no TMN row at 06:00, the hour it starts at.
      min: 13,
      // The 05:00 body's own. The 02:00 one said 22; 기상청 had revised it, and the newer word stands.
      max: 20,
      am: "흐림 30%",
      pm: "맑음 0%",
      precip: "없음",
    });
    expect(facts.now).toEqual({
      temp: 15.5,
      humidity: 42,
      precip: "없음",
      wind: 1.7,
    });
    expect(facts.hours?.map((hour) => `${hour.at} ${hour.sky}`)).toEqual([
      "6시 구름많음",
      "7시 맑음",
      "8시 구름많음",
      "9시 맑음",
      "10시 맑음",
      "11시 맑음",
    ]);
  });

  test("the 02:00 issuance carries the whole day, and no fourth request is made", async () => {
    const made = hub(SMALL_HOURS, { at: kst("2026-10-02T02:50:00") });
    await weatherOf(made);
    expect(made.asked).toHaveLength(3);
  });

  test("nor is one made before ten past two, when the newest is last night's 23:00", async () => {
    const made = hub(MIDNIGHT);
    await weatherOf(made);
    expect(made.asked.filter((call) => call.rows === 170)).toEqual([]);
  });

  test("open sea: nothing is observed there, and -999 is never said as a temperature", async () => {
    // Cell (1, 1). The observation is REH -998, RN1 -998.9, T1H -999; the forecasts are real.
    const made = hub(SEA, { at: kst("2026-10-02T01:10:00") });
    const { facts, text } = await weatherOf(made, {
      latitude: 31.794423,
      longitude: 123.761264,
    });

    expect(made.asked[0]?.cell).toBe("1,1");
    expect(facts.now).toBeUndefined();
    expect(facts.issued.now).toBeUndefined();
    expect(facts.unavailable).toEqual(["현재 관측"]);
    expect(text).not.toContain("-99");
    expect(facts.hours?.[0]).toEqual({
      at: "1시",
      temp: 23,
      sky: "구름많음",
      precip: "없음",
    });
    expect(facts.days).toHaveLength(4);
  });

  test("six hours from late evening cross into tomorrow, and say so", async () => {
    // Hand-written: the real bodies were taken after midnight.
    const made = hub(
      {
        "hours 20261002/2130": veryShortForecast(
          { baseDate: "20261002", baseTime: "2100", nx: 60, ny: 127 },
          { numOfRows: 100, totalCount: 24 },
          `
20261002 2200 | PTY=0; RN1=강수없음; SKY=1; T1H=15
20261002 2300 | PTY=0; RN1=강수없음; SKY=3; T1H=14
20261003 0000 | PTY=1; RN1=1mm 미만; SKY=4; T1H=14
20261003 0100 | PTY=1; RN1=3.0mm; SKY=4; T1H=13
20261003 0200 | PTY=5; RN1=강수없음; SKY=4; T1H=13
20261003 0300 | PTY=0; RN1=강수없음; SKY=4; T1H=12
`,
        ),
      },
      { at: kst("2026-10-02T22:20:00") },
    );
    const { facts } = await weatherOf(made);
    expect(facts.hours).toEqual([
      { at: "22시", temp: 15, sky: "맑음", precip: "없음" },
      { at: "23시", temp: 14, sky: "구름많음", precip: "없음" },
      { at: "내일 0시", temp: 14, sky: "흐림", precip: "비 1mm 미만" },
      { at: "내일 1시", temp: 13, sky: "흐림", precip: "비 3.0mm" },
      { at: "내일 2시", temp: 13, sky: "흐림", precip: "빗방울" },
      { at: "내일 3시", temp: 12, sky: "흐림", precip: "없음" },
    ]);
    expect(facts.unavailable).toEqual(["현재 관측", "날짜별 예보"]);
  });

  test("an hour already gone is not one of the next six", async () => {
    // At 00:10 the newest 초단기예보 is 23:30's, whose first forecast time is 00:00 — this hour.
    const made = hub(
      {
        "hours 20261001/2330": veryShortForecast(
          { baseDate: "20261001", baseTime: "2300", nx: 60, ny: 127 },
          { numOfRows: 100, totalCount: 8 },
          `
20261001 2300 | PTY=0; RN1=강수없음; SKY=1; T1H=16
20261002 0000 | PTY=0; RN1=강수없음; SKY=1; T1H=15
`,
        ),
      },
      { at: kst("2026-10-02T00:10:00") },
    );
    const { facts } = await weatherOf(made);
    expect(facts.hours).toEqual([
      { at: "0시", temp: 15, sky: "맑음", precip: "없음" },
    ]);
  });

  test("every kind of precipitation has a Korean word, and an amount keeps 기상청's own", async () => {
    // Hand-written rows: none of this fell on the two days the real bodies were taken.
    const kinds = async (code: string, amount: string) => {
      const made = hub({
        "now 20261002/0000": observation(
          { baseDate: "20261002", baseTime: "0000" },
          { PTY: code, REH: "80", RN1: amount, T1H: "1.5", WSD: "2.0" },
        ),
      });
      return (await weatherOf(made)).facts.now?.precip;
    };
    expect(await kinds("0", "0")).toBe("없음");
    expect(await kinds("1", "1.5")).toBe("비 1.5mm");
    expect(await kinds("2", "0.5")).toBe("비/눈 0.5mm");
    expect(await kinds("3", "0")).toBe("눈");
    expect(await kinds("5", "0")).toBe("빗방울");
    expect(await kinds("6", "0")).toBe("빗방울눈날림");
    expect(await kinds("7", "0")).toBe("눈날림");
    // Rain in the gauge with no kind given is still said, as what it is.
    expect(await kinds("0", "0.2")).toBe("강수 0.2mm");
    // A kind this file has no word for is precipitation, not nothing.
    expect(await kinds("9", "0")).toBe("강수");
  });

  test("a snowy, showery day: the kinds, the hours, the amounts as written, and the snow apart", async () => {
    // Hand-written, in 단기예보's shape, with the amount wordings the portal's guide lists.
    const made = hub(
      {
        "days 20261218/2300": shortForecast(
          { baseDate: "20261218", baseTime: "2300", nx: 60, ny: 127 },
          { numOfRows: 1100, totalCount: 60 },
          `
20261219 0600 | TMP=-3; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음; TMN=-3.0
20261219 0900 | TMP=-1; SKY=4; PTY=3; POP=60; PCP=1.0mm; SNO=1.0cm
20261219 1000 | TMP=0; SKY=4; PTY=3; POP=80; PCP=30.0~50.0mm; SNO=5.0cm 이상
20261219 1100 | TMP=1; SKY=4; PTY=2; POP=80; PCP=50.0mm 이상; SNO=0.5cm 미만
20261219 1200 | TMP=2; SKY=3; PTY=4; POP=60; PCP=1mm 미만; SNO=적설없음
20261219 1300 | TMP=3; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261219 1500 | TMP=4; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMX=4.0
`,
        ),
      },
      { at: kst("2026-12-19T00:30:00") },
    );
    const { facts } = await weatherOf(made);
    expect(facts.days).toEqual([
      {
        date: "2026-12-19",
        day: "토",
        when: "오늘",
        min: -3,
        max: 4,
        // 흐림 four times to 구름많음 none before noon; after it, 구름많음 twice to 맑음 once.
        am: "흐림 80%",
        pm: "구름많음 60%",
        // Three kinds at most, in the order they come; the hours from the first to the end of the last.
        precip: "눈·비/눈·소나기 9~13시(1.0mm·30.0~50.0mm·50.0mm 이상)",
        snow: "1.0cm·5.0cm 이상·0.5cm 미만",
      },
    ]);
  });

  test("on a tie the sky is the cloudier one", async () => {
    const made = hub(
      {
        "days 20261001/2300": shortForecast(
          { baseDate: "20261001", baseTime: "2300", nx: 60, ny: 127 },
          { numOfRows: 1100, totalCount: 30 },
          `
20261002 0600 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMN=12.0
20261002 0900 | TMP=15; SKY=4; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261002 1500 | TMP=21; SKY=3; PTY=0; POP=10; PCP=강수없음; SNO=적설없음; TMX=21.0
`,
        ),
      },
      { at: kst("2026-10-02T00:45:00") },
    );
    const { facts } = await weatherOf(made);
    expect(facts.days?.[0]?.am).toBe("흐림 20%");
    expect(facts.days?.[0]?.pm).toBe("구름많음 10%");
  });

  test("late at night, with nothing of today left in the issuance, today is its 최저 and 최고 and no more", async () => {
    // 23:30: the 23:00 issuance starts at midnight. Today's row must not say "precip: 없음" about
    // hours it has no rows for.
    const made = hub(
      {
        "days 20261002/2300": shortForecast(
          { baseDate: "20261002", baseTime: "2300", nx: 60, ny: 127 },
          { numOfRows: 1100, totalCount: 30 },
          `
20261003 0600 | TMP=11; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMN=11.0
20261003 1500 | TMP=22; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음; TMX=22.0
20261004 0000 | TMP=16; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
`,
        ),
        "days 20261002/0200": shortForecast(
          { baseDate: "20261002", baseTime: "0200", nx: 60, ny: 127 },
          { numOfRows: 170, totalCount: 944 },
          `
20261002 0600 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMN=12.0
20261002 1500 | TMP=21; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMX=21.0
`,
        ),
      },
      { at: kst("2026-10-02T23:30:00") },
    );
    const { facts } = await weatherOf(made);
    expect(facts.days).toEqual([
      { date: "2026-10-02", day: "금", when: "오늘", min: 12, max: 21 },
      {
        date: "2026-10-03",
        day: "토",
        when: "내일",
        min: 11,
        max: 22,
        am: "맑음 0%",
        pm: "흐림 30%",
        precip: "없음",
      },
      // The one row at midnight of the 4th is where the issuance ends, not a day.
    ]);
  });
});

/* ── an issuance that is not out yet ─────────────────────────────────────────────────────────── */

describe("an issuance the hub has not published", () => {
  test("is stepped back from, once, to the one before", async () => {
    // 01:06: the 01:00 observation is due, and on this day it is late.
    const made = hub(MIDNIGHT, { at: kst("2026-10-02T01:06:00") });
    const { facts } = await weatherOf(made);

    expect(
      made.asked
        .filter((call) => call.operation === "now")
        .map((call) => call.issuance),
    ).toEqual(["20261002/0100", "20261002/0000"]);
    expect(facts.issued.now).toBe("10-02 00:00");
    expect(facts.now?.temp).toBe(15.2);
    expect(facts.unavailable).toBeUndefined();
  });

  test("and when the one before is not there either, that part is named as missing", async () => {
    const { "now 20261002/0000": _now, ...rest } = MIDNIGHT;
    const made = hub(rest);
    const { facts } = await weatherOf(made);
    expect(made.asked.filter((call) => call.operation === "now")).toHaveLength(
      2,
    );
    expect(facts.now).toBeUndefined();
    expect(facts.unavailable).toEqual(["현재 관측"]);
    // The forecast is still the forecast.
    expect(facts.days).toHaveLength(4);
  });

  test("nothing at all is a refusal, not an empty answer", async () => {
    const made = hub({});
    const refused = await refusalOf(() =>
      made.transport.callTool(connection, "get_weather", SEOUL),
    );
    expect(refused.code).toBe("laf:weather_no_data");
    // Two issuances of each of the three were tried, and no more.
    expect(made.asked).toHaveLength(6);
  });

  test("a good header over no rows is the same thing", async () => {
    const empty = JSON.stringify({
      response: {
        header: { resultCode: "00", resultMsg: "NORMAL_SERVICE" },
        body: { dataType: "JSON", items: "", pageNo: 1, totalCount: 0 },
      },
    });
    const made = hub(() => new Response(empty, { status: 200 }));
    expect(
      (
        await refusalOf(() =>
          made.transport.callTool(connection, "get_weather", SEOUL),
        )
      ).code,
    ).toBe("laf:weather_no_data");
  });
});

/* ── what is kept ────────────────────────────────────────────────────────────────────────────── */

describe("what is kept between calls", () => {
  test("a second question about the same cell asks the hub nothing", async () => {
    const made = hub(MIDNIGHT);
    const first = await weatherOf(made);
    expect(made.asked).toHaveLength(3);
    const second = await weatherOf(made);
    expect(made.asked).toHaveLength(3);
    expect(second.text).toBe(first.text);
  });

  test("another cell is another three requests", async () => {
    const made = hub(MIDNIGHT);
    await weatherOf(made);
    await made.transport
      .callTool(connection, "get_weather", BUSAN)
      .catch(() => null);
    expect(made.asked.slice(3).map((call) => call.cell)).toEqual([
      "98,76",
      "98,76",
      "98,76",
    ]);
  });

  test("two questions arriving together are one set of requests", async () => {
    const made = hub(MIDNIGHT);
    await Promise.all([weatherOf(made), weatherOf(made)]);
    expect(made.asked).toHaveLength(3);
  });

  test("each part is asked for again when its next issuance is due, and not before", async () => {
    const made = hub(MIDNIGHT);
    await weatherOf(made);
    expect(made.asked).toHaveLength(3);

    // 01:05: nothing is due. 01:06: the 01:00 observation is — and only it.
    made.clock.at = kst("2026-10-02T01:05:00");
    await weatherOf(made);
    expect(made.asked).toHaveLength(3);
    made.clock.at = kst("2026-10-02T01:06:00");
    await weatherOf(made);
    expect(
      made.asked.slice(3).map((call) => `${call.operation} ${call.issuance}`),
    ).toEqual([
      // Not out (this fake hub has only midnight's), so the one before is fetched again …
      "now 20261002/0100",
      "now 20261002/0000",
    ]);

    // … and kept for a couple of minutes, while the one that is not out is asked for every time:
    // "not yet" is never kept.
    made.clock.at = kst("2026-10-02T01:07:00");
    await weatherOf(made);
    expect(
      made.asked.slice(5).map((call) => `${call.operation} ${call.issuance}`),
    ).toEqual(["now 20261002/0100"]);

    // 02:10: the next 단기예보.
    made.clock.at = kst("2026-10-02T02:10:00");
    await made.transport
      .callTool(connection, "get_weather", SEOUL)
      .catch(() => null);
    expect(
      made.asked.slice(6).some((call) => call.issuance === "20261002/0200"),
    ).toBe(true);
  });

  test("a failure is not kept: the next question asks again", async () => {
    let failing = true;
    const made = hub(async (asked) => {
      if (failing) throw new Error("connection reset");
      const body = MIDNIGHT[`${asked.operation} ${asked.issuance}`];
      return body ? new Response(body, { status: 200 }) : noData();
    });
    expect(
      (
        await refusalOf(() =>
          made.transport.callTool(connection, "get_weather", SEOUL),
        )
      ).code,
    ).toBe("laf:weather_unreachable");
    expect(made.asked).toHaveLength(3);

    failing = false;
    const { facts } = await weatherOf(made);
    expect(made.asked).toHaveLength(6);
    expect(facts.now?.temp).toBe(15.2);
  });

  test("the morning issuance is asked for once a day", async () => {
    const made = hub(AFTERNOON, { at: kst("2026-10-01T14:50:00") });
    const mornings = () =>
      made.asked
        .filter((call) => call.rows === 170)
        .map((call) => call.issuance);

    await weatherOf(made);
    made.clock.at = kst("2026-10-01T16:30:00");
    await weatherOf(made);
    made.clock.at = kst("2026-10-01T23:59:00");
    await made.transport
      .callTool(connection, "get_weather", SEOUL)
      .catch(() => null);
    expect(mornings()).toEqual(["20261001/0200"]);

    // The next afternoon it is the next day's.
    made.clock.at = kst("2026-10-02T14:50:00");
    await made.transport
      .callTool(connection, "get_weather", SEOUL)
      .catch(() => null);
    expect(mornings()).toEqual(["20261001/0200", "20261002/0200"]);
  });
});

/* ── the ways it says no ─────────────────────────────────────────────────────────────────────── */

describe("the hub saying no", () => {
  const refusing = (body: string, status: number) =>
    hub(
      () =>
        new Response(body, {
          status,
          headers: { "content-type": "application/json" },
        }),
    );

  test("an operation nobody applied for is its own fact, with the hub's words kept", async () => {
    const made = refusing(NOT_APPLIED_BODY, 403);
    const refused = await refusalOf(() =>
      made.transport.callTool(connection, "get_weather", SEOUL),
    );
    expect(refused.code).toBe("laf:weather_not_open");
    expect(refused.message).toContain("HTTP 403");
    expect(refused.message).toContain("활용신청이 필요한 API 입니다");
    // A 403 is not "not issued yet": nothing is stepped back from.
    expect(made.asked).toHaveLength(3);
  });

  test("a path the hub does not serve, and a key it does not know, are refusals", async () => {
    const notAllowed = await refusalOf(() =>
      refusing(NOT_ALLOWED_BODY, 403).transport.callTool(
        connection,
        "get_weather",
        SEOUL,
      ),
    );
    expect(notAllowed.code).toBe("laf:weather_refused");
    expect(notAllowed.message).toContain("허용되지 않은 API 입니다.");

    const badKey = await refusalOf(() =>
      refusing(BAD_KEY_BODY, 401).transport.callTool(
        connection,
        "get_weather",
        SEOUL,
      ),
    );
    expect(badKey.code).toBe("laf:weather_refused");
    expect(badKey.message).toContain("HTTP 401 유효한 인증키가 아닙니다.");
  });

  test("a result code that is neither 00 nor 03 is a refusal with its message", async () => {
    // What an observation more than a day old answers — and a date the hub cannot read.
    const refused = await refusalOf(() =>
      refusing(TOO_OLD_BODY, 200).transport.callTool(
        connection,
        "get_weather",
        SEOUL,
      ),
    );
    expect(refused.code).toBe("laf:weather_refused");
    expect(refused.message).toContain("10 최근 1일 간의 자료만 제공합니다.");
  });

  test("a failure with no body, a timeout, a page of HTML and an answer too big to read are four facts", async () => {
    expect(
      (
        await refusalOf(() =>
          refusing("", 502).transport.callTool(
            connection,
            "get_weather",
            SEOUL,
          ),
        )
      ).message,
    ).toBe("laf:weather_refused: HTTP 502");

    const timingOut = hub(() => {
      throw Object.assign(new Error("The operation timed out."), {
        name: "TimeoutError",
      });
    });
    expect(
      (
        await refusalOf(() =>
          timingOut.transport.callTool(connection, "get_weather", SEOUL),
        )
      ).code,
    ).toBe("laf:weather_unreachable");

    expect(
      (
        await refusalOf(() =>
          refusing(
            "<html><body>시스템 점검 중입니다</body></html>",
            200,
          ).transport.callTool(connection, "get_weather", SEOUL),
        )
      ).code,
    ).toBe("laf:weather_unreadable");

    expect(
      (
        await refusalOf(() =>
          refusing(
            "x".repeat(RAW_RESPONSE_CAP_CHARS + 1),
            200,
          ).transport.callTool(connection, "get_weather", SEOUL),
        )
      ).code,
    ).toBe("laf:weather_too_large");
  });

  test("one part refused is that part missing; all three refused is the refusal that says most", async () => {
    const partly = hub((asked) =>
      asked.operation === "hours"
        ? new Response(NOT_APPLIED_BODY, { status: 403 })
        : new Response(MIDNIGHT[`${asked.operation} ${asked.issuance}`], {
            status: 200,
          }),
    );
    const { facts } = await weatherOf(partly);
    expect(facts.unavailable).toEqual(["시간별 예보"]);
    expect(facts.hours).toBeUndefined();
    expect(facts.now?.temp).toBe(15.2);
    expect(facts.days).toHaveLength(4);

    const wholly = hub((asked) => {
      if (asked.operation === "now") throw new Error("socket hang up");
      if (asked.operation === "hours") {
        return new Response("<html>", { status: 200 });
      }
      return new Response(NOT_APPLIED_BODY, { status: 403 });
    });
    // Unreachable, unreadable and not-applied at once: the one an operator can fix is the one said.
    expect(
      (
        await refusalOf(() =>
          wholly.transport.callTool(connection, "get_weather", SEOUL),
        )
      ).code,
    ).toBe("laf:weather_not_open");
  });

  test("a long sentence from the hub is kept to a sentence, with the cut shown", async () => {
    // The detail is an audit row. A gateway's stack trace is not something to file in one.
    const made = refusing(
      JSON.stringify({
        result: { status: 500, message: "점검 ".repeat(2_000) },
      }),
      500,
    );
    const refused = await refusalOf(() =>
      made.transport.callTool(connection, "get_weather", SEOUL),
    );
    expect(refused.code).toBe("laf:weather_refused");
    expect(
      refused.message.startsWith("laf:weather_refused: HTTP 500 점검"),
    ).toBe(true);
    expect(refused.message.length).toBeLessThan(450);
    expect(refused.message.endsWith("…")).toBe(true);
  });

  test("a tool that does not exist is refused by name, before anything is asked", async () => {
    const made = hub(MIDNIGHT);
    expect(
      (
        await refusalOf(() =>
          made.transport.callTool(connection, "get_forecast", SEOUL),
        )
      ).code,
    ).toBe("laf:weather_unknown_tool");
    expect(made.asked).toEqual([]);
  });
});

/* ── where ───────────────────────────────────────────────────────────────────────────────────── */

/*
 * A table in the shape of 기상청's, small enough to read. The cells are the ones this repository's
 * projection gives for each office's coordinates; they are here to be looked up, not to be 기상청's
 * word (`kma-places.test.ts` holds the shipped table to that).
 */
const FIXTURE_PLACES = createKmaPlaces(
  parseKmaPlaces(`
서울특별시|||60|127
서울특별시|종로구||60|127
서울특별시|종로구|청운효자동|60|127
서울특별시|중구||60|127
부산광역시|||98|76
부산광역시|중구||97|74
부산광역시|해운대구||99|75
강원특별자치도|||73|134
강원특별자치도|춘천시||73|134
강원특별자치도|춘천시|효자1동|73|134
강원특별자치도|고성군||85|145
경상남도|고성군||85|71
`),
);

describe("where the question is about", () => {
  test("coordinates in the call go straight to the cell, numbers written as text included", async () => {
    const made = hub(MIDNIGHT);
    const { facts } = await weatherOf(made, {
      latitude: "37.5665",
      longitude: " 126.978 ",
    });
    expect(made.asked[0]?.cell).toBe("60,127");
    expect(facts.place).toBe("위도 37.57, 경도 126.98");
    expect(facts.basis).toBeUndefined();
  });

  test("one coordinate without the other, or one that is not a number, is refused and nothing is asked", async () => {
    const made = hub(MIDNIGHT);
    for (const args of [
      { latitude: 37.5 },
      { longitude: 127 },
      { latitude: "서울", longitude: 127 },
      { latitude: 37.5, longitude: Number.NaN },
    ]) {
      expect(
        (
          await refusalOf(() =>
            made.transport.callTool(connection, "get_weather", args),
          )
        ).code,
      ).toBe("laf:weather_coordinates_invalid");
    }
    expect(made.asked).toEqual([]);
  });

  test("with nothing named, it is the person's saved coordinates, and the answer says so", async () => {
    const whose: string[] = [];
    const made = hub(MIDNIGHT, {
      coordinatesOf: async (actorId) => {
        whose.push(actorId);
        return { latitude: 37.57, longitude: 126.98 };
      },
    });
    const { facts } = await weatherOf(made, {});
    expect(whose).toEqual(["person-1"]);
    expect(made.asked[0]?.cell).toBe("60,127");
    expect(facts.basis).toBe("저장된 위치");
    expect(facts.place).toBe("위도 37.57, 경도 126.98");
  });

  test("blank arguments are nothing named — never latitude zero", async () => {
    // `Number("")` is 0, and 0°N 0°E is a place: off the grid, in the Gulf of Guinea.
    const made = hub(MIDNIGHT, {
      coordinatesOf: async () => ({ latitude: 37.57, longitude: 126.98 }),
    });
    const { facts } = await weatherOf(made, {
      latitude: "",
      longitude: "  ",
      place: " ",
    });
    expect(made.asked[0]?.cell).toBe("60,127");
    expect(facts.basis).toBe("저장된 위치");
  });

  test("nobody's place known is a refusal that asks for one, and the hub is not asked", async () => {
    const nothingSaved = hub(MIDNIGHT, {
      coordinatesOf: async () => null,
      placeOf: async () => null,
    });
    expect(
      (
        await refusalOf(() =>
          nothingSaved.transport.callTool(connection, "get_weather", {}),
        )
      ).code,
    ).toBe("laf:weather_place_unknown");
    expect(nothingSaved.asked).toEqual([]);

    // Nothing wired at all, and a run that belongs to nobody, are the same fact.
    expect(
      (
        await refusalOf(() =>
          hub(MIDNIGHT).transport.callTool(connection, "get_weather", {}),
        )
      ).code,
    ).toBe("laf:weather_place_unknown");
    const asksNobody = hub(MIDNIGHT, {
      coordinatesOf: async () => {
        throw new Error("must not be asked without an actor");
      },
    });
    expect(
      (
        await refusalOf(() =>
          asksNobody.transport.callTool({ url: KMA_HOST }, "get_weather", {}),
        )
      ).code,
    ).toBe("laf:weather_place_unknown");
  });

  test("saved coordinates abroad are outside, not unknown", async () => {
    const made = hub(MIDNIGHT, {
      coordinatesOf: async () => ({ latitude: 35.68, longitude: 139.65 }),
    });
    expect(
      (
        await refusalOf(() =>
          made.transport.callTool(connection, "get_weather", {}),
        )
      ).code,
    ).toBe("laf:weather_place_outside");
  });

  test("without a table a name finds nothing — and is never answered with the saved place instead", async () => {
    const made = hub(MIDNIGHT, {
      coordinatesOf: async () => ({ latitude: 37.57, longitude: 126.98 }),
    });
    expect(
      (
        await refusalOf(() =>
          made.transport.callTool(connection, "get_weather", { place: "부산" }),
        )
      ).code,
    ).toBe("laf:weather_place_not_found");
    expect(made.asked).toEqual([]);
  });

  test("with a table, a name is the row 기상청 files it under, and the answer names that row", async () => {
    const made = hub(MIDNIGHT, { places: FIXTURE_PLACES });
    const { facts } = await weatherOf(made, { place: "서울 종로" });
    expect(made.asked[0]?.cell).toBe("60,127");
    expect(facts.place).toBe("서울특별시 종로구");
    expect(facts.basis).toBeUndefined();

    await made.transport
      .callTool(connection, "get_weather", { place: "해운대" })
      .catch(() => null);
    expect(made.asked.at(-1)?.cell).toBe("99,75");
  });

  test("a name two places share is refused rather than guessed, and one nowhere is not found", async () => {
    const made = hub(MIDNIGHT, { places: FIXTURE_PLACES });
    const shared = await refusalOf(() =>
      made.transport.callTool(connection, "get_weather", { place: "고성" }),
    );
    expect(shared.code).toBe("laf:weather_place_ambiguous");
    // How many, and never which: a place name in an audit row is somebody's whereabouts.
    expect(shared.message).toBe("laf:weather_place_ambiguous: 2 candidates");
    expect(
      (
        await refusalOf(() =>
          made.transport.callTool(connection, "get_weather", {
            place: "아틀란티스",
          }),
        )
      ).code,
    ).toBe("laf:weather_place_not_found");
    expect(made.asked).toEqual([]);
  });

  test("coordinates are answered with the name of what is there", async () => {
    const made = hub(MIDNIGHT, { places: FIXTURE_PLACES });
    const { facts } = await weatherOf(made, SEOUL);
    // The cell holds 종로구 and 중구 in this table; the numbers given are kept beside the names.
    expect(facts.place).toBe(
      "서울특별시 종로구·중구 (위도 37.57, 경도 126.98)",
    );
  });

  test("saved words are read through the table when there are no saved coordinates", async () => {
    const made = hub(MIDNIGHT, {
      places: FIXTURE_PLACES,
      coordinatesOf: async () => null,
      placeOf: async () => "강원 춘천시",
    });
    const { facts } = await weatherOf(made, {});
    expect(made.asked[0]?.cell).toBe("73,134");
    expect(facts.place).toBe("강원특별자치도 춘천시");
    expect(facts.basis).toBe("저장된 위치");

    const unreadable = hub(MIDNIGHT, {
      places: FIXTURE_PLACES,
      placeOf: async () => "홍대 근처",
    });
    const refused = await refusalOf(() =>
      unreadable.transport.callTool(connection, "get_weather", {}),
    );
    expect(refused.code).toBe("laf:weather_place_not_found");
    // The words somebody saved are not in the refusal.
    expect(refused.message).not.toContain("홍대");
  });
});

/*
 * The same, through the table this repository ships: 기상청's 3,837 rows of 2026-07-01. What a Bot
 * is told here is what it will say to a person, so these are held to the real rows.
 */
describe("where, by the table that ships", () => {
  const shipped = (served: Served = MIDNIGHT, more = {}) =>
    hub(served, { places: KMA_PLACES, ...more });

  test("the tool a deployment lists takes a place in words", async () => {
    const [tool] = await shipped().transport.listTools(connection);
    expect(argumentsOf(tool)).toEqual(["place", "latitude", "longitude"]);
    expect(tool?.description).toContain("place에 지명을 적는다");
    expect(tool).toEqual({
      ...KMA_WEATHER_TOOLS[0],
      annotations: { readOnlyHint: true },
    });
  });

  test("a district by name is asked for at 기상청's cell for it, and the answer says which row", async () => {
    const made = shipped();
    const { facts } = await weatherOf(made, { place: "서울 종로" });
    expect(made.asked[0]?.cell).toBe("60,127");
    expect(facts.place).toBe("서울특별시 종로구");

    await made.transport
      .callTool(connection, "get_weather", { place: "부산 해운대구" })
      .catch(() => null);
    expect(made.asked.at(-1)?.cell).toBe("99,75");
  });

  test("광주 is the city, not the merged province's office a hundred kilometres away", async () => {
    const made = shipped();
    await made.transport
      .callTool(connection, "get_weather", { place: "광주" })
      .catch(() => null);
    // 서구's cell, in the middle of the five districts. The province's own row is 51,67, in 무안.
    expect(made.asked.at(-1)?.cell).toBe("59,74");
    await made.transport
      .callTool(connection, "get_weather", { place: "전남 순천" })
      .catch(() => null);
    expect(made.asked.at(-1)?.cell).toBe("70,70");
  });

  test("a province is answered at its one cell, and the answer says where that is", async () => {
    const made = shipped({
      "now 20261002/0000": SEOUL_MIDNIGHT.now,
    });
    const { facts } = await weatherOf(made, { place: "강원도" });
    expect(made.asked[0]?.cell).toBe("73,134");
    // Not "강원특별자치도" alone: 강릉 and 춘천 are two weathers, and this is 춘천's.
    expect(facts.place).toBe("강원특별자치도(대표 지점: 춘천시)");
  });

  test("고성 is two places and is refused; 강원 고성 is one", async () => {
    const made = shipped();
    const refused = await refusalOf(() =>
      made.transport.callTool(connection, "get_weather", { place: "고성" }),
    );
    expect(refused.code).toBe("laf:weather_place_ambiguous");
    expect(refused.message).toBe("laf:weather_place_ambiguous: 2 candidates");
    expect(made.asked).toEqual([]);

    await made.transport
      .callTool(connection, "get_weather", { place: "강원 고성" })
      .catch(() => null);
    expect(made.asked.at(-1)?.cell).toBe("85,145");
  });

  test("coordinates come back with the districts that cell is", async () => {
    const { facts } = await weatherOf(shipped(), SEOUL);
    expect(facts.place).toBe(
      "서울특별시 종로구·중구 등 (위도 37.57, 경도 126.98)",
    );
  });

  test("the words a person saved are read the same way", async () => {
    const made = shipped(MIDNIGHT, {
      coordinatesOf: async () => null,
      placeOf: async () => "서울 강남구",
    });
    const { facts } = await weatherOf(made, {});
    expect(made.asked[0]?.cell).toBe("61,126");
    expect(facts.place).toBe("서울특별시 강남구");
    expect(facts.basis).toBe("저장된 위치");
  });
});

/* ── the key ─────────────────────────────────────────────────────────────────────────────────── */

describe("the key", () => {
  /** Everything an error could carry to a log line, an audit row or an export. */
  const everythingIn = (error: unknown): string => {
    const seen = new Set<unknown>();
    const walk = (value: unknown): string => {
      if (!(value instanceof Error) || seen.has(value)) return String(value);
      seen.add(value);
      return [
        String(value),
        value.stack ?? "",
        JSON.stringify(value, Object.getOwnPropertyNames(value)),
        walk(value.cause),
      ].join("\n");
    };
    return walk(error);
  };

  const thrownBy = async (
    reply: (asked: Asked) => Response | Promise<Response>,
    args: Record<string, unknown> = SEOUL,
  ) => {
    const made = hub(reply);
    const error = await made.transport
      .callTool(connection, "get_weather", args)
      .catch((thrown: unknown) => thrown);
    return { error, asked: made.asked };
  };

  test("goes out on every request, and is in nothing that comes back as an error", async () => {
    const echoes: ((asked: Asked) => Response | Promise<Response>)[] = [
      // A runtime that names the address it could not reach — the realistic leak.
      (asked) => {
        throw new Error(`Unable to connect to ${asked.url}`);
      },
      (asked) => {
        throw Object.assign(new Error(`request to ${asked.url} timed out`), {
          name: "TimeoutError",
          cause: new Error(`ETIMEDOUT ${asked.url}`),
        });
      },
      // A page that repeats the query string, the key first so it is inside what is kept.
      (asked) =>
        new Response(`<pre>${new URL(asked.url).search}</pre>`, {
          status: 200,
        }),
      (asked) =>
        new Response(`authKey=${KEY} 는 등록되지 않았습니다: ${asked.url}`, {
          status: 200,
        }),
      // The gateway quoting the key it refused, in both spellings.
      () =>
        new Response(
          JSON.stringify({
            result: {
              status: 401,
              message: `유효한 인증키가 아닙니다: ${KEY} (${KEY_AS_SENT})`,
            },
          }),
          { status: 401 },
        ),
      () =>
        new Response(
          JSON.stringify({
            result: {
              status: 403,
              message: `활용신청이 필요한 API 입니다. authKey=${KEY_AS_SENT}`,
            },
          }),
          { status: 403 },
        ),
      // The service doing the same in a result message.
      () =>
        new Response(
          JSON.stringify({
            response: {
              header: { resultCode: "30", resultMsg: `KEY ${KEY} ERROR` },
            },
          }),
          { status: 200 },
        ),
      () => new Response(`${KEY}${"x".repeat(RAW_RESPONSE_CAP_CHARS)}`),
    ];

    const codes: string[] = [];
    for (const echo of echoes) {
      const { error, asked } = await thrownBy(echo);
      // The positive control: the key really left, on every request, spelled for a query string.
      expect(asked.length).toBeGreaterThan(0);
      for (const call of asked) {
        expect(call.url).toContain(`authKey=${KEY_AS_SENT}`);
      }
      expect(error).toBeInstanceOf(PluginRefusedError);
      codes.push((error as PluginRefusedError).code);
      const said = everythingIn(error);
      expect(said).not.toContain(KEY);
      expect(said).not.toContain(KEY_AS_SENT);
      expect(said).not.toContain(encodeURIComponent(KEY));
    }
    expect(codes).toEqual([
      "laf:weather_unreachable",
      "laf:weather_unreachable",
      "laf:weather_unreadable",
      "laf:weather_unreadable",
      "laf:weather_refused",
      "laf:weather_not_open",
      "laf:weather_refused",
      "laf:weather_too_large",
    ]);
  });

  test("is in no refusal that never reached the hub either", async () => {
    for (const args of [
      { latitude: 35.6762, longitude: 139.6503 },
      { latitude: 37.5 },
      { place: "부산" },
      {},
    ]) {
      const { error } = await thrownBy(noData, args);
      expect(error).toBeInstanceOf(PluginRefusedError);
      expect(everythingIn(error)).not.toContain(KEY);
    }
  });

  test("is not in an answer", async () => {
    const { text } = await weatherOf(hub(MIDNIGHT));
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(KEY_AS_SENT);
  });
});
