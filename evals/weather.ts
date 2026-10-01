/**
 * 기상청's answer as the Bot's weather tool hands it over — for the scenarios that hold a candidate
 * to the tool instead of to a weather page.
 *
 * The weather scenarios before these (`weather-names-the-owners-place` and its neighbours) give a
 * Bot a browser and a 네이버 page, which is what every Bot had until 2026-10-02 and what a
 * deployment without the hub's key still has. These give it `get_weather` beside everything else a
 * connected Bot holds, and a model that searches or browses anyway has cost the person exactly what
 * the tool exists to save — twenty seconds, and a third party's rendering of numbers 기상청
 * publishes itself.
 *
 * THE ANSWER IS THE TRANSPORT'S OWN SHAPE (`server/src/plugins/kma-weather-rest.ts`): the keys, the
 * words for the sky and the days ("오늘", "내일", "모레", "글피"), the issuance stamps. Copied from a
 * real answer for 서울 강남구 on 2026-10-02 at 03:00 KST, with the figures replaced by ones nobody
 * would guess: an answer that says 17.3도 read it here, and one that says anything else did not.
 *
 * THE DATES ARE THE EVAL CLOCK'S. `EVAL_NOW` is the real clock, so a fixture with a fixed date
 * would be yesterday's forecast the day after it was written — and a Bot that noticed would be
 * right to say so.
 */
import { toolResultText } from "../shared/prompt/tool-results.ko";
import { zonedParts } from "../shared/prompt/zone";
import { WEATHER_TOOL_NAME } from "../shared/tools/bridge";
import { calendarDayAfter, weekdayOf } from "./grounded";
import type { ObservedCall } from "./lib";

/** One place the tool knows in these scenarios, with figures that are nobody's guess. */
export type EvalWeatherPlace = {
  /** What a person or a Bot calls it — matched inside whatever was said. */
  said: string;
  /** 기상청's name for it, as the answer carries it. */
  name: string;
  /** 지금 기온. One decimal, as the observation has. */
  now: number;
  /** 내일 최고. */
  tomorrowMax: number;
};

export const GANGNAM: EvalWeatherPlace = {
  said: "강남",
  name: "서울특별시 강남구",
  now: 17.3,
  tomorrowMax: 23,
};
export const MAPO: EvalWeatherPlace = {
  said: "마포",
  name: "서울특별시 마포구",
  now: 16.8,
  tomorrowMax: 22,
};
export const HAEUNDAE: EvalWeatherPlace = {
  said: "해운대",
  name: "부산광역시 해운대구",
  now: 19.6,
  tomorrowMax: 31,
};

const PLACES = [GANGNAM, MAPO, HAEUNDAE];
const DAYS_AHEAD = ["오늘", "내일", "모레", "글피"] as const;

/** The transport's answer for one place at `at`: now, six hours, four days. */
export function weatherAnswer(
  place: EvalWeatherPlace,
  at: Date,
  saved: boolean,
): string {
  const { date: today, time } = zonedParts(at, "Asia/Seoul");
  const hour = Number(time.slice(0, 2));
  const stamp = (h: number) =>
    `${today.slice(5)} ${String(h).padStart(2, "0")}:00`;
  return JSON.stringify({
    source: "기상청",
    place: place.name,
    ...(saved ? { basis: "저장된 위치" } : {}),
    issued: { now: stamp(hour), hours: stamp(hour), days: stamp(2) },
    units: "기온 ℃, 습도·강수확률 %, 바람 m/s",
    now: { temp: place.now, humidity: 41, precip: "없음", wind: 1.8 },
    hours: Array.from({ length: 6 }, (_, index) => {
      const ahead = hour + 1 + index;
      return {
        at: ahead < 24 ? `${ahead}시` : `내일 ${ahead - 24}시`,
        // Always below the observation rounded, so "17도" in an answer is the 17.3 and not an hour's.
        temp: Math.round(place.now) - 1 - Math.floor(index / 2),
        sky: "맑음",
        precip: "없음",
      };
    }),
    days: DAYS_AHEAD.map((when, ahead) => {
      const date = calendarDayAfter(today, ahead);
      return {
        date,
        day: weekdayOf(date),
        when,
        min: 12 + ahead,
        max: ahead === 1 ? place.tomorrowMax : 21 + ahead,
        am: ahead === 3 ? "흐림 60%" : "맑음 0%",
        pm: ahead === 3 ? "흐림 70%" : "구름많음 20%",
        precip: ahead === 3 ? "비 9~18시(5mm)" : "없음",
      };
    }),
  });
}

/**
 * The tool, answering as the product's does: a place named in the call, or else the saved one —
 * and with neither, the sentence a Bot is told when nobody's place is known.
 *
 * `remember` with a place saves it, as the server's does in the same turn: a Bot that saves
 * "서울 마포구" and then asks with no argument is asking about 마포.
 */
export function weatherBackend(input: {
  at: Date;
  saved?: EvalWeatherPlace;
}): (call: ObservedCall) => string | undefined {
  let saved = input.saved ?? null;
  const named = (words: string) =>
    PLACES.find((place) => words.includes(place.said)) ?? null;
  return (call) => {
    if (call.name === "remember") {
      saved = named(String(call.arguments?.place ?? "")) ?? saved;
      return undefined;
    }
    if (call.name !== WEATHER_TOOL_NAME) return undefined;
    const asked = String(call.arguments?.place ?? "").trim();
    if (asked) {
      const place = named(asked);
      return place
        ? weatherAnswer(place, input.at, false)
        : toolResultText("laf:weather_place_not_found");
    }
    return saved
      ? weatherAnswer(saved, input.at, true)
      : toolResultText("laf:weather_place_unknown");
  };
}

/** The place every weather call of a turn named, in order; "" for a call that named none. */
export function weatherPlacesAsked(calls: readonly ObservedCall[]): string[] {
  return calls
    .filter((call) => call.name === WEATHER_TOOL_NAME)
    .map((call) => String(call.arguments?.place ?? "").trim());
}

/**
 * Whether the answer gives the observation: the figure as 기상청 sent it, or rounded to a degree.
 *
 * Rounded counts. The first three runs of `weather-from-the-agency` behind the new place line said
 * "지금 17도 정도" twice for 17.3 — which is how a person is told the temperature — and a check for
 * the decimal alone failed both. No other figure in the answer rounds to the same degree
 * (`weatherAnswer`'s hours are all below it), so a rounded figure is still this one.
 */
export function saysNow(text: string, place: EvalWeatherPlace): boolean {
  return (
    text.includes(String(place.now)) || saysDegrees(text, Math.round(place.now))
  );
}

/** Whether a temperature was said as one: "31도", "31℃", "31°", "31 °C". A bare 31 is a date. */
export function saysDegrees(text: string, degrees: number): boolean {
  const figure = String(degrees).replace(".", "\\.");
  return new RegExp(`(?<![\\d.])${figure}\\s?(도|℃|°)`).test(text);
}
