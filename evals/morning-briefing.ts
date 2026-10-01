/**
 * 아침 브리핑, run as the routine runs it and judged in code.
 *
 * THE INSTRUCTION IS THE CHIP'S. It is built by the app's own `briefingInstruction` over the app's
 * own Korean dictionary, so the scenario asks exactly what a Bot is asked at 07:30 by a routine the
 * 7:30 chip made — not a paraphrase that could pass while the real one fails.
 *
 * THE PORTAL IS A FIXTURE HERE, unlike `support-programs-only-from-the-portal`. That scenario is
 * about fidelity to what 기업마당 says today, and only the live portal can judge it. This one is about
 * the briefing: that a notice reported last Monday is not reported again, that another region's is
 * left out, that the week's cursor moves, that Tuesday asks nothing — and each of those needs a
 * notice planted on purpose, dated against the Monday the run pretends to be. The rows keep the
 * portal's real shape (`public-data-rest.ts`, `searchPrograms`).
 *
 * THE NOTEPAD IS THE PRODUCT'S. `routine_note` is answered by the server's own draft
 * (`routines/notepad.ts`), with its checks and its refusal codes — a watermark written without a zone
 * is refused here exactly as it would be at 07:30 — and the judge reads what that draft would settle.
 *
 * THE JUDGE IS PURE (`judgeMondayBriefing`, `judgeTuesdayBriefing`), so
 * `tests/eval-morning-briefing.test.ts` can hand it a padded, a repeated and an invented briefing and
 * watch each one fail.
 */
import {
  briefingInstruction,
  briefingSections,
  type Translate,
} from "../app/src/lib/agents/morning-briefing";
import { ko } from "../app/src/lib/i18n-ko";
import { toolNameFor } from "../server/src/plugins/store";
import {
  draftOf,
  type NotepadDraft,
  type StoredNote,
} from "../server/src/routines/notepad";
import type { ObservedCall, StreamEvent } from "./lib";
import {
  bizinfoLinksIn,
  MAX_SEARCHES,
  namesAReturnedTitle,
  programmeNamesIn,
  rowsReturned,
  SUPPORT_SEARCH,
  squash,
} from "./support-programs";

/** The app's `t()` in Korean: the words the chip stores as the routine's instruction. */
export const korean: Translate = (source, params) => {
  let text = ko[source] ?? source;
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
};

/** A Bot holding 기업마당 with nothing connected: what a new account's chip makes. */
export const NOTHING_CONNECTED_INSTRUCTION = briefingInstruction(
  briefingSections({ sites: [], accounts: [] }, { supportPrograms: true }),
  korean,
);

/** The same Bot with Gmail connected. */
export const GMAIL_INSTRUCTION = briefingInstruction(
  briefingSections(
    {
      sites: [],
      accounts: [
        { kind: "oauth", id: "gmail", status: "connected", title: "Gmail" },
      ],
    },
    { supportPrograms: true },
  ),
  korean,
);

/** Gmail's search, as the wire names it once `agent-bot` unwraps a `tool_call`. */
export const GMAIL_SEARCH = toolNameFor("gmail/search_messages");

/** The notepad key the skill names for the week's cursor. */
export const SUPPORT_KEY = "support_programs";

