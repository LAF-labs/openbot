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
   * is two. A closing bracket or quote belongs to the sentence its mark ended ("맑아요." 내일은 …
   * is two as well; review, round 5), a digit after a point is the rest of a figure ("17.3도"), and
   * a mark after a mark is the same ending.
   */
  const sentences = said
    .split(
      /(?<=[.!?。！？][)\]}"'”’]*)(?:\s+|(?=[^\s\d.!?。！？)\]}"'”’]))|\n+/,
    )
    .filter((part) => part.trim().length > 0);
  const figures = said.match(/(?<![\d.])\d+(?:\.\d+)?\s?(?:도|℃|°)/g) ?? [];
  return (
    sentences.length === 1 && figures.length <= 1 && !/출처|기상청/.test(said)
  );
}

/**
 * Whether the sentence agrees with the card it stands under.
 *
 * The forecast every weather scenario is handed (`weatherAnswer`) is the same sky: clear, then
 * clouds in the afternoon, nothing falling today or tomorrow; rain comes only on the fourth day.
 * `leavesItToTheCard` holds the shape of the answer and not its truth, so "오늘은 폭설이에요" —
 * one sentence, no figure, no source — passed it under a card of clear sky (Codex on pull request
 * 62). This is the truth check, as far as words can carry one without a model:
 *
 *  - it is about the weather at all — a sky, a temperature, what falls or does not, a word for how
 *    it feels. "오늘은 바깥일하기 무난한 날이에요" says nothing the card says and fails here;
 *  - nothing falls, said as falling. A negated mention is how the Bot usually puts it ("비 없이",
 *    "비는 안 와요") and is right;
 *  - no weather the forecast does not hold: snow, a storm, a heat wave, an overcast sky;
 *  - every temperature it says is one the card holds — the reading now, an hour's, a day's low or
 *    high, as written or rounded, WITH ITS SIGN: "영하 17도" and "-17도" are −17, not 17 (review,
 *    rounds 7 and 8). "강남은 지금 99도예요" passed the shape.
 */
export function agreesWithTheCard(text: string, card: string): boolean {
  const said = text.replace(/\s+/g, " ");
  const figures = [
    ...said.matchAll(
      /(영하\s*)?(?<![\d.])([-−]?)(\d+(?:\.\d+)?)\s?(?:도|℃|°)/g,
    ),
  ].map((match) => {
    const belowZero = match[1] !== undefined || match[2] !== "";
    return (belowZero ? -1 : 1) * Number(match[3]);
  });
  const onTheCard = temperaturesOf(card);
  const everyFigureIsTheCards = figures.every(
    (figure) => onTheCard.has(figure) || onTheCard.has(Math.round(figure)),
  );
  const aboutTheWeather =
    /맑|구름|흐|비|눈|바람|기온|℃|°|\d\s?도|덥|더워|더운|춥|추워|추운|선선|쌀쌀|따뜻|포근|우산|하늘|화창|쾌청|습도|습해|건조|날씨/.test(
      said,
    );
  const saysItFalls =
    /(비|눈)(가|이|는|도)?\s*(와|오|옵|올|내리|내릴)/.test(said) &&
    !/없|안 |않|말고/.test(said);
  const notInTheForecast =
    /폭설|폭우|태풍|우박|소나기|장마|한파|폭염|천둥|번개|흐리|흐림|흐려|안개/.test(
      said,
    );
  return (
    aboutTheWeather &&
    !saysItFalls &&
    !notInTheForecast &&
    everyFigureIsTheCards
  );
}

/** Every temperature the tool's answer holds, as written and rounded: what an answer may say in degrees. */
function temperaturesOf(card: string): Set<number> {
  const found = new Set<number>();
  const add = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      found.add(value);
      found.add(Math.round(value));
    }
  };
  try {
    const answer = JSON.parse(card) as {
      now?: { temp?: unknown };
      hours?: { temp?: unknown }[];
      days?: { min?: unknown; max?: unknown }[];
    };
    add(answer.now?.temp);
    for (const hour of answer.hours ?? []) add(hour.temp);
    for (const day of answer.days ?? []) {
      add(day.min);
      add(day.max);
    }
  } catch {
    // Not the tool's answer: nothing may be said in degrees.
  }
  return found;
}

/** Whether a temperature was said as one: "31도", "31℃", "31°", "31 °C". A bare 31 is a date. */
export function saysDegrees(text: string, degrees: number): boolean {
  const figure = String(degrees).replace(".", "\\.");
  return new RegExp(`(?<![\\d.])${figure}\\s?(도|℃|°)`).test(text);
}
