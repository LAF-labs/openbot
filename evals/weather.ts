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
import { WEATHER_SHOWN } from "../shared/weather";
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
    // The transport's own last field: the forecast is on the screen already.
    shown: WEATHER_SHOWN,
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
 * Whether an answer leaves the forecast to the card.
 *
 * THE WEATHER IS DRAWN AS A CARD from the tool's own answer (the owner, 2026-10-04: "전용 카드 같은
 * 걸 만들고, 모델 호출 비용은 최대한 줄여"), so what the model is asked for is one sentence about
 * what was asked — not the temperature now, the day's low and high, the morning and the afternoon
 * written out under a card that shows them. Measured: the 33 weather answers the local stack's
 * conversation held from before the tool said so ran 43 to 222 characters, 80 at the middle, with
 * three figures in the middle one and up to six; the twelve of these scenarios after it ran 17 to
 * 47, with no figure or the one that was asked for.
 *
 * WHAT IT HOLDS AN ANSWER TO, each a way the long answer comes back:
 *  - one sentence — a second one is where the recital starts ("…비가 옵니다. 자세한 예보는
 *    …"), and so is a second line;
 *  - at most one figure: "최고 몇 도까지 올라가?" is answered with it;
 *  - no word of where the data is from: the card names 기상청, and the rule says not to again.
 * The first cut counted characters and figures only, and "오늘은 흐리고 비가 옵니다. 자세한 예보는
 * 기상청 자료입니다." passed it — two sentences and the source, under a check that says "one
 * sentence" in its own failure line (Codex on pull request 62). The second split sentences only at
 * a space, and "오늘은 맑아요.내일은 흐려요." was one (the same review, a round later).
 */
export function leavesItToTheCard(text: string): boolean {
  const said = text.trim();
  if (said.length === 0 || said.length > 80) return false;
  /*
   * A sentence ends at its mark where more follows it — after a space or straight on: "맑아요.내일은"
   * is two. What follows a point inside a figure is a digit ("17.3도"), and what follows a mark in a
   * run of them, or before a closing bracket or quote, is not a new sentence either.
   */
  const sentences = said
    .split(/(?<=[.!?。！？])(?:\s+|(?=[^\s\d.!?。！？)\]}"'”’]))|\n+/)
    .filter((part) => part.trim().length > 0);
  const figures = said.match(/(?<![\d.])\d+(?:\.\d+)?\s?(?:도|℃|°)/g) ?? [];
  return (
    sentences.length === 1 && figures.length <= 1 && !/출처|기상청/.test(said)
  );
}

/** Whether a temperature was said as one: "31도", "31℃", "31°", "31 °C". A bare 31 is a date. */
export function saysDegrees(text: string, degrees: number): boolean {
  const figure = String(degrees).replace(".", "\\.");
  return new RegExp(`(?<![\\d.])${figure}\\s?(도|℃|°)`).test(text);
}
