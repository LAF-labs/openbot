import {
  isKnownTimeZone,
  resolveTimeZone,
  zoneLabel,
} from "../../../shared/prompt/zone";
import type { CallPreview } from "../computer/approvals";
import { dayAfter, instantOf, wallClockAt } from "../routines/zoned-clock";
import {
  previewList,
  previewOf,
  previewText,
  previewValue,
} from "./call-preview";
import type { McpCallResult, McpTool } from "./mcp";
import {
  asResult,
  countArg,
  failure,
  readJson,
  type RestConnection,
  stringArg,
  unknownTool,
  vendorRequest,
} from "./rest-support";

/**
 * Google Calendar over its REST API: what is coming up, and putting something on the calendar.
 *
 * `primary` throughout rather than a calendar id the model chooses. A person has one calendar they
 * mean when they say "내 일정", and every other one on the account is somebody else's shared
 * calendar or a subscription — an event created on one of those is a change to something the person
 * asking may not even own. Naming it here keeps that decision in reviewed code rather than in an
 * argument a model fills in.
 *
 * `create_event` is guarded in the catalogue entry as `external`, and that is not over-caution:
 * Google mails every attendee an invitation, so the effect of the call leaves this deployment for
 * somebody else's inbox. The card that asks shows the title, the time and who is invited
 * ({@link previewCall}).
 */

const DEFAULT_EVENTS = 10;
const MAX_EVENTS = 50;

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "list_events",
    description:
      "구글 캘린더에서 앞으로의 일정을 시간 순으로 가져온다. days를 주면 그 기간까지만 본다.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "오늘부터 며칠까지 볼지. 기본 7",
        },
        max: {
          type: "number",
          description: `가져올 개수. 기본 ${DEFAULT_EVENTS}`,
        },
        query: { type: "string", description: "제목에 들어갈 검색어 (선택)" },
      },
    },
    annotations: null,
  },
  {
    name: "create_event",
    description:
      "구글 캘린더에 일정을 만든다. 참석자를 넣으면 구글이 초대 메일을 보내므로 사람이 승인해야 만들어진다. 시간은 '2026-09-04T14:00:00+09:00' 형식으로 준다.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "일정 제목" },
        start: {
          type: "string",
          description: "시작 시각. RFC3339, 예: 2026-09-04T14:00:00+09:00",
        },
        end: { type: "string", description: "끝나는 시각. 같은 형식" },
        description: { type: "string", description: "설명 (선택)" },
        location: { type: "string", description: "장소 (선택)" },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "참석자 이메일 주소들 (선택)",
        },
      },
      required: ["summary", "start", "end"],
    },
    annotations: null,
  },
]);

/**
 * Read as `transport.listNeedsCredential` through this module's namespace in `transport.ts`'s
 * `TRANSPORTS` map, which knip cannot follow.
 *
 * @public
 */
export const listNeedsCredential = false;

export async function listTools(
  _connection: RestConnection,
): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

