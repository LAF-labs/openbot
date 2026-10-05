/**
 * THE WEATHER TOOL'S ANSWER, AS THE TWO SIDES THAT USE IT KNOW IT.
 *
 * The server writes it (`server/src/plugins/kma-weather-rest.ts`) as the text a Bot's model reads:
 * 기상청's readings in a small JSON object, its conditions in Korean words a model reads well. The
 * app draws a card from the very same text — the owner, 2026-10-04: "날씨는 애초에 오늘 날씨 최고
 * 최저 기온, 그리고 앞으로 7일간의 날씨를 보여주는 전용 카드 같은 걸 만들고, 모델 호출 비용은
 * 최대한 줄여." A card drawn from the result costs no model call and no word of the model's.
 *
 * So what the card has to recognise is named here once, and the server writes from the same
 * tables: the words for the sky and for what falls. A word the server wrote and the card could not
 * read would be a day drawn with no picture, and nothing would say so.
 *
 * The answer's other fields — the hours ahead, the units, and a last one saying the card is on
 * the screen (`WEATHER_SHOWN`) — are the model's, and the card does not read them.
 */

/** How an answer that holds data begins. A refusal or a failure is some other text (`step-result.ts`). */
export const WEATHER_DATA_HEAD = '{"source":"기상청"';

/**
 * THE LAST THING THE MODEL READS BEFORE IT ANSWERS: that the forecast is on the screen already.
 * The answer's last field, `shown` — A FACT, and the rule that follows from it is in the tool's
 * description (`kmaWeatherTools`).
 *
 * A paragraph that writes the card's figures out under the card is paid for twice and read twice.
 * Three ways of saying so were measured on the fleet's model (2026-10-04):
 *
 *  - THE RULE IN THE DESCRIPTION ALONE. A fresh conversation: one sentence, twelve of twelve. The
 *    local stack's own conversation, which holds thirty earlier weather answers written the long
 *    way: the long way again, figures, source line and all, under the card. What a model has said
 *    before outweighs a sentence in a tool list.
 *  - THE RULE IN THE ANSWER ITSELF, as its last field. That conversation: one sentence, two of
 *    two. Fresh ones: fourteen of fifteen — and in one of them the Bot told the person about it:
 *    "받아온 예보 메모에는 한 문장으로만 답하고 숫자와 출처는 되풀이하지 말라고 적혀 있었는데요".
 *    An instruction in a tool's answer is read as something the tool said, which it is.
 *  - THIS: the fact where the model reads it last, the rule where rules are read. A fact that is
 *    repeated to the person ("위에 카드로 보여 드렸어요") is true, and reads as the Bot speaking.
 *
 * AND IT IS A FACT ONLY WHERE A CARD IS DRAWN: the server writes it when the answer holds what
 * `weatherOf` reads — a temperature now, or a day — AND the call's row is drawn in a conversation
 * (a chat turn's call; not a routine's, whose answer reaches the person as words with no card under
 * them — `connection.drawnOn`, in `server/src/plugins/transport.ts`, which is about the surface
 * and not about who is looking). An answer with the next hours and nothing else (the observation
 * and the daily forecast both missing, late in the evening) has no card, so it is not told it has
 * one, and the rule in the description hangs on this field being there.
 */
export const WEATHER_SHOWN = "사용자 화면에 날씨 카드로 이미 표시됨";

/** 하늘상태, as the answer says it. 기상청's codes are 1, 3 and 4; there is no 2. */
export const SKY_WORDS = {
  clear: "맑음",
  cloudy: "구름많음",
  overcast: "흐림",
} as const;
export type SkyKind = keyof typeof SKY_WORDS;

/** What a day with nothing falling says. */
export const NOTHING_FALLS = "없음";

/** How a day's row says it is the day the answer was written (`when`); the rows after it say 내일, 모레. */
export const TODAY = "오늘";

/**
 * 강수형태, as the answer says it, and the one of three pictures each is drawn with. "강수" is the
 * word for a code the server has no name for: still something falling, drawn as rain.
 */
export const FALL_WORDS = {
  비: "rain",
  소나기: "rain",
  빗방울: "rain",
  강수: "rain",
  "비/눈": "sleet",
  빗방울눈날림: "sleet",
  눈: "snow",
  눈날림: "snow",
} as const satisfies Record<string, "rain" | "snow" | "sleet">;
export type FallKind = (typeof FALL_WORDS)[keyof typeof FALL_WORDS];

/** One day of the forecast, as the card draws it. */
export type WeatherDay = {
  /** `2026-10-04`, the day's date where the place is. */
  date: string;
  min: number | null;
  max: number | null;
  /**
   * The sky of the afternoon, or of the morning where the afternoon has none left — or the day's
   * one sky, where the forecast has one for the whole day (중기예보 from its eighth day, `allDay`).
   */
  sky: SkyKind | null;
  /** The highest of the day's chances of precipitation, in percent. */
  chance: number | null;
  /** What falls that day, where something does. */
  falls: FallKind | null;
};

/**
 * Where the place of an answer came from — a fact, beside the place itself.
 *
 *   named     the call said which place (a name or coordinates)
 *   saved     the person's own place, in the words they or their Bot saved
 *   device    the person's device, coarse
 *   fallback  nobody's: nothing is known of where the person is, and the answer is Seoul's
 *
 * The owner, 2026-10-05: "기본값 실제 위치 데이터, fallback은 서울, 유저가 특정 위치를 말해주면
 * 저장." An answer for Seoul that nobody chose has to say so — to the Bot, which tells the person in
 * a few words, and to the card, which writes it small — or it reads as the person's own weather.
 */