/** `YYYY-MM-DD`, `days` after `date`. Calendar arithmetic, no zone involved. */
export function dayAfter(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

type Notice = {
  /**
   * The words that make this notice this notice, however a Bot shortens its title. Not a portal
   * field: the judge's, and taken off the rows the Bot is shown.
   */
  core: string;
  id: string;
  title: string;
  agency: string;
  executor: string;
  field: string;
  period: string;
  target: string;
  postedAt: string;
  summary: string;
  url: string;
};

const notice = (number: number, fields: Omit<Notice, "id" | "url">): Notice => {
  const id = `PBLN_000000000${number}`;
  return {
    id,
    ...fields,
    url: `https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=${id}`,
  };
};

/**
 * The week the Monday run finds, for a shop in 서울 마포구.
 *
 * `reported` went out last Monday, and last Monday's run left the cursor on its `postedAt`. `fresh`
 * are two posted since, one of them the district's own. `elsewhere` is newer than both and is 부산's.
 */
export function briefingWeek(monday: string) {
  const reported = notice(126100, {
    core: "경영환경개선",
    title: "[서울] 2026년 서울시 소상공인 경영환경개선 지원사업 2차 모집 공고",
    agency: "서울특별시",
    executor: "서울신용보증재단",
    field: "경영",
    period: `${dayAfter(monday, -10)} ~ ${dayAfter(monday, 11)}`,
    target: "소상공인",
    postedAt: `${dayAfter(monday, -10)} 10:00:00`,
    summary: "노후 점포의 시설 개선비를 업체당 최대 200만원까지 지원합니다.",
  });
  const district = notice(126700, {
    core: "온라인 판로",
    title: "[서울] 마포구 소상공인 온라인 판로 지원사업 참여 업체 모집",
    agency: "서울특별시 마포구",
    executor: "마포구청",
    field: "내수",
    period: `${dayAfter(monday, -3)} ~ ${dayAfter(monday, 14)}`,
    target: "마포구 소재 소상공인",
    postedAt: `${dayAfter(monday, -3)} 14:20:05`,
    summary:
      "온라인 상세페이지 제작과 쇼핑몰 입점을 돕습니다. 업체당 최대 150만원.",
  });
  const national = notice(126750, {
    core: "스마트상점",
    title: "2026년 하반기 소상공인 스마트상점 기술보급사업 참여자 모집 공고",
    agency: "중소벤처기업부",
    executor: "소상공인시장진흥공단",
    field: "경영",
    period: `${dayAfter(monday, -2)} ~ ${dayAfter(monday, 20)}`,
    target: "소상공인",
    postedAt: `${dayAfter(monday, -2)} 09:00:00`,
    summary: "키오스크·서빙로봇 같은 스마트 기술 도입 비용을 지원합니다.",
  });
  const elsewhere = notice(126800, {
    core: "특례보증",
    title: "[부산] 2026년 부산광역시 소상공인 특례보증 지원 공고",
    agency: "부산광역시",
    executor: "부산신용보증재단",
    field: "금융",
    period: "예산 소진시까지",
    target: "부산 소재 소상공인",
    postedAt: `${dayAfter(monday, -1)} 11:00:00`,
    summary: "부산 소상공인에게 특례보증을 지원합니다.",
  });
  return {
    reported,
    fresh: [district, national],
    elsewhere,
    // Newest first, the way the portal lists them.
    rows: [elsewhere, national, district, reported],
    /** Where last Monday's run left the cursor: the newest `postedAt` it had seen, with its zone. */
    cursor: `${reported.postedAt.replace(" ", "T")}+09:00`,
  };
}

/**
 * One scenario's 기업마당, Gmail and notepad: every search answered with the week, every
 * `routine_note` applied to the server's own draft, and both kept for the judge. `reset` before each
 * attempt.
 */
export function briefingBackend(monday: string, runAt: () => Date) {
  const week = briefingWeek(monday);
  const seeded: StoredNote = {
    key: SUPPORT_KEY,
    kind: "watermark",
    lastAt: week.cursor,
    at: `${dayAfter(monday, -7)}T07:31:12.000Z`,
  };
  const fresh = (): NotepadDraft =>
    draftOf(
      "routine_eval",
      { entries: [seeded], version: 1, updatedAt: null },
      runAt,
    );
  const returned: string[] = [];
  let draft = fresh();
  return {
    week,
    /** The notepad as the run reads it, for the prompt. */
    seeded: [
      { key: SUPPORT_KEY, kind: "watermark" as const, lastAt: week.cursor },
    ],
    returned,
    reset() {
      returned.length = 0;
      draft = fresh();
    },
    /** The notepad this attempt would leave behind if its run settled. */
    notepad: () => draft.entries(),
    answer(call: ObservedCall): string | undefined {
      if (call.name === SUPPORT_SEARCH) {
        const text = JSON.stringify({
          source: "기업마당",
          filters: call.arguments ?? {},
          totalCount: week.rows.length,
          shown: week.rows.length,
          rows: week.rows.map(({ core: _core, ...row }) => row),
        });
        returned.push(text);
        // As a routine's plugin call comes back (`runner/unattended.ts`): the server's text, wrapped.
        return JSON.stringify({ ok: true, text });
      }
      if (call.name === "routine_note") {
        return JSON.stringify(draft.apply(call.arguments ?? {}));
      }
      // An inbox with nothing unread in it: Gmail's own empty answer (`gmail-rest.ts`).
      if (call.name === GMAIL_SEARCH) {
        return JSON.stringify({ ok: true, text: "" });
      }
      return undefined;
    },
  };
}

/** "9월 28일 (월)", the way the skill heads a briefing. */
function heading(date: string, weekday: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `**${month}월 ${day}일 (${weekday}) 아침 브리핑**`;
}

/**
 * The briefing the morning before delivered, which a run is handed after its instruction
 * (`carriedInstruction`, `routines/run.ts`). Monday's names a notice, so Tuesday's run has one in
 * front of it to repeat — which it must not.
 */
export function previousBriefing(
  monday: string,
  day: "monday" | "tuesday",
): string {
  if (day === "monday") {
    return [
      heading(dayAfter(monday, -1), "일"),
      "**날씨** 서울 마포구 19.5° 맑음, 최저 15° / 최고 23°",
    ].join("\n");
  }
  const { fresh } = briefingWeek(monday);
  const [district] = fresh;
  return [
    heading(monday, "월"),
    "**날씨** 서울 마포구 20.1° 흐림, 최저 17° / 최고 24°",
    "**새 지원사업**",
    `- ${district?.title} · 마감 ${dayAfter(monday, 14)} · ${district?.url}`,
    "특이사항 없음: 메일",
  ].join("\n");
}

/**
 * What a routine delivers: the Bot's last message, not the narration before its tools — the same
 * choice `runUnattended` makes. The pack's `turnText` joins every round, which is right for a chat
 * and would count "날씨부터 볼게요" as a line of the briefing.
 */
export function lastAnswerOf(events: readonly StreamEvent[]): string {
  const byMessage = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "TEXT_MESSAGE_CONTENT") continue;
    const id = event.messageId ?? "";
    byMessage.set(id, (byMessage.get(id) ?? "") + (event.delta ?? ""));
  }
  return [...byMessage.values()].filter((text) => text.trim()).at(-1) ?? "";
}

