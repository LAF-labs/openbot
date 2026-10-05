import { resolveTimeZone, zoneLabel } from "../../../shared/prompt/zone";
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
      "구글 캘린더에서 일정을 시간 순으로 가져온다. day를 주면 그 날 하루(0시~24시) 전부를, 안 주면 지금부터 days일 뒤까지를 본다. 답의 첫 줄이 본 기간이다.",
    inputSchema: {
      type: "object",
      properties: {
        day: {
          type: "string",
          description:
            "하루를 통째로 볼 날: 'today', 'tomorrow' 또는 'YYYY-MM-DD'. 사람의 시간대 기준이고, 이미 지난 일정도 나온다",
        },
        days: {
          type: "number",
          description:
            "며칠을 볼지. day가 없으면 지금부터(기본 7), 있으면 그 날부터(기본 1)",
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
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

/** When an event is, whether it carries a time or is an all-day one. */
const whenOf = (edge: CalendarEvent["start"]): string =>
  edge?.dateTime ?? edge?.date ?? "?";

const two = (n: number) => String(n).padStart(2, "0");

/** An instant as the person's own clock reads it: `2026-10-05 21:00`. */
function localStamp(at: Date, timeZone: string): string {
  const clock = wallClockAt(at, timeZone);
  return `${clock.year}-${two(clock.month)}-${two(clock.day)} ${two(clock.hour)}:${two(clock.minute)}`;
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

/** The fact a `day` that names no day is refused with. */
const DAY_INVALID =
  "day는 'today', 'tomorrow' 또는 'YYYY-MM-DD' 형식의 날짜여야 합니다.";

/**
 * The stretch of time a listing covers.
 *
 * TWO WAYS TO ASK, AND THEY ARE NOT THE SAME QUESTION. `days` alone is "what is coming": from this
 * minute on. `day` is "what is on that day": the whole local day, midnight to midnight in the
 * person's zone, what has already happened included. Until 2026-10-05 there was only the first,
 * and "오늘 일정" asked at nine in the evening came back without the morning and with tomorrow's
 * morning in it — and an empty stretch of evening read as a day with nothing on it.
 *
 * Null for a `day` that is not one, so the call is refused rather than answered for another day.
 */
export function listingWindow(
  args: Record<string, unknown>,
  now: Date,
  timeZone: string,
): { from: Date; until: Date } | null {
  const named = stringArg(args, "day");
  if (!named) {
    const days = countArg(args, "days", 7, 365);
    return { from: now, until: new Date(now.getTime() + days * 86_400_000) };
  }
  const word = named.toLowerCase();
  let first: { year: number; month: number; day: number };
  if (word === "today" || word === "tomorrow") {
    first = dayAfter(now, word === "today" ? 0 : 1, timeZone);
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(named);
    if (!match) return null;
    first = {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    };
    const real = new Date(Date.UTC(first.year, first.month - 1, first.day));
    // 2026-02-31 is not a day; `Date` would quietly answer for the third of March.
    if (
      real.getUTCFullYear() !== first.year ||
      real.getUTCMonth() !== first.month - 1 ||
      real.getUTCDate() !== first.day
    ) {
      return null;
    }
  }
  const days = countArg(args, "days", 1, 365);
  const from = instantOf(first, 0, 0, timeZone);
  // The day after the last one, at its own midnight: a day a clock change made 23 hours is one day.
  const last = dayAfter(
    new Date(from.getTime() + 12 * 3_600_000),
    days,
    timeZone,
  );
  return { from, until: instantOf(last, 0, 0, timeZone) };
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
    const window = listingWindow(args, clock(), timeZone);
    if (!window) return failure(DAY_INVALID);
    const { from, until } = window;

    const result = await vendorRequest("Google Calendar", connection, {
      url: events,
      query: {
        timeMin: from.toISOString(),
        timeMax: until.toISOString(),
        maxResults: String(countArg(args, "max", DEFAULT_EVENTS, MAX_EVENTS)),
        // Both are needed together: without `singleEvents` a repeating meeting comes back as one
        // rule rather than as the occurrences a person means, and Calendar refuses to order by
        // start time unless it is expanding them.
        singleEvents: "true",
        orderBy: "startTime",
        q: stringArg(args, "query") ?? undefined,
      },
    });
    if (!result.ok) return failure(result.message, result.status);

    const body = await readJson<{ items?: CalendarEvent[] }>(result.response);
    if (!body) return failure("구글 캘린더가 읽을 수 없는 답을 보냈습니다.");

    const items = body.items ?? [];
    /*
     * THE FIRST LINE SAYS WHAT WAS LOOKED AT, on the person's clock. A list is only an answer to
     * "오늘 일정" if the reader knows it is today's: a call the server made as a turn's first step
     * (`turns/first-move.ts`) hands the Bot's model a result it did not choose the arguments of,
     * and a listing with nothing in it must read as "nothing between these two times", which is a
     * different sentence from "nothing was found". Times are local for the same reader.
     */
    const covered = `[본 기간: ${localStamp(from, timeZone)} ~ ${localStamp(until, timeZone)} ${zoneLabel(timeZone)} · 일정 ${items.length}건]`;
    if (items.length === 0) {
      return asResult(`${covered}\n이 기간에 캘린더에 잡힌 일정이 없습니다.`);
    }
    return asResult(
      [
        covered,
        ...items.map((event) =>
          [
            `- ${localEdge(event.start, timeZone)} ~ ${localEdge(event.end, timeZone)}`,
            event.summary ?? "(제목 없음)",
            event.location ? `장소: ${event.location}` : null,
            event.id ? `id: ${event.id}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
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