export const WEATHER_PLACE_SOURCES = [
  "named",
  "saved",
  "device",
  "fallback",
] as const;
export type WeatherPlaceSource = (typeof WEATHER_PLACE_SOURCES)[number];

/** The answer, as the card draws it. */
export type WeatherData = {
  /** The place in the server's words, for the model — drawn only where the two facts below are absent (answers from before they were written). */
  place: string;
  /** The place's name alone, where the server had one. */
  placeName: string | null;
  /** The coordinates alone, where the place was asked by them: the surface writes them in its own words. */
  coordinates: { latitude: number; longitude: number } | null;
  /** Where the place came from; null on an answer from before that was written, or one this does not know. */
  placeSource: WeatherPlaceSource | null;
  /** The temperature measured at the place, where the observation was had. */
  temp: number | null;
  /**
   * The day the answer was written, where the answer has a row for it — the row it calls 오늘
   * itself, and not whichever row is first. Late at night, with today's hours gone and the
   * morning's issuance not to be had, the first row is tomorrow (`daysOf`).
   */
  today: WeatherDay | null;
  days: WeatherDay[];
};

const SKY_OF_WORD = new Map<string, SkyKind>(
  (Object.entries(SKY_WORDS) as [SkyKind, string][]).map(([kind, word]) => [
    word,
    kind,
  ]),
);

const numberOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** "구름많음 30%" → the sky's kind and the chance. Either half may be missing. */
function halfOf(said: unknown): { sky: SkyKind | null; chance: number | null } {
  if (typeof said !== "string") return { sky: null, chance: null };
  const [first, ...rest] = said.trim().split(/\s+/);
  const sky = SKY_OF_WORD.get(first ?? "") ?? null;
  const percent = [first, ...rest].find((part) =>
    /^\d{1,3}%$/.test(part ?? ""),
  );
  return { sky, chance: percent ? Number(percent.slice(0, -1)) : null };
}

/**
 * "비 19~24시(1mm 미만)" → rain; "없음" → nothing; and 중기예보's "비(오후)" → rain, said with the
 * half of the day in place of the hours.
 *
 * A DAY CAN HAVE SEVERAL KINDS, joined by a middle dot: "눈·비/눈·소나기 9~13시(…)" is the server's
 * own fixture for a day that turned. Read as one word it matched nothing, and a wet day was drawn
 * with the sky's picture (Codex on pull request 62). Rain and snow on one day are drawn as the
 * picture for either; a kind this table has no word for is still something falling.
 */
function fallOf(said: unknown): FallKind | null {
  if (typeof said !== "string" || said.trim() === NOTHING_FALLS) return null;
  const words = (said.trim().split(/[\s(]/)[0] ?? "").split("·");
  const kinds = new Set(
    words.map(
      (word): FallKind =>
        (FALL_WORDS as Record<string, FallKind>)[word] ?? "rain",
    ),
  );
  if (kinds.size === 0) return null;
  if (kinds.size > 1 || kinds.has("sleet")) return "sleet";
  return kinds.has("snow") ? "snow" : "rain";
}

/**
 * The data in a weather tool's answer, or null where the text is not one — a refusal, a failure,
 * another tool's answer. Nothing is guessed: a day with no date is left out, and a reading that is
 * not a number is null, which the card draws as a dash.
 */
export function weatherOf(result: string): WeatherData | null {
  if (!result.startsWith(WEATHER_DATA_HEAD)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const answer = parsed as Record<string, unknown>;
  const place = typeof answer.place === "string" ? answer.place : "";
  const placeName =
    typeof answer.placeName === "string" && answer.placeName.trim()
      ? answer.placeName
      : null;
  const at = answer.coordinates as Record<string, unknown> | undefined;
  const latitude = at ? numberOf(at.latitude) : null;
  const longitude = at ? numberOf(at.longitude) : null;
  const coordinates =
    latitude !== null && longitude !== null ? { latitude, longitude } : null;
  const placeSource =
    WEATHER_PLACE_SOURCES.find((source) => source === answer.placeSource) ??
    null;
  const now = answer.now as Record<string, unknown> | undefined;
  const rows = (Array.isArray(answer.days) ? answer.days : []).flatMap(
    (entry): { isToday: boolean; row: WeatherDay }[] => {
      if (!entry || typeof entry !== "object") return [];
      const day = entry as Record<string, unknown>;
      if (typeof day.date !== "string") return [];
      const morning = halfOf(day.am);
      const afternoon = halfOf(day.pm);
      const whole = halfOf(day.allDay);
      const chances = [morning.chance, afternoon.chance, whole.chance].filter(
        (chance): chance is number => chance !== null,
      );
      return [
        {
          isToday: day.when === TODAY,
          row: {
            date: day.date,
            min: numberOf(day.min),
            max: numberOf(day.max),
            sky: afternoon.sky ?? morning.sky ?? whole.sky,
            chance: chances.length > 0 ? Math.max(...chances) : null,
            falls: fallOf(day.precip),
          },
        },
      ];
    },
  );
  const days = rows.map(({ row }) => row);
  const temp = now ? numberOf(now.temp) : null;
  // Nothing to draw: no reading and no day. The line of the call says it was made.
  if (temp === null && days.length === 0) return null;
  return {
    place,
    placeName,
    coordinates,
    placeSource,
    temp,
    today: rows.find(({ isToday }) => isToday)?.row ?? null,
    days,
  };
}