/* ── The judge ──────────────────────────────────────────────────────────────────────────────── */

/** "About ten lines" (the brief), with the heading line and one line of slack. */
export const MAX_BRIEFING_LINES = 12;

const linesOf = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** What every briefing is held to, whichever day. */
function shape(input: {
  text: string;
  weather: string;
  place: string;
  /** Words of the sections this routine was not asked for. */
  notAsked: RegExp;
}): Array<[string, boolean]> {
  const count = linesOf(input.text).length;
  const stray = input.notAsked.exec(input.text)?.[0];
  return [
    ["답이 비어 있음", input.text.trim().length > 0],
    [
      "[SILENT]로 답함 — 브리핑은 날씨만 있어도 간다",
      !input.text.includes("[SILENT]"),
    ],
    [
      `${count}줄 — 열 줄 남짓(${MAX_BRIEFING_LINES})을 넘음`,
      count <= MAX_BRIEFING_LINES,
    ],
    [
      `날씨를 기상청이 준 그대로(${input.weather}) 옮기지 않음`,
      input.text.includes(input.weather),
    ],
    [
      `어느 곳 날씨인지(${input.place}) 말하지 않음`,
      input.text.includes(input.place),
    ],
    [`지시에 없는 항목을 씀: "${stray ?? ""}"`, stray === undefined],
  ];
}

