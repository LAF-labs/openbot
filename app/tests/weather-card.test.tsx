import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { stepDidNotWork } from "@shared/tools/step-result";
import {
  FALL_WORDS,
  SKY_WORDS,
  WEATHER_DATA_HEAD,
  weatherOf,
} from "@shared/weather";
import { createElement } from "react";
import { ko } from "../src/lib/i18n-ko";
import { mount, unmountAll } from "./support/mount";

/**
 * THE WEATHER IS A CARD, DRAWN FROM THE TOOL'S OWN ANSWER.
 *
 * The owner, 2026-10-04: "날씨는 애초에 오늘 날씨 최고 최저 기온, 그리고 앞으로 7일간의 날씨를
 * 보여주는 전용 카드 같은 걸 만들고 … 그 안에 출처 기상청 표시를 작게 해." The card is drawn from
 * the text the tool answered with — the same text the model reads — so these hold the reading of
 * that text and what the card makes of it. The answer below is one the local stack's own tool
 * gave (인천, 2026-10-04 07:00), as the conversation kept it.
 */

beforeAll(() => {
  GlobalRegistrator.register();
});
afterEach(async () => {
  await unmountAll();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const ANSWER = JSON.stringify({
  source: "기상청",
  place: "인천광역시",
  issued: { now: "10-04 07:00", hours: "10-04 07:00", days: "10-04 05:00" },
  units: "기온 ℃, 습도·강수확률 %, 바람 m/s",
  now: { temp: 11.6, humidity: 97, precip: "없음", wind: 0.1 },
  hours: [{ at: "8시", temp: 15, sky: "맑음", precip: "없음" }],
  days: [
    {
      date: "2026-10-04",
      day: "일",
      when: "오늘",
      min: 15,
      max: 24,
      am: "구름많음 30%",
      pm: "흐림 60%",
      precip: "비 19~24시(1mm 미만·1.0mm·18.0mm)",
    },
    {
      date: "2026-10-05",
      day: "월",
      when: "내일",
      min: 15,
      max: 19,
      am: "흐림 30%",
      pm: "흐림 30%",
      precip: "없음",
    },
    {
      date: "2026-10-06",
      day: "화",
      when: "모레",
      min: 11,
      max: 21,
      am: "맑음 20%",
      pm: "맑음 20%",
      precip: "없음",
    },
    {
      date: "2026-10-07",
      day: "수",
      when: "글피",
      min: 11,
      max: 23,
      am: "맑음 0%",
      pm: "맑음 0%",
      precip: "없음",
    },
  ],
});

describe("the weather tool's answer, read for the card", () => {
  test("is the place, the temperature now and each day's high, low, sky and chance", () => {
    expect(ANSWER.startsWith(WEATHER_DATA_HEAD)).toBe(true);
    expect(weatherOf(ANSWER)).toEqual({
      place: "인천광역시",
      temp: 11.6,
      days: [
        {
          date: "2026-10-04",
          min: 15,
          max: 24,
          sky: "overcast",
          chance: 60,
          falls: "rain",
        },
        {
          date: "2026-10-05",
          min: 15,
          max: 19,
          sky: "overcast",
          chance: 30,
          falls: null,
        },
        {
          date: "2026-10-06",
          min: 11,
          max: 21,
          sky: "clear",
          chance: 20,
          falls: null,
        },
        {
          date: "2026-10-07",
          min: 11,
          max: 23,
          sky: "clear",
          chance: 0,
          falls: null,
        },
      ],
    });
  });

  test("is nothing where the text is not data: a refusal, a failure, another tool's answer", () => {
    for (const text of [
      "laf:weather_place_outside",
      JSON.stringify({ ok: false, code: "laf:weather_unreachable" }),
      "The tool reported an error: quota exceeded",
      JSON.stringify({ source: "네이버", place: "서울" }),
      `${WEATHER_DATA_HEAD},"place":"서울"`,
      // Data's head with neither a reading nor a day: nothing to draw.
      JSON.stringify({
        source: "기상청",
        place: "서울",
        unavailable: ["현재 관측"],
      }),
      "",
    ]) {
      expect([text, weatherOf(text)]).toEqual([text, null]);
    }
    // And an answer with data is not a step that did not work.
    expect(stepDidNotWork(ANSWER)).toBe(false);
  });

  test("reads what there is: a day with no afternoon left, a reading that is not a number", () => {
    const partial = JSON.stringify({
      source: "기상청",
      place: "제주",
      now: { temp: null, humidity: 80 },
      days: [
        {
          date: "2026-10-04",
          min: null,
          max: 22,
          am: "맑음 10%",
          precip: "없음",
        },
        { date: "2026-10-05", min: 12, max: 20, pm: "60%", precip: "눈 3~6시" },
        { date: "2026-10-06", min: 9, max: 18, precip: "비/눈" },
        { min: 1, max: 2 },
      ],
    });
    expect(weatherOf(partial)).toEqual({
      place: "제주",
      temp: null,
      days: [
        {
          date: "2026-10-04",
          min: null,
          max: 22,
          sky: "clear",
          chance: 10,
          falls: null,
        },
        {
          date: "2026-10-05",
          min: 12,
          max: 20,
          sky: null,
          chance: 60,
          falls: "snow",
        },
        {
          date: "2026-10-06",
          min: 9,
          max: 18,
          sky: null,
          chance: null,
          falls: "sleet",
        },
      ],
    });
  });

  /*
   * A DAY THAT TURNED has several kinds, joined by a middle dot — the server's own fixture is
   * "눈·비/눈·소나기 9~13시(…)". Read as one word it matched nothing, and a wet day was drawn with
   * the sky's picture (Codex on pull request 62).
   */
  test("reads what falls on a day that turned: each kind, and rain with snow as either", () => {
    const fallsOn = (precip: string) =>
      weatherOf(
        JSON.stringify({
          source: "기상청",
          place: "서울",
          days: [{ date: "2026-12-19", min: -3, max: 4, precip }],
        }),
      )?.days[0]?.falls;
    expect(
      [
        "눈·비/눈·소나기 9~13시(1.0mm·30.0~50.0mm·50.0mm 이상)",
        "비·소나기 3~9시(5.0mm)",
        "눈·눈날림 0~6시",
        "비·눈 0~6시",
        "빗방울눈날림 1~2시",
        "강수 1~2시",
        // A kind the table has no word for is still something falling.
        "우박 14~15시",
        "없음",
      ].map(fallsOn),
    ).toEqual([
      "sleet",
      "rain",
      "snow",
      "sleet",
      "sleet",
      "rain",
      "rain",
      null,
    ]);
  });
});

describe("the weather card", () => {
  async function card(result: string) {
    const { WeatherCard } = await import(
      "../src/components/weather/weather-card"
    );
    const view = await mount(createElement(WeatherCard, { result }));
    return view.host.querySelector<HTMLElement>('[data-slot="weather-card"]');
  }

  test("shows where, the temperature now, today's high and low, and a column a day", async () => {
    const drawn = await card(ANSWER);
    expect(drawn?.getAttribute("aria-label")).toBe("Weather for 인천광역시");
    expect(drawn?.querySelector("[data-weather-now]")?.textContent).toBe("12°");
    expect(drawn?.querySelector("[data-weather-today]")?.textContent).toBe(
      "High 24° · Low 15°",
    );
    const days = [...(drawn?.querySelectorAll("[data-weather-day]") ?? [])];
    expect(days.map((day) => day.getAttribute("data-weather-day"))).toEqual([
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
    ]);
    // Each column: the picture by its name, the high, the low, and the chance where it is 30 or more.
    expect(
      days.map((day) => [
        day.querySelector('[role="img"]')?.getAttribute("aria-label"),
        ...[...day.querySelectorAll("span.tabular-nums")].map(
          (value) => value.textContent,
        ),
      ]),
    ).toEqual([
      ["Rain", "24°", "15°", "60%"],
      ["Overcast", "19°", "15°", "30%"],
      ["Clear sky", "21°", "11°", ""],
      ["Clear sky", "23°", "11°", ""],
    ]);
    // Four columns for four days: the grid is as wide as what there is.
    expect(drawn?.querySelector("ol")?.className).toContain("grid-cols-4");
  });

  /*
   * 출처: 기상청 — in those words, readable where the data is (기상법, since 2026-09-18; the API
   * hub's notice of 2026-09-14). Small, and the card's own: there is no line of it under an answer.
   */
  test("names its source on the card, small, in the agency's own wording", async () => {
    const drawn = await card(ANSWER);
    const source = drawn?.querySelector<HTMLElement>("[data-weather-source]");
    expect(source?.textContent).toBe(
      "Source: Korea Meteorological Administration",
    );
    expect(source?.className).toContain("text-xs");
    expect(ko["Source: {names}"]).toBe("출처: {names}");
    expect(ko["Korea Meteorological Administration"]).toBe("기상청");
  });

  test("draws nothing for an answer that is not data, and at most seven days", async () => {
    expect(await card("laf:weather_place_outside")).toBe(null);
    const week = JSON.stringify({
      source: "기상청",
      place: "서울",
      days: Array.from({ length: 9 }, (_, at) => ({
        date: `2026-10-${String(4 + at).padStart(2, "0")}`,
        min: 10,
        max: 20,
        am: "맑음 0%",
      })),
    });
    const drawn = await card(week);
    expect(drawn?.querySelectorAll("[data-weather-day]").length).toBe(7);
    expect(drawn?.querySelector("ol")?.className).toContain("grid-cols-7");
    // No reading now: the high and the low stand without it.
    expect(drawn?.querySelectorAll("[data-weather-now]").length).toBe(0);
  });

  test("has a name in Korean for every picture, and a picture for every word the tool writes", async () => {
    const { FALL_NAMES, SKY_NAMES } = await import(
      "../src/components/weather/weather-card"
    );
    for (const name of [
      ...Object.values(SKY_NAMES),
      ...Object.values(FALL_NAMES),
    ]) {
      expect([name, typeof ko[name]]).toEqual([name, "string"]);
    }
    expect(Object.keys(SKY_NAMES).sort()).toEqual(
      Object.keys(SKY_WORDS).sort(),
    );
    expect([...new Set<string>(Object.values(FALL_WORDS))].sort()).toEqual(
      Object.keys(FALL_NAMES).sort(),
    );
  });
});