type CalendarEvent = {
  id?: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  /** `default`, `workingLocation`, `outOfOffice`, `focusTime`, `birthday`, `fromGmail`. */
  eventType?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

/** When an event is, whether it carries a time or is an all-day one. */
const whenOf = (edge: CalendarEvent["start"]): string =>
  edge?.dateTime ?? edge?.date ?? "?";

const two = (n: number) => String(n).padStart(2, "0");

/** The day an instant falls on by the person's own clock: `2026-10-05`. */
function localDate(at: Date, timeZone: string): string {
  const clock = wallClockAt(at, timeZone);
  return `${clock.year}-${two(clock.month)}-${two(clock.day)}`;
}

/** An instant as the person's own clock reads it: `2026-10-05 21:00`. */
function localStamp(at: Date, timeZone: string): string {
  const clock = wallClockAt(at, timeZone);
  return `${localDate(at, timeZone)} ${two(clock.hour)}:${two(clock.minute)}`;
}

/**
 * One edge of an event in a listing, on the person's clock. An all-day event carries a date and no
 * time, and is left as its date: converting it would move it a day in half the world's zones.
 */
function localEdge(edge: CalendarEvent["start"], timeZone: string): string {
  if (edge?.dateTime) {
    const at = new Date(edge.dateTime);
    return Number.isNaN(at.getTime())
      ? edge.dateTime
      : localStamp(at, timeZone);
  }
  return edge?.date ? `${edge.date} (종일)` : "?";
}

/** An event as one line of a listing: when, what, where, and the id a later call names it by. */
function eventLine(event: CalendarEvent, timeZone: string): string {
  return [
    `- ${localEdge(event.start, timeZone)} ~ ${localEdge(event.end, timeZone)}`,
    event.summary ?? "(제목 없음)",
    event.location ? `장소: ${event.location}` : null,
    event.id ? `id: ${event.id}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * When an event starts — or null where its start cannot be read.
 *
 * AN ALL-DAY EVENT CARRIES A DATE AND NO ZONE, AND GOOGLE BEGINS THAT DATE IN THE CALENDAR'S OWN
 * ZONE: "The calendar time zone is used to calculate start and end times of all-day events to
 * determine whether they fall within the filter specification" (its guide, Calendars & events,
 * Time zones). `allDayZone` is that zone, read off the answer itself ({@link allDayZoneOf}). So an
 * all-day event is placed before or after a stretch's end exactly where Google's own filter
 * placed it, and a stretch with something on it reads to the byte as it did before the request
 * was widened — whatever zone the calendar is kept in.
 *
 * THE FIRST VERSION OF THIS BEGAN THE DATE WHERE THE PERSON IS, and said of Google's rule that it
 * was written nowhere: one page had been read, the reference for `events.list`, which is silent,
 * and not the guide. With a device in New York and a calendar kept in Seoul, tomorrow's all-day
 * event — on today by Google's filter, and listed so before — was set aside as "after", and the
 * day read `일정 2건` where it had read 3 (2026-10-07, found by the second read of that change).
 *
 * STILL NOT MEASURED: no Google account was at hand, so that the filter runs as that sentence
 * says, and that every answer carries `timeZone`, are the documentation's word.
 */
function startOf(event: CalendarEvent, allDayZone: string): Date | null {
  const edge = event.start;
  if (edge?.dateTime) {
    const at = new Date(edge.dateTime);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  const date = datePartsOf(edge?.date);
  return date ? instantOf(date, 0, 0, allDayZone) : null;
}

/** `2026-10-06` as a year, a month and a day — or null where it is not a date written that way. */
function datePartsOf(
  date: string | undefined,
): { year: number; month: number; day: number } | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  return parts
    ? {
        year: Number(parts[1]),
        month: Number(parts[2]),
        day: Number(parts[3]),
      }
    : null;
}

/**
 * The zone an all-day event's date begins in: the calendar's, which an `events.list` answer
 * carries as `timeZone` ("The time zone of the calendar. Read-only."). Where an answer names
 * none, or one this runtime does not know, the person's stands in — it is the same zone for
 * nearly everybody.
 *
 * THE REQUEST MUST NOT ASK FOR A `timeZone` OF ITS OWN ("Time zone used in the response") without
 * this being looked at again: the answer's field may then be the request's, and what is read here
 * as the calendar's zone would be whatever was asked for.
 */
function allDayZoneOf(answered: unknown, personZone: string): string {
  return typeof answered === "string" && isKnownTimeZone(answered)
    ? answered
    : personZone;
}

/** How far past the stretch it was asked for a listing also looks, in the person's own days. */
const AHEAD_DAYS = 7;

/**
 * The same reading of the person's clock, `days` of their days on: a local midnight stays a local
 * midnight. Calendar days rather than 24 hours each, for the reason {@link listingWindow} gives — a
 * day a clock change made 23 or 25 hours long is one day.
 */
function daysOn(at: Date, days: number, timeZone: string): Date {
  const clock = wallClockAt(at, timeZone);
  const on = instantOf(
    dayAfter(at, days, timeZone),
    clock.hour,
    clock.minute,
    timeZone,
  );
  // The clock above reads to the minute; "from this minute on" ends on a second, and keeps it.
  return new Date(on.getTime() + (at.getTime() % 60_000));
}

/**
 * The stretch of time a listing covers.
 *
 * TWO QUESTIONS, AND ONLY ONE OF THEM IS IN THE TOOL'S DEFINITION. `days` is "what is coming": from
 * this minute on, as the schema says. `day: "today"` is "what is on today": the whole local day,
 * midnight to midnight in the person's zone, what has already happened included. Until 2026-10-05
 * there was only the first, and "오늘 일정" asked at nine in the evening came back without the
 * morning and with tomorrow's morning in it — an empty evening read as a day with nothing on it.
 *
 * `day` IS NOT ADVERTISED, ON PURPOSE. It is read here and declared nowhere: the one caller that
 * sends it is the server's own first move (`turns/first-move.ts`), and a Bot's model, which is
 * shown the schema above, cannot ask for it yet. When this was written, declaring it would have
 * paused the calendar for every person who already had it connected: a changed definition waited
 * for a review. Since 2026-10-06 a definition that ships with the build is taken as it comes
 * (`servers.ts`), so that cost is gone — and what is left is the other half of the reason:
 * offering `day` to the Bot changes what its model is told, which is measured first and done on
 * purpose (the hashes are pinned in `plugin-rest-adapters.test.ts`). The call path does not hold
 * an argument to the stored schema beyond `required` and `enum` (`call.ts`, `argumentOffSchema`),
 * so the undeclared one arrives.
 *
 * Only `"today"` is a day. Any other value is not one this reads, and the listing is `days`' as it
 * would have been without it — the first line of the answer says which stretch that was.
 */
export function listingWindow(
  args: Record<string, unknown>,
  now: Date,
  timeZone: string,
): { from: Date; until: Date } {
  if (stringArg(args, "day")?.toLowerCase() !== "today") {
    const days = countArg(args, "days", 7, 365);
    return { from: now, until: new Date(now.getTime() + days * 86_400_000) };
  }
  const from = instantOf(dayAfter(now, 0, timeZone), 0, 0, timeZone);
  // Tomorrow's own midnight, not 24 hours on: a day a clock change made 23 hours long is one day.
  return { from, until: instantOf(dayAfter(now, 1, timeZone), 0, 0, timeZone) };
}

/**
 * An invitation's arguments, read once for both the request and the card that asks about it.
 *
 * One reading so the two cannot disagree: the guests a person is shown are the guests Google is
 * told to mail. Only strings are guests, and a blank one is nobody.
 */
function eventOf(args: Record<string, unknown>) {
  return {
    summary: stringArg(args, "summary"),
    start: stringArg(args, "start"),
    end: stringArg(args, "end"),
    description: stringArg(args, "description"),
    location: stringArg(args, "location"),
    attendees: Array.isArray(args.attendees)
      ? args.attendees
          .filter((address): address is string => typeof address === "string")
          .map((address) => address.trim())
          .filter((address) => address !== "")
      : [],
  };
}

/** What an invitation would be, for the card. A listing sends nothing. */
export function previewCall(
  toolName: string,
  args: Record<string, unknown>,
): CallPreview | null {
  if (toolName !== "create_event") return null;
  const event = eventOf(args);
  return previewOf([
    ...previewValue("title", event.summary),
    ...previewValue("starts", event.start),
    ...previewValue("ends", event.end),
    ...previewList("attendees", event.attendees),
    ...previewValue("location", event.location),
    ...previewText("text", event.description),
  ]);
}

export async function callTool(
  connection: RestConnection,
  toolName: string,
  args: Record<string, unknown>,
  /** The clock, for a test that needs it to be nine in the evening. */
  clock: () => Date = () => new Date(),
): Promise<McpCallResult> {
  const events = `${connection.url.replace(/\/+$/, "")}/calendars/primary/events`;

  if (toolName === "list_events") {
    const timeZone = resolveTimeZone(connection.timeZone);
    const { from, until } = listingWindow(args, clock(), timeZone);
    const query = stringArg(args, "query");
    /*
     * AN EMPTY STRETCH IS ANSWERED WITH WHAT COMES NEXT, AND THE SAME REQUEST FETCHES IT
     * (2026-10-07). Handed "nothing on today" by the server's first move, the fleet's model did
     * not take it in half its runs: it looked the tool up and asked again, up to three times, and
     * only then said the day was empty — 3 to 5 requests where the move had left 1
     * (`docs/laf/eval-pack.md`, "An empty day says what comes next"). Three wordings of "nothing"
     * changed nothing. What did was something to tell: with the nearest day that has anything
     * on it in the result, 25 runs of 29 answered in the one request, and every one of the 25
     * rightly. Where the seven days after are empty too the result says so, which is true and
     * costs nothing — and was NOT shown to do the same: 14 of 24, against 9 of 18 before.
     *
     * ONE REQUEST, WIDENED, NOT A SECOND ONE. This call is the wait between a person's message
     * and the first request of the Bot's model whenever the server made it (`turns/engine.ts`),
     * and that wait is what a first move is held to: its decision is given
     * `FIRST_MOVE_TIMEOUT_MS`, because past that "the wait would be the saving". A second round
     * trip, made on exactly the days with nothing on them, would put a whole request to Google
     * back into it. So Google is asked once, for the stretch and `AHEAD_DAYS` after it, with the
     * same `maxResults` and the same order — the stretch's own events come first in that order, so
     * a stretch with a full page of them reads exactly as it did — and what came back is split
     * here by where each event starts. (The call itself has the thirty seconds every request to
     * a vendor has, `TIMEOUT_MS.rest`. What the wider stretch costs Google in time was not
     * measured: no account was at hand.)
     *
     * NOT UNDER A SEARCH. "No event matches 치과 this week" is a different statement from "the
     * week is empty", and an event that merely comes next answers neither: with `query` the
     * request and the answer are what they were.
     */
    const looksAhead = query === null;
    const maxResults = countArg(args, "max", DEFAULT_EVENTS, MAX_EVENTS);
    const lookedUntil = looksAhead
      ? daysOn(until, AHEAD_DAYS, timeZone)
      : until;

    const result = await vendorRequest("Google Calendar", connection, {
      url: events,
      query: {
        timeMin: from.toISOString(),
        timeMax: lookedUntil.toISOString(),
        maxResults: String(maxResults),
        // Both are needed together: without `singleEvents` a repeating meeting comes back as one
        // rule rather than as the occurrences a person means, and Calendar refuses to order by
        // start time unless it is expanding them.
        singleEvents: "true",
        orderBy: "startTime",
        q: query ?? undefined,
      },
    });
    if (!result.ok) return failure(result.message, result.status);

    const body = await readJson<{
      items?: CalendarEvent[];
      nextPageToken?: string;
      timeZone?: unknown;
    }>(result.response);
    if (!body) return failure("구글 캘린더가 읽을 수 없는 답을 보냈습니다.");
    const allDayZone = allDayZoneOf(body.timeZone, timeZone);

    /*
     * BY ITS START, AS GOOGLE'S OWN `timeMax` IS: an event that starts before the stretch ends is
     * the stretch's — one that began yesterday and is still running is on today — and one that
     * starts at its end or later comes after. AN EVENT WHOSE START CANNOT BE READ STAYS IN THE
     * LISTING: it cannot be shown to come after, and until this change everything Google answered
     * with was listed. Shown with a `?` for its time, never dropped.
     */
    const page = body.items ?? [];
    const items: CalendarEvent[] = [];
    const after: { event: CalendarEvent; startsAt: Date }[] = [];
    for (const event of page) {
      const startsAt = looksAhead ? startOf(event, allDayZone) : null;
      if (startsAt !== null && startsAt.getTime() >= until.getTime()) {
        after.push({ event, startsAt });
      } else {
        items.push(event);
      }
    }
    /*
     * THE FIRST LINE SAYS WHAT WAS LOOKED AT, on the person's clock. A list is only an answer to
     * "오늘 일정" if the reader knows it is today's: a call the server made as a turn's first step
     * (`turns/first-move.ts`) hands the Bot's model a result it did not choose the arguments of,
     * and a listing with nothing in it must read as "nothing between these two times", which is a
     * different sentence from "nothing was found". Times are local for the same reader. It is the
     * stretch that was ASKED for and it counts that stretch's events: the days looked at beyond it
     * are named only where something is said of them, below.
     */
    const covered = `[본 기간: ${localStamp(from, timeZone)} ~ ${localStamp(until, timeZone)} ${zoneLabel(timeZone)} · 일정 ${items.length}건]`;
    if (items.length > 0) {
      // A stretch with something on it says only that: what comes after was not asked for.
      return asResult(
        [covered, ...items.map((event) => eventLine(event, timeZone))].join(
          "\n",
        ),
      );
    }
    const nothing = `${covered}\n이 기간에 캘린더에 잡힌 일정이 없습니다.`;
    if (!looksAhead) return asResult(nothing);

    /*
     * WHAT COMES NEXT IS A DAY, TOLD WHOLE — NOT ONE EVENT OF IT. The first version told the one
     * nearest event under "가장 가까운 일정 1건 — 그날의 전체 일정은 아님". Of the sixteen answers
     * that told it, eight said "내일 … 하나 있어요": the count was said back, the caveat was not,
     * and had that day held three the person would have been told something false (the second
     * read of that change, 2026-10-07). So the model is not handed a fragment of a day: it is
     * handed the nearest day that has anything on it, with everything this answer holds for it
     * and how many that is. "내일은 2건 있어요" is then true, and a move that was wrong — this
     * result under "내일 일정 뭐 있어?" — can be answered from it when that day is tomorrow.
     *
     * WHERE SOMEBODY WORKS IS NOT SOMETHING THEY HAVE ON. Google answers with every type of event
     * unless asked for some ("If unset, returns all event types"), and a working-location marker
     * — 집, 사무실 — is one a day; counted here, the nearest day with anything on it would
     * always be tomorrow. It is left out of what comes next. INSIDE the stretch that was asked
     * for it is listed as it always was: what a day's own listing holds is another change.
     *
     * A DAY IS THE PERSON'S: the date their clock reads when an event with hours starts, and for
     * an all-day event the date it names — which is what its line says, wherever the calendar is
     * kept. The nearest day is the earliest of those.
     */
    const coming = after
      .filter(({ event }) => event.eventType !== "workingLocation")
      .map(({ event, startsAt }) => ({
        event,
        day: event.start?.dateTime
          ? localDate(startsAt, timeZone)
          : (event.start?.date ?? ""),
      }));
    const nearest = coming.reduce<string | null>(
      (earliest, { day }) =>
        earliest === null || day < earliest ? day : earliest,
      null,
    );
    if (nearest === null) {
      /*
       * "NOTHING IN THE DAYS AFTER" ONLY OF AN ANSWER THAT WAS WHOLE. Google may send a page
       * with no event on it and a token for the next one ("or none at all, even if there are
       * more events matching the query" — `maxResults`, in its reference for `events.list`). The
       * days after were not seen then, and the sentence about them is left out rather than
       * guessed.
       */
      return asResult(
        body.nextPageToken
          ? nothing
          : `${nothing}\n그 뒤 ${AHEAD_DAYS}일 안에도 잡힌 일정이 없습니다.`,
      );
    }
    const thatDay = coming.filter(({ day }) => day === nearest);
    /*
     * WHOLE ONLY WHERE IT IS KNOWN TO BE. Not from a page Google cut — a token for the next one,
     * or as many events as were asked for, when another of that day may be the one left off. And
     * not for a day the request stopped partway through: "from this minute on" ends at this
     * minute seven days after the stretch does, so the last day looked at is seen until then and
     * no later — and where the calendar is kept a day's width west of the person (Kiritimati and
     * Pago Pago are twenty-five hours apart), that day's own date begins there after the request
     * has ended, with any all-day event of it. Then it is one event, with no count to say back
     * and the words that the day may hold more.
     */
    const date = datePartsOf(nearest);
    const whole =
      date !== null &&
      !body.nextPageToken &&
      page.length < maxResults &&
      instantOf(
        dayAfter(instantOf(date, 12, 0, timeZone), 1, timeZone),
        0,
        0,
        timeZone,
      ).getTime() <= lookedUntil.getTime() &&
      instantOf(date, 0, 0, allDayZone).getTime() < lookedUntil.getTime();
    const [first] = thatDay;
    if (!whole && first) {
      return asResult(
        `${nothing}\n[그 뒤 ${AHEAD_DAYS}일 안의 가장 가까운 일정 — 그날 일정이 더 있을 수 있음]\n${eventLine(first.event, timeZone)}`,
      );
    }
    return asResult(
      [
        nothing,
        `[그 뒤 ${AHEAD_DAYS}일 안에서 일정이 있는 가장 가까운 날: ${nearest} · 일정 ${thatDay.length}건]`,
        ...thatDay.map(({ event }) => eventLine(event, timeZone)),
      ].join("\n"),
    );
  }

  if (toolName === "create_event") {
    const event = eventOf(args);
    const { summary, start, end, description, location } = event;
    if (!summary || !start || !end) {
      return failure("제목과 시작·종료 시각이 모두 필요합니다.");
    }

    const attendees = event.attendees.map((email) => ({ email }));

    const result = await vendorRequest("Google Calendar", connection, {
      url: events,
      method: "POST",
      query: {
        // Only when there is somebody to tell. `all` on an event with no attendees is a parameter
        // that does nothing; on one with attendees it is the difference between an invitation
        // arriving and a person wondering why nobody came.
        sendUpdates: attendees.length > 0 ? "all" : "none",
      },
      body: {
        summary,
        ...(description ? { description } : {}),
        ...(location ? { location } : {}),
        /*
         * The time zone travels with the time, and it is the offset the caller wrote rather than a
         * zone name we chose. An RFC3339 string carries its own offset, and adding a `timeZone`
         * beside it is how an event lands an hour out on a deployment whose server clock is UTC.
         */
        start: { dateTime: start },
        end: { dateTime: end },
        ...(attendees.length > 0 ? { attendees } : {}),
      },
    });
    if (!result.ok) return failure(result.message, result.status);

    const created = await readJson<CalendarEvent>(result.response);
    return asResult(
      `일정을 만들었습니다: ${created?.summary ?? summary} (${whenOf(created?.start)})${
        created?.htmlLink ? `\n${created.htmlLink}` : ""
      }`,
    );
  }

  return unknownTool(toolName);
}
