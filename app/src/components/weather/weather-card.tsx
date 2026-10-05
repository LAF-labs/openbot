import {
  type FallKind,
  type SkyKind,
  type WeatherDay,
  weatherOf,
} from "@shared/weather";
import {
  IconCloud,
  IconCloudFilled,
  IconCloudRain,
  IconCloudSnow,
  IconSun,
} from "@tabler/icons-react";
import {
  chatCard,
  chatCardMeta,
  chatCardPadding,
} from "@/components/ui/card-surface";
import { activeLocale, t } from "@/lib/i18n";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

/**
 * THE WEATHER, AS A CARD — drawn from the weather tool's own answer, with no word of the model's.
 *
 * The owner, 2026-10-04: "날씨는 애초에 오늘 날씨 최고 최저 기온, 그리고 앞으로 7일간의 날씨를
 * 보여주는 전용 카드 같은 걸 만들고, 모델 호출 비용은 최대한 줄여. 그 안에 출처 기상청 표시를 작게
 * 해." Until then a weather answer was a paragraph the model wrote out of the tool's JSON — the
 * temperature now, the day's low and high, the morning and the afternoon, in words — and the
 * numbers were paid for twice: read by the model, then written by it.
 *
 * WHAT IT SHOWS, and nothing else: where, the temperature measured there, today's high and low,
 * and one column a day for as many days as the answer holds — a picture of the sky, the high, the
 * low, and the chance of rain where there is one to speak of. 단기예보 reaches three or four days
 * out and 중기예보 from there to the tenth, where the deployment has it; the grid takes one column a
 * day for as many as the answer holds, seven at the most (`DAYS_SHOWN`) — a week, which is what
 * was asked for, and what fits a phone's width. The days after it are in the answer for the Bot.
 *
 * `출처: 기상청` IS ON THE CARD, SMALL. Weather data from 기상청 has had to name its source where
 * it is shown since 2026-09-18 (기상법; the API hub's notice of 2026-09-14), in those words, and
 * readable where the data is. It is the card's last line, because the card is where the data is.
 *
 * THE WORDS ARE THE SURFACE'S. The answer says the sky in Korean for a model to read
 * (`shared/weather.ts`); the card reads the kind back and says it in the screen's language, as the
 * name of a picture.
 */

export const SKY_NAMES: Readonly<Record<SkyKind, string>> = {
  clear: "Clear sky",
  cloudy: "Mostly cloudy",
  overcast: "Overcast",
};
export const FALL_NAMES: Readonly<Record<FallKind, string>> = {
  rain: "Rain",
  snow: "Snow",
  sleet: "Rain or snow",
};

/** A chance of precipitation worth a number on the card: below it, the picture says enough. */
const CHANCE_SHOWN_FROM = 30;

/** Up to seven columns; Tailwind needs each class written out. */
const COLUMNS: Readonly<Record<number, string>> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
  6: "grid-cols-6",
  7: "grid-cols-7",
};
const DAYS_SHOWN = 7;

/** A calendar date where the forecast is for, as `2026-10-04`: 기상청 forecasts Korea. */
function koreanDate(at: Date, daysOn = 0): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(
    new Date(at.getTime() + daysOn * 86_400_000),
  );
}

/** 오늘, 내일, and after that the day of the week — by the clock, so an old card does not say 오늘. */
function dayLabel(date: string, now: Date): string {
  if (date === koreanDate(now)) return t("Today");
  if (date === koreanDate(now, 1)) return t("Tomorrow");
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(activeLocale, {
    weekday: "short",
    timeZone: "UTC",
  });
}

const degrees = (value: number | null) =>
  value === null ? "–" : `${Math.round(value)}°`;

/** The day's picture: what falls, where something does, and the sky where nothing does. */
function DayPicture({
  day,
  className,
}: {
  day: WeatherDay;
  className: string;
}) {
  const name = day.falls
    ? t(FALL_NAMES[day.falls])
    : day.sky
      ? t(SKY_NAMES[day.sky])
      : null;
  const Icon =
    day.falls === "rain"
      ? IconCloudRain
      : day.falls
        ? IconCloudSnow
        : day.sky === "clear"
          ? IconSun
          : day.sky === "cloudy"
            ? IconCloud
            : day.sky === "overcast"
              ? IconCloudFilled
              : null;
  // A day with neither: no picture, and the column keeps its height.
  if (!Icon || !name) return <span aria-hidden="true" className={className} />;
  return (
    <span aria-label={name} role="img" title={name}>
      <Icon aria-hidden="true" className={className} />
    </span>
  );
}

