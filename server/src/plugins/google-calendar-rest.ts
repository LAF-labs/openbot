import type { McpCallResult, McpTool } from "./mcp";
import {
  asResult,
  countArg,
  failure,
  readJson,
  type RestConnection,
  stringArg,
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
 * somebody else's inbox.
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

export const listNeedsCredential = false;

export async function listTools(_connection: RestConnection): Promise<McpTool[]> {
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

export async function callTool(
  connection: RestConnection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const events = `${connection.url.replace(/\/+$/, "")}/calendars/primary/events`;

  if (toolName === "list_events") {
    const days = countArg(args, "days", 7, 365);
    const now = new Date();
    const until = new Date(now.getTime() + days * 24 * 60 * 60_000);

    const result = await vendorRequest("Google Calendar", connection, {
      url: events,
      query: {
        timeMin: now.toISOString(),
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
    if (!result.ok) return failure(result.message);

    const body = await readJson<{ items?: CalendarEvent[] }>(result.response);
    if (!body) return failure("구글 캘린더가 읽을 수 없는 답을 보냈습니다.");

    return asResult(
      (body.items ?? [])
        .map((event) =>
          [
            `- ${whenOf(event.start)} ~ ${whenOf(event.end)}`,
            event.summary ?? "(제목 없음)",
            event.location ? `장소: ${event.location}` : null,
            event.id ? `id: ${event.id}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        )
        .join("\n"),
    );
  }

  if (toolName === "create_event") {
    const summary = stringArg(args, "summary");
    const start = stringArg(args, "start");
    const end = stringArg(args, "end");
    if (!summary || !start || !end) {
      return failure("제목과 시작·종료 시각이 모두 필요합니다.");
    }

    const attendees = Array.isArray(args.attendees)
      ? args.attendees
          .filter((address): address is string => typeof address === "string")
          .map((email) => ({ email }))
      : [];

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
        ...(stringArg(args, "description")
          ? { description: stringArg(args, "description") }
          : {}),
        ...(stringArg(args, "location")
          ? { location: stringArg(args, "location") }
          : {}),
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
    if (!result.ok) return failure(result.message);

    const created = await readJson<CalendarEvent>(result.response);
    return asResult(
      `일정을 만들었습니다: ${created?.summary ?? summary} (${whenOf(created?.start) })${
        created?.htmlLink ? `\n${created.htmlLink}` : ""
      }`,
    );
  }

  return failure(
    `${toolName} is not a tool this connector implements. The stored tool list is out of date; refresh it on the Plugins page.`,
  );
}