/**
 * Monday: 지원사업 is searched, only this week's notices for this shop's region are named, and the
 * cursor moves past what was seen.
 */
export function judgeMondayBriefing(input: {
  text: string;
  calls: readonly ObservedCall[];
  returned: readonly string[];
  notepad: readonly StoredNote[];
  week: ReturnType<typeof briefingWeek>;
  weather: string;
  place: string;
}): Array<[string, boolean]> {
  const rows = rowsReturned(input.returned);
  const titles = rows.map((row) => row.title);
  const urls = new Set(rows.map((row) => row.url));
  const invented = programmeNamesIn(input.text).filter(
    (name) => !namesAReturnedTitle(name, titles),
  );
  const said = squash(input.text);
  // Named as a list item or in passing, shortened or not: its core words are there either way.
  const named = (notice: Notice) => said.includes(squash(notice.core));
  const strangeLinks = bizinfoLinksIn(input.text).filter(
    (link) => !urls.has(link),
  );
  const searches = input.calls.filter(
    (call) => call.name === SUPPORT_SEARCH,
  ).length;
  const cursor = input.notepad.find((entry) => entry.key === SUPPORT_KEY);
  const movedTo =
    cursor?.kind === "watermark" && cursor.lastAt ? cursor.lastAt : "";
  const moved =
    movedTo !== "" &&
    new Date(movedTo).getTime() > new Date(input.week.cursor).getTime();

  return [
    ...shape({
      text: input.text,
      weather: input.weather,
      place: input.place,
      notAsked: /일정|메일|주문|리뷰|예약/,
    }),
    ["월요일인데 기업마당을 찾지 않음", searches > 0],
    [
      `기업마당을 ${searches}번 부름 — 네 번이면 한 일에 충분하다`,
      searches <= MAX_SEARCHES,
    ],
    ["이번 주 새 공고를 하나도 알리지 않음", input.week.fresh.some(named)],
    [
      `지난주에 알린 공고를 또 알림: ${input.week.reported.title}`,
      !named(input.week.reported),
    ],
    [
      `다른 지역 공고를 알림: ${input.week.elsewhere.title}`,
      !named(input.week.elsewhere) && !input.text.includes("부산"),
    ],
    [`도구 결과에 없는 사업명: ${invented.join(" / ")}`, invented.length === 0],
    [
      `도구 결과에 없는 링크: ${strangeLinks.join(" / ")}`,
      strangeLinks.length === 0,
    ],
    [
      `메모장의 ${SUPPORT_KEY} 기준점을 옮기지 않음${movedTo ? ` (${movedTo})` : ""}`,
      moved,
    ],
  ];
}

/**
 * Tuesday: nothing about 지원사업 at all — not searched, not written, not "없음" — and a mailbox with
 * nothing new gets no heading of its own.
 */
export function judgeTuesdayBriefing(input: {
  text: string;
  calls: readonly ObservedCall[];
  weather: string;
  place: string;
}): Array<[string, boolean]> {
  const padded = linesOf(input.text).filter(
    (line) => line.includes("메일") && !/없|0통|0건/.test(line),
  );
  const support = /지원사업|공고/.exec(input.text)?.[0];
  return [
    ...shape({
      text: input.text,
      weather: input.weather,
      place: input.place,
      notAsked: /일정|주문|리뷰|예약/,
    }),
    [
      "화요일에 기업마당을 찾음",
      !input.calls.some((call) => call.name === SUPPORT_SEARCH),
    ],
    [`화요일에 지원사업을 씀: "${support ?? ""}"`, support === undefined],
    [
      "메일을 확인하지 않음",
      input.calls.some((call) => call.name === GMAIL_SEARCH),
    ],
    [
      `새 메일이 없는데 메일 항목을 세움: "${padded[0] ?? ""}"`,
      padded.length === 0,
    ],
  ];
}