export function WeatherCard({ result }: { result: string }) {
  const now = useNow();
  const weather = weatherOf(result);
  if (!weather) return null;
  const days = weather.days.slice(0, DAYS_SHOWN);
  /*
   * THE DAY THE READING WAS TAKEN, AS THE ANSWER NAMES IT — not its first row. Late at night, with
   * today's hours gone and the morning's issuance not to be had, the answer begins with tomorrow,
   * and tomorrow's high, low and picture stood beside the temperature now as though they were
   * today's (Codex on pull request 62). Then the head is the temperature alone.
   *
   * And not the day on the reader's clock either: read a week later, this is still that
   * afternoon's temperature beside that day's high and low — only the columns' names are the
   * clock's (`dayLabel`).
   */
  const today = weather.today;
  /*
   * THE PLACE IN THE SURFACE'S WORDS. The answer names the place for the model (`place`), and
   * beside it the facts: the name alone, or the coordinates alone. A card drew the model's line —
   * "위도 37.57, 경도 126.98", the server's Korean — where the surface owns the words (review,
   * round 9). An answer from before the facts were written has only the line, and keeps it.
   */
  const place =
    weather.placeName ??
    (weather.coordinates
      ? t("Latitude {latitude}, longitude {longitude}", {
          latitude: weather.coordinates.latitude.toFixed(2),
          longitude: weather.coordinates.longitude.toFixed(2),
        })
      : weather.place);
  /*
   * SEOUL THAT NOBODY CHOSE SAYS SO, ON THE LINE THAT NAMES IT. Where nothing is known of where the
   * person is, the answer is 서울특별시's (the owner, 2026-10-05: "fallback은 서울") and carries that
   * as a fact (`placeSource`). Unsaid, the card reads as the person's own weather — to somebody in
   * 부산, a wrong forecast drawn with every sign of being theirs. A few words after the name, not a
   * line of their own: the reason, which is also what to fix. The label read aloud stays the place.
   */
  const placeLine =
    place && weather.placeSource === "fallback"
      ? t("{place} · your place isn't known yet", { place })
      : place;

  return (
    <section
      aria-label={place ? t("Weather for {place}", { place }) : t("Weather")}
      className={cn(chatCard, chatCardPadding, "flex w-full flex-col gap-3")}
      data-slot="weather-card"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          {place ? (
            <p className={cn(chatCardMeta, "truncate")} data-weather-place>
              {placeLine}
            </p>
          ) : null}
          <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            {weather.temp === null ? null : (
              <span
                className="font-semibold text-3xl tabular-nums leading-none"
                data-weather-now
              >
                {degrees(weather.temp)}
              </span>
            )}
            {today && (today.max !== null || today.min !== null) ? (
              <span
                className="text-muted-foreground text-sm tabular-nums"
                data-weather-today
              >
                {t("High {max} · Low {min}", {
                  max: degrees(today.max),
                  min: degrees(today.min),
                })}
              </span>
            ) : null}
          </p>
        </div>
        {today ? (
          <DayPicture
            className="size-9 shrink-0 text-muted-foreground"
            day={today}
          />
        ) : null}
      </div>
      {days.length > 0 ? (
        <ol
          className={cn(
            "grid gap-1 border-border border-t pt-3",
            COLUMNS[days.length],
          )}
        >
          {days.map((day) => (
            <li
              className="flex min-w-0 flex-col items-center gap-1"
              data-weather-day={day.date}
              key={day.date}
            >
              <span className={chatCardMeta}>{dayLabel(day.date, now)}</span>
              <DayPicture className="size-5 text-foreground/80" day={day} />
              <span className="text-sm tabular-nums">{degrees(day.max)}</span>
              <span className={cn(chatCardMeta, "tabular-nums")}>
                {degrees(day.min)}
              </span>
              {/* The chance, where it is one to plan round. Kept as a row so the columns line up. */}
              <span className="h-4 text-link text-xs tabular-nums">
                {day.chance !== null && day.chance >= CHANCE_SHOWN_FROM
                  ? `${day.chance}%`
                  : ""}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <p className="self-end text-muted-foreground text-xs" data-weather-source>
        {t("Source: {names}", {
          names: t("Korea Meteorological Administration"),
        })}
      </p>
    </section>
  );
}
